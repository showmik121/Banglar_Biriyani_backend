import { afterEach, beforeAll, describe, expect, test, vi } from "vitest"
import {
  createVapidAuthorization,
  getVapidKeys,
  isPushEndpoint,
  sendPushPing,
  type VapidKeys,
} from "../../server/utils/webPush.js"

const b64url = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64url")

let keys: VapidKeys
let publicKeyObject: Awaited<ReturnType<typeof crypto.subtle.importKey>>

beforeAll(async () => {
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"])
  const jwk = await crypto.subtle.exportKey("jwk", pair.privateKey)
  const raw = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey))
  keys = { publicKey: b64url(raw), privateKey: jwk.d!, subject: "https://shop.example.com" }
  publicKeyObject = pair.publicKey
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  delete process.env.VAPID_PUBLIC_KEY
  delete process.env.VAPID_PRIVATE_KEY
  delete process.env.VAPID_SUBJECT
})

const FCM = "https://fcm.googleapis.com/fcm/send/abc123"

describe("which addresses may be contacted", () => {
  test("accepts the push services browsers use", () => {
    for (const url of [
      FCM,
      "https://updates.push.services.mozilla.com/wpush/v2/xyz",
      "https://web.push.apple.com/QabC",
      "https://db5p.notify.windows.com/?token=1",
    ]) {
      expect(isPushEndpoint(url), url).toBe(true)
    }
  })

  test("refuses everything else", () => {
    for (const url of [
      "http://fcm.googleapis.com/fcm/send/abc",
      "https://evil.example/fcm.googleapis.com",
      "https://fcm.googleapis.com.evil.example/x",
      "https://user:pw@fcm.googleapis.com/x",
      "https://fcm.googleapis.com:8443/x",
      "https://169.254.169.254/latest/meta-data",
      "https://localhost/x",
      "not a url",
      "",
      42,
      null,
      `https://fcm.googleapis.com/${"a".repeat(1000)}`,
    ]) {
      expect(isPushEndpoint(url), String(url)).toBe(false)
    }
  })
})

describe("VAPID proof of identity", () => {
  test("is a signed token for the push service, valid for under a day", async () => {
    const now = Date.UTC(2026, 10, 6, 12, 0, 0)
    const header = await createVapidAuthorization(FCM, keys, now)
    const m = /^vapid t=([\w-]+)\.([\w-]+)\.([\w-]+), k=([\w-]+)$/.exec(header)
    expect(m).not.toBeNull()
    const [, h, p, sig, k] = m!
    expect(k).toBe(keys.publicKey)
    expect(JSON.parse(Buffer.from(h, "base64url").toString())).toEqual({ typ: "JWT", alg: "ES256" })
    const claims = JSON.parse(Buffer.from(p, "base64url").toString())
    expect(claims.aud).toBe("https://fcm.googleapis.com")
    expect(claims.sub).toBe("https://shop.example.com")
    expect(claims.exp - now / 1000).toBeGreaterThan(0)
    expect(claims.exp - now / 1000).toBeLessThanOrEqual(24 * 3600)
    const valid = await crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      publicKeyObject,
      Buffer.from(sig, "base64url"),
      new TextEncoder().encode(`${h}.${p}`),
    )
    expect(valid).toBe(true)
  })

  test("a wrong public key is refused", async () => {
    await expect(createVapidAuthorization(FCM, { ...keys, publicKey: "AAAA" })).rejects.toThrow(/P-256/)
  })
})

describe("settings", () => {
  test("the keys come from the environment, and are absent when not set", () => {
    expect(getVapidKeys()).toBeNull()
    process.env.VAPID_PUBLIC_KEY = keys.publicKey
    expect(getVapidKeys()).toBeNull() // the private key is missing too
    process.env.VAPID_PRIVATE_KEY = keys.privateKey
    process.env.VAPID_SUBJECT = "mailto:owner@example.com"
    expect(getVapidKeys()).toEqual({ publicKey: keys.publicKey, privateKey: keys.privateKey, subject: "mailto:owner@example.com" })
  })
})

describe("sending a ping", () => {
  test("posts an empty message with the proof and reports success", async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 201 }))
    vi.stubGlobal("fetch", fetchMock)
    await expect(sendPushPing(FCM, keys)).resolves.toBe("ok")
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe(FCM)
    expect(init.method).toBe("POST")
    expect(init.body).toBeUndefined()
    const headers = init.headers as Record<string, string>
    expect(headers.Authorization).toMatch(/^vapid t=/)
    expect(headers.Urgency).toBe("high")
    expect(Number(headers.TTL)).toBeGreaterThan(0)
  })

  test("a removed phone (404 or 410) is reported as gone", async () => {
    for (const status of [404, 410]) {
      vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status })))
      await expect(sendPushPing(FCM, keys)).resolves.toBe("gone")
    }
  })

  test("other failures and network errors never throw", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {})
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 500 })))
    await expect(sendPushPing(FCM, keys)).resolves.toBe("error")
    vi.stubGlobal("fetch", vi.fn(async () => Promise.reject(new Error("offline"))))
    await expect(sendPushPing(FCM, keys)).resolves.toBe("error")
  })

  test("nothing is sent without keys or to an unknown address", async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal("fetch", fetchMock)
    await expect(sendPushPing(FCM, null)).resolves.toBe("skipped")
    await expect(sendPushPing("https://evil.example/x", keys)).resolves.toBe("skipped")
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
