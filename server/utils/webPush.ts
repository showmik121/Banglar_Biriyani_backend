/**
 * Phone push notifications for the restaurant (standard Web Push with VAPID keys).
 *
 * No Firebase project is needed: Chrome on Android sends these through Google's push service
 * (FCM) by itself. The server only sends an empty "ping"; the service worker on the phone
 * (frontend/public/push-sw.js) shows a fixed "new order" notification. No order details ever
 * travel through the push service.
 *
 * Settings (Supabase → Edge Functions → Secrets, or .env when running locally). Run
 * make-push-keys.bat once to create them:
 *   VAPID_PUBLIC_KEY   public key (also given to the browser)
 *   VAPID_PRIVATE_KEY  private key (secret)
 *   VAPID_SUBJECT      optional: mailto: or https: address; defaults to SITE_URL
 *
 * Without the keys everything here is skipped quietly. A failed push never fails an order.
 */

export type PushResult = "ok" | "gone" | "error" | "skipped"

/** Push services browsers use. The server only ever contacts these hosts. */
const PUSH_HOSTS = [
  "fcm.googleapis.com", // Chrome, Edge, Brave, Samsung Internet on Android
  "updates.push.services.mozilla.com", // Firefox
  ".push.services.mozilla.com",
  ".push.apple.com", // Safari / iPhone home-screen app
  ".notify.windows.com", // Edge on Windows
]

/** True only for an https address on a real push service (stops the server being used to call other sites). */
export function isPushEndpoint(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 1000) return false
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return false
  }
  if (url.protocol !== "https:" || url.username || url.password || url.port) return false
  const host = url.hostname.toLowerCase()
  return PUSH_HOSTS.some((h) => (h.startsWith(".") ? host.endsWith(h) : host === h))
}

export const b64url = (bytes: Uint8Array | ArrayBuffer): string => {
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
  let s = ""
  for (const b of arr) s += String.fromCharCode(b)
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}
export const fromB64url = (text: string): Uint8Array => {
  const padded = text.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (text.length % 4)) % 4)
  return Uint8Array.from(atob(padded), (ch) => ch.charCodeAt(0))
}
const textB64url = (text: string) => b64url(new TextEncoder().encode(text))

export interface VapidKeys {
  publicKey: string
  privateKey: string
  subject: string
}

export function getVapidKeys(): VapidKeys | null {
  const publicKey = process.env.VAPID_PUBLIC_KEY?.trim()
  const privateKey = process.env.VAPID_PRIVATE_KEY?.trim()
  if (!publicKey || !privateKey) return null
  const subject = process.env.VAPID_SUBJECT?.trim() || process.env.SITE_URL?.trim() || "https://banglarbiriyani.netlify.app"
  return { publicKey, privateKey, subject }
}

type SigningKey = Awaited<ReturnType<typeof crypto.subtle.importKey>>
const signingKeys = new Map<string, Promise<SigningKey>>()
function importSigningKey(keys: VapidKeys): Promise<SigningKey> {
  const id = `${keys.publicKey}.${keys.privateKey}`
  let key = signingKeys.get(id)
  if (!key) {
    const pub = fromB64url(keys.publicKey)
    if (pub.length !== 65 || pub[0] !== 4) throw new Error("VAPID_PUBLIC_KEY must be an uncompressed P-256 key")
    key = crypto.subtle.importKey(
      "jwk",
      {
        kty: "EC",
        crv: "P-256",
        x: b64url(pub.slice(1, 33)),
        y: b64url(pub.slice(33, 65)),
        d: keys.privateKey,
        ext: true,
      },
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["sign"],
    )
    signingKeys.set(id, key)
  }
  return key
}

/** The Authorization header value that proves to the push service that this server may send. */
export async function createVapidAuthorization(
  endpoint: string,
  keys: VapidKeys,
  nowMs: number = Date.now(),
): Promise<string> {
  const claims = {
    aud: new URL(endpoint).origin,
    exp: Math.floor(nowMs / 1000) + 12 * 60 * 60, // push services accept at most 24 hours
    sub: keys.subject,
  }
  const unsigned = `${textB64url(JSON.stringify({ typ: "JWT", alg: "ES256" }))}.${textB64url(JSON.stringify(claims))}`
  const signature = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    await importSigningKey(keys),
    new TextEncoder().encode(unsigned),
  )
  return `vapid t=${unsigned}.${b64url(signature)}, k=${keys.publicKey}`
}

type CryptoKeyObject = Awaited<ReturnType<typeof crypto.subtle.importKey>>
export interface EcKeyPair {
  publicKey: CryptoKeyObject
  privateKey: CryptoKeyObject
}
type RequestBody = NonNullable<NonNullable<Parameters<typeof fetch>[1]>["body"]>

