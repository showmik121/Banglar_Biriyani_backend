/**
 * "Sign in with Google": checks the ID token the browser got from Google.
 *
 * The token is a signed JWT (RS256). We verify the signature with Google's published public
 * keys and check who it was issued for (our own GOOGLE_CLIENT_ID), who issued it, that it has
 * not expired and that Google confirmed the email address. No Google secret is needed here:
 * GOOGLE_CLIENT_ID is public, it only says which Google "app" this shop is.
 */

export interface GoogleProfile {
  /** Google's permanent id for this person. Never changes, unlike the email. */
  sub: string
  email: string
  name: string | null
}

const CERTS_URL = "https://www.googleapis.com/oauth2/v3/certs"
const KEY_LIFETIME_MS = 60 * 60 * 1000 // keep Google's keys for an hour
const MIN_REFETCH_MS = 60 * 1000 // an unknown key id never triggers more than one download a minute
const CLOCK_SKEW_MS = 60 * 1000
const MAX_TOKEN_CHARS = 4096
const ISSUERS = new Set(["accounts.google.com", "https://accounts.google.com"])

type GoogleKey = { kid: string; kty: string; n: string; e: string }
let cache: { keys: GoogleKey[]; fetchedAt: number } | null = null
const importedKeys = new Map<string, Promise<Awaited<ReturnType<typeof crypto.subtle.importKey>>>>()

/** For tests. */
export function resetGoogleKeyCache() {
  cache = null
  importedKeys.clear()
}

const fromB64url = (text: string): Uint8Array => {
  const padded = text.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (text.length % 4)) % 4)
  return Uint8Array.from(atob(padded), (ch) => ch.charCodeAt(0))
}
const decodeJson = (part: string): Record<string, unknown> | null => {
  try {
    const value = JSON.parse(new TextDecoder().decode(fromB64url(part)))
    return value && typeof value === "object" ? (value as Record<string, unknown>) : null
  } catch {
    return null
  }
}

async function loadKeys(nowMs: number): Promise<GoogleKey[]> {
  try {
    const res = await fetch(CERTS_URL, { signal: AbortSignal.timeout(8000) })
    if (!res.ok) return cache?.keys ?? []
    const body = (await res.json()) as { keys?: GoogleKey[] }
    const keys = Array.isArray(body.keys) ? body.keys.filter((k) => k && k.kty === "RSA" && k.kid && k.n && k.e) : []
    if (keys.length > 0) cache = { keys, fetchedAt: nowMs }
    return cache?.keys ?? []
  } catch (err) {
    console.error("[google] could not download Google's keys:", err instanceof Error ? err.message : err)
    return cache?.keys ?? []
  }
}

async function findKey(kid: string, nowMs: number): Promise<GoogleKey | null> {
  if (!cache || nowMs - cache.fetchedAt > KEY_LIFETIME_MS) await loadKeys(nowMs)
  let key = cache?.keys.find((k) => k.kid === kid)
  // Google rotates keys: an unknown id may just mean we hold an old copy
  if (!key && cache && nowMs - cache.fetchedAt > MIN_REFETCH_MS) {
    await loadKeys(nowMs)
    key = cache?.keys.find((k) => k.kid === kid)
  }
  return key ?? null
}

/** Returns who signed in, or null when the token is not valid for this shop. Never throws. */
export async function verifyGoogleIdToken(
  token: string,
  clientId: string,
  nowMs: number = Date.now(),
): Promise<GoogleProfile | null> {
  try {
    if (typeof token !== "string" || token.length > MAX_TOKEN_CHARS || !clientId) return null
    const parts = token.split(".")
    if (parts.length !== 3) return null
    const [h, p, s] = parts
    const header = decodeJson(h)
    const claims = decodeJson(p)
    if (!header || !claims || header.alg !== "RS256" || typeof header.kid !== "string") return null

    const jwk = await findKey(header.kid, nowMs)
    if (!jwk) return null
    let key = importedKeys.get(jwk.kid + jwk.n)
    if (!key) {
      key = crypto.subtle.importKey(
        "jwk",
        { kty: "RSA", n: jwk.n, e: jwk.e, alg: "RS256", ext: true },
        { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
        false,
        ["verify"],
      )
      importedKeys.set(jwk.kid + jwk.n, key)
    }
    const valid = await crypto.subtle.verify(
      "RSASSA-PKCS1-v1_5",
      await key,
      fromB64url(s),
      new TextEncoder().encode(`${h}.${p}`),
    )
    if (!valid) return null

    if (typeof claims.iss !== "string" || !ISSUERS.has(claims.iss)) return null
    if (claims.aud !== clientId) return null
    if (typeof claims.exp !== "number" || claims.exp * 1000 + CLOCK_SKEW_MS < nowMs) return null
    if (typeof claims.iat === "number" && claims.iat * 1000 - CLOCK_SKEW_MS > nowMs) return null
    if (typeof claims.sub !== "string" || claims.sub.length === 0 || claims.sub.length > 255) return null
    if (typeof claims.email !== "string" || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(claims.email)) return null
    if (claims.email_verified !== true && claims.email_verified !== "true") return null

    const name = typeof claims.name === "string" ? claims.name.trim().slice(0, 100) : ""
    return { sub: claims.sub, email: claims.email.trim().toLowerCase(), name: name || null }
  } catch {
    return null
  }
}
