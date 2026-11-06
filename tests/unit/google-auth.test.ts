import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest"
import { resetGoogleKeyCache, verifyGoogleIdToken } from "../../server/utils/googleAuth.js"

const CLIENT_ID = "1234-shop.apps.googleusercontent.com"
const NOW = Date.UTC(2026, 10, 6, 12, 0, 0)
const sec = (ms: number) => Math.floor(ms / 1000)

type Pair = { privateKey: any; jwk: { n: string; e: string } }
let good: Pair
let other: Pair

async function makePair(): Promise<Pair> {
  const pair = (await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"],
  )) as any
  const jwk = await crypto.subtle.exportKey("jwk", pair.publicKey)
  return { privateKey: pair.privateKey, jwk: { n: jwk.n!, e: jwk.e! } }
}

const enc = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url")

async function makeToken(
  claims: Record<string, unknown> = {},
  opts: { kid?: string; alg?: string; key?: Pair } = {},
): Promise<string> {
  const header = enc({ alg: opts.alg ?? "RS256", kid: opts.kid ?? "k1", typ: "JWT" })
  const payload = enc({
    iss: "https://accounts.google.com",
    aud: CLIENT_ID,
    sub: "1100223344",
    email: "Rahim@Gmail.com",
    email_verified: true,
    name: "  Rahim Uddin ",
    iat: sec(NOW) - 10,
    exp: sec(NOW) + 3600,
    ...claims,
  })
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    (opts.key ?? good).privateKey,
    new TextEncoder().encode(`${header}.${payload}`),
  )
  return `${header}.${payload}.${Buffer.from(signature).toString("base64url")}`
}

let fetchMock: ReturnType<typeof vi.fn>

beforeAll(async () => {
  good = await makePair()
  other = await makePair()
})

beforeEach(() => {
  resetGoogleKeyCache()
  fetchMock = vi.fn(
    async () =>
      new Response(JSON.stringify({ keys: [{ kid: "k1", kty: "RSA", alg: "RS256", use: "sig", ...good.jwk }] }), { status: 200 }),
  )
  vi.stubGlobal("fetch", fetchMock)
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe("Google ID token check", () => {
  test("accepts a token Google signed for this shop", async () => {
    const profile = await verifyGoogleIdToken(await makeToken(), CLIENT_ID, NOW)
    expect(profile).toEqual({ sub: "1100223344", email: "rahim@gmail.com", name: "Rahim Uddin" })
  })

  test("accepts email_verified sent as the text 'true' and the short issuer name", async () => {
    const token = await makeToken({ email_verified: "true", iss: "accounts.google.com" })
    expect(await verifyGoogleIdToken(token, CLIENT_ID, NOW)).not.toBeNull()
  })

  test("a token made for another app is refused", async () => {
    expect(await verifyGoogleIdToken(await makeToken({ aud: "someone-else.apps.googleusercontent.com" }), CLIENT_ID, NOW)).toBeNull()
  })

  test("an expired token is refused, a just-expired one is allowed for clock drift", async () => {
    expect(await verifyGoogleIdToken(await makeToken({ exp: sec(NOW) - 3600 }), CLIENT_ID, NOW)).toBeNull()
    expect(await verifyGoogleIdToken(await makeToken({ exp: sec(NOW) - 20 }), CLIENT_ID, NOW)).not.toBeNull()
  })

  test("a token from the future is refused", async () => {
    expect(await verifyGoogleIdToken(await makeToken({ iat: sec(NOW) + 3600 }), CLIENT_ID, NOW)).toBeNull()
  })

  test("an email Google has not verified is refused", async () => {
    expect(await verifyGoogleIdToken(await makeToken({ email_verified: false }), CLIENT_ID, NOW)).toBeNull()
    expect(await verifyGoogleIdToken(await makeToken({ email_verified: undefined }), CLIENT_ID, NOW)).toBeNull()
  })

  test("another issuer is refused", async () => {
    expect(await verifyGoogleIdToken(await makeToken({ iss: "https://evil.example" }), CLIENT_ID, NOW)).toBeNull()
  })

  test("missing id or email is refused", async () => {
    expect(await verifyGoogleIdToken(await makeToken({ sub: "" }), CLIENT_ID, NOW)).toBeNull()
    expect(await verifyGoogleIdToken(await makeToken({ email: "not-an-email" }), CLIENT_ID, NOW)).toBeNull()
  })

  test("a token signed with a different key is refused", async () => {
    expect(await verifyGoogleIdToken(await makeToken({}, { key: other }), CLIENT_ID, NOW)).toBeNull()
  })

  test("a token whose contents were changed after signing is refused", async () => {
    const [h, , s] = (await makeToken()).split(".")
    const forged = enc({
      iss: "https://accounts.google.com",
      aud: CLIENT_ID,
      sub: "999",
      email: "boss@gmail.com",
      email_verified: true,
      iat: sec(NOW),
      exp: sec(NOW) + 3600,
    })
    expect(await verifyGoogleIdToken(`${h}.${forged}.${s}`, CLIENT_ID, NOW)).toBeNull()
  })

  test("only RS256 is accepted (no 'none' or HMAC tricks)", async () => {
    for (const alg of ["none", "HS256"]) {
      expect(await verifyGoogleIdToken(await makeToken({}, { alg }), CLIENT_ID, NOW)).toBeNull()
    }
  })

  test("garbage never throws", async () => {
    for (const junk of ["", "a.b.c", "x".repeat(5000), "a.b", "....", "💥"]) {
      await expect(verifyGoogleIdToken(junk, CLIENT_ID, NOW)).resolves.toBeNull()
    }
    await expect(verifyGoogleIdToken(await makeToken(), "", NOW)).resolves.toBeNull()
  })

  test("Google's keys are downloaded once, and an unknown key id does not cause repeated downloads", async () => {
    await verifyGoogleIdToken(await makeToken(), CLIENT_ID, NOW)
    await verifyGoogleIdToken(await makeToken(), CLIENT_ID, NOW + 1000)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    for (let i = 0; i < 5; i++) {
      expect(await verifyGoogleIdToken(await makeToken({}, { kid: "unknown" }), CLIENT_ID, NOW + 2000 + i)).toBeNull()
    }
    expect(fetchMock).toHaveBeenCalledTimes(1) // within a minute: no extra download
    expect(await verifyGoogleIdToken(await makeToken({}, { kid: "unknown" }), CLIENT_ID, NOW + 120_000)).toBeNull()
    expect(fetchMock).toHaveBeenCalledTimes(2) // after a minute one more try is allowed
  })

  test("if Google cannot be reached the sign-in fails safely", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {})
    vi.stubGlobal("fetch", vi.fn(async () => Promise.reject(new Error("offline"))))
    expect(await verifyGoogleIdToken(await makeToken(), CLIENT_ID, NOW)).toBeNull()
  })
})