export interface PushTarget {
  endpoint: string
  /** The phone's public key and secret from its subscription (needed to encrypt a message for it) */
  p256dh?: string
  auth?: string
}

const concat = (...parts: Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let at = 0
  for (const p of parts) {
    out.set(p, at)
    at += p.length
  }
  return out
}

async function hkdf(salt: Uint8Array, secret: Uint8Array, info: Uint8Array, bytes: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", secret, "HKDF", false, ["deriveBits"])
  const bits = await crypto.subtle.deriveBits(
    { name: "HKDF", hash: "SHA-256", salt: salt, info: info },
    key,
    bytes * 8,
  )
  return new Uint8Array(bits)
}

/**
 * Encrypts a message so only one phone can read it (RFC 8291, "aes128gcm"). The push service
 * in between (Google, Mozilla, Apple) only ever sees scrambled bytes. salt and the one-time
 * key pair are random; tests pass fixed ones.
 */
export async function encryptPushPayload(
  message: string,
  p256dh: string,
  auth: string,
  fixed?: { salt?: Uint8Array; keyPair?: EcKeyPair },
): Promise<Uint8Array> {
  const uaPublic = fromB64url(p256dh)
  const authSecret = fromB64url(auth)
  if (uaPublic.length !== 65 || uaPublic[0] !== 4 || authSecret.length !== 16) {
    throw new Error("Invalid push subscription keys")
  }
  const keyPair =
    fixed?.keyPair ?? ((await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"])) as unknown as EcKeyPair)
  const asPublic = new Uint8Array(await crypto.subtle.exportKey("raw", keyPair.publicKey))
  const uaKey = await crypto.subtle.importKey("raw", uaPublic, { name: "ECDH", namedCurve: "P-256" }, false, [])
  const ecdh = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: uaKey }, keyPair.privateKey, 256))

  const enc = new TextEncoder()
  const salt = fixed?.salt ?? crypto.getRandomValues(new Uint8Array(16))
  const ikm = await hkdf(authSecret, ecdh, concat(enc.encode("WebPush: info\0"), uaPublic, asPublic), 32)
  const cek = await hkdf(salt, ikm, enc.encode("Content-Encoding: aes128gcm\0"), 16)
  const nonce = await hkdf(salt, ikm, enc.encode("Content-Encoding: nonce\0"), 12)

  // One record: the message, then 0x02 marking it as the last record
  const record = concat(enc.encode(message), new Uint8Array([2]))
  if (record.length > 4096 - 17) throw new Error("Push message is too long")
  const aes = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["encrypt"])
  const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, aes, record))

  const header = concat(salt, new Uint8Array([0, 0, 16, 0]), new Uint8Array([asPublic.length]), asPublic)
  return concat(header, cipher)
}

/**
 * Sends one push to one phone/browser. With a message (and the phone's keys) the message is
 * encrypted and shown by the service worker; without one it is an empty "ping".
 */
export async function sendPush(
  target: PushTarget,
  message: string | null = null,
  keys: VapidKeys | null = getVapidKeys(),
): Promise<PushResult> {
  const { endpoint } = target
  if (!keys || !isPushEndpoint(endpoint)) return "skipped"
  try {
    const headers: Record<string, string> = {
      Authorization: await createVapidAuthorization(endpoint, keys),
      TTL: "14400", // if the phone is off, still deliver it within 4 hours
      Urgency: "high",
    }
    let body: Uint8Array | undefined
    if (message !== null) {
      if (!target.p256dh || !target.auth) return "skipped"
      body = await encryptPushPayload(message, target.p256dh, target.auth)
      headers["Content-Encoding"] = "aes128gcm"
      headers["Content-Type"] = "application/octet-stream"
    }
    const res = await fetch(endpoint, {
      method: "POST",
      headers,
      body: body as unknown as RequestBody,
      signal: AbortSignal.timeout(8000),
    })
    if (res.ok) return "ok"
    // The browser removed or expired this subscription: forget it
    if (res.status === 404 || res.status === 410) return "gone"
    console.error(`[push] push service answered ${res.status}`)
    return "error"
  } catch (err) {
    console.error("[push] send failed:", err instanceof Error ? err.message : err)
    return "error"
  }
}

/** Sends one empty push ("ping") to one phone/browser. */
export function sendPushPing(endpoint: string, keys: VapidKeys | null = getVapidKeys()): Promise<PushResult> {
  return sendPush({ endpoint }, null, keys)
}
