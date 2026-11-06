import { Hono } from "hono"
import { and, eq } from "drizzle-orm"
import { db, orders, orderPushSubscriptions } from "../../src/db/index.js"
import { optionalAuth } from "../middleware/authMiddleware.js"
import { createFailureLimiter, createRequestLimiter, getClientIp } from "../middleware/rateLimiter.js"
import { getVapidKeys, isPushEndpoint, fromB64url } from "../utils/webPush.js"
import { samePhone } from "../utils/phone.js"

/**
 * Customers: ask for a phone notification when the status of an order changes.
 * Same access rule as looking up an order: the signed-in owner, or whoever knows the
 * order number AND the phone number used for it.
 */
export const orderPushRouter = new Hono()

const MAX_ORDERS_PER_PHONE = 20
const wrongAnswers = createFailureLimiter(20, 15 * 60 * 1000)
const requestLimit = createRequestLimiter(60, 15 * 60 * 1000, "Too many requests. Please wait a few minutes.")

const bad = (message: string, code = "VALIDATION_ERROR") => ({ error: { code, message, details: null } })

/** GET /api/order-push/config -> { data: { publicKey } } (null until the keys are set on the server) */
orderPushRouter.get("/config", (c) => {
  c.header("Cache-Control", "no-store")
  return c.json({ data: { publicKey: getVapidKeys()?.publicKey ?? null } })
})

interface SubscribeBody {
  endpoint?: unknown
  keys?: { p256dh?: unknown; auth?: unknown }
  lang?: unknown
  orders?: unknown
}

/**
 * POST /api/order-push/subscribe
 * { endpoint, keys: { p256dh, auth }, lang, orders: [{ orderNumber, phone? }] }
 * Orders that do not belong to the caller are skipped (answered the same as "not found").
 */
orderPushRouter.post("/subscribe", requestLimit, optionalAuth, async (c) => {
  const body = (await c.req.json().catch(() => null)) as SubscribeBody | null
  const p256dh = body?.keys?.p256dh
  const auth = body?.keys?.auth
  if (!isPushEndpoint(body?.endpoint) || typeof p256dh !== "string" || typeof auth !== "string") {
    return c.json(bad("This phone cannot receive notifications"), 422)
  }
  try {
    if (fromB64url(p256dh).length !== 65 || fromB64url(auth).length !== 16) throw new Error("keys")
  } catch {
    return c.json(bad("This phone cannot receive notifications"), 422)
  }
  if (!Array.isArray(body.orders) || body.orders.length === 0 || body.orders.length > MAX_ORDERS_PER_PHONE) {
    return c.json(bad("Send between 1 and 20 orders"), 422)
  }
  const ip = getClientIp(c)
  const wait = wrongAnswers.retryAfterSeconds(ip)
  if (wait > 0) {
    c.header("Retry-After", String(wait))
    return c.json(bad("Too many wrong tries. Please wait a few minutes.", "RATE_LIMIT_EXCEEDED"), 429)
  }

  const user = c.get("user")
  const lang = body.lang === "en" ? "en" : "bn"
  let saved = 0
  for (const entry of body.orders as Array<{ orderNumber?: unknown; phone?: unknown }>) {
    if (typeof entry?.orderNumber !== "string") continue
    const orderNumber = entry.orderNumber.trim().toUpperCase()
    const phone = typeof entry.phone === "string" ? entry.phone : ""
    const [found] = await db.select().from(orders).where(eq(orders.orderNumber, orderNumber)).limit(1)
    const allowed =
      !!found &&
      ((user && (user.role === "ADMIN" || user.role === "STAFF" || found.userId === user.id)) ||
        (phone !== "" && samePhone(phone, found.customerPhone)))
    if (!found || !allowed) {
      wrongAnswers.recordFailure(ip)
      continue
    }
    // Finished orders will not change again
    if (found.status === "DELIVERED" || found.status === "CANCELLED") continue
    await db
      .insert(orderPushSubscriptions)
      .values({ orderId: found.id, endpoint: body.endpoint, p256dh, auth, lang })
      .onConflictDoUpdate({
        target: [orderPushSubscriptions.orderId, orderPushSubscriptions.endpoint],
        set: { p256dh, auth, lang },
      })
    saved += 1
  }
  return c.json({ data: { subscribed: saved } }, saved > 0 ? 201 : 200)
})

/** POST /api/order-push/unsubscribe { endpoint }: stops every order notification for this phone */
orderPushRouter.post("/unsubscribe", requestLimit, async (c) => {
  const body = (await c.req.json().catch(() => null)) as { endpoint?: unknown } | null
  if (typeof body?.endpoint !== "string") return c.json(bad("Missing phone"), 422)
  await db.delete(orderPushSubscriptions).where(and(eq(orderPushSubscriptions.endpoint, body.endpoint)))
  return c.json({ data: { subscribed: 0 } })
})
