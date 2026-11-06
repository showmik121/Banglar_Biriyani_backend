import { beforeAll, describe, expect, test } from "vitest"
import type { Hono } from "hono"
import { b64url, encryptPushPayload, fromB64url } from "../../server/utils/webPush.js"

// The database is never queried here; a placeholder address just lets the modules load
let app: Hono
let orderStatusMessage: typeof import("../../server/utils/orderPush.js").orderStatusMessage
beforeAll(async () => {
  process.env.DATABASE_URL ||= "postgresql://ci:ci@localhost:5432/ci"
  process.env.NODE_ENV = "test"
  app = (await import("../../server/index.js")).app
  orderStatusMessage = (await import("../../server/utils/orderPush.js")).orderStatusMessage
})

describe("encrypted push messages (RFC 8291)", () => {
  test("matches the example in RFC 8291 appendix A", async () => {
    const asPublic = fromB64url("BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8")
    const jwk = (d?: string) => ({
      kty: "EC",
      crv: "P-256",
      x: b64url(asPublic.slice(1, 33)),
      y: b64url(asPublic.slice(33, 65)),
      ...(d ? { d } : {}),
      ext: true,
    })
    const privateKey = await crypto.subtle.importKey("jwk", jwk("yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw"), { name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"])
    const publicKey = await crypto.subtle.importKey("jwk", jwk(), { name: "ECDH", namedCurve: "P-256" }, true, [])
    const out = await encryptPushPayload(
      "When I grow up, I want to be a watermelon",
      "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4",
      "BTBZMqHH6r4Tts7J_aSIgg",
      { salt: fromB64url("DGv6ra1nlYgDCS1FRnbzlw"), keyPair: { publicKey, privateKey } },
    )
    expect(b64url(out)).toBe(
      "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN",
    )
  })

  test("rejects broken subscription keys", async () => {
    await expect(encryptPushPayload("hi", "AAAA", "BBBB")).rejects.toThrow()
  })
})

describe("customer order messages", () => {
  test("every status after PENDING has Bangla and English text with the order number", () => {
    for (const status of ["CONFIRMED", "PREPARING", "OUT_FOR_DELIVERY", "DELIVERED", "CANCELLED"]) {
      const bn = orderStatusMessage(status, "BB-1", "bn")!
      const en = orderStatusMessage(status, "BB-1", "en")!
      expect(bn.body).toContain("#BB-1")
      expect(en.body).toContain("#BB-1")
      expect(bn.title).not.toBe(en.title)
      expect(bn.tag).toBe("bb-order-BB-1")
    }
  })

  test("a new (PENDING) order sends nothing", () => {
    expect(orderStatusMessage("PENDING", "BB-1", "bn")).toBeNull()
  })
})

describe("order notification routes", () => {
  const post = (url: string, body: unknown) =>
    app.request(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })

  test("config is public", async () => {
    const res = await app.request("/api/order-push/config")
    expect(res.status).toBe(200)
  })

  test("subscribe rejects endpoints that are not push services", async () => {
    const res = await post("/api/order-push/subscribe", {
      endpoint: "https://evil.example.com/x",
      keys: { p256dh: "a", auth: "b" },
      orders: [{ orderNumber: "BB-1", phone: "01700000000" }],
    })
    expect(res.status).toBe(422)
  })

  test("subscribe rejects malformed keys and empty order lists", async () => {
    const endpoint = "https://fcm.googleapis.com/fcm/send/abc"
    expect((await post("/api/order-push/subscribe", { endpoint, keys: { p256dh: "a", auth: "b" }, orders: [{ orderNumber: "x" }] })).status).toBe(422)
    const p256dh = b64url(new Uint8Array([4, ...new Uint8Array(64)]))
    const auth = b64url(new Uint8Array(16))
    expect((await post("/api/order-push/subscribe", { endpoint, keys: { p256dh, auth }, orders: [] })).status).toBe(422)
  })
})
