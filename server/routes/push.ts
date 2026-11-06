import { Hono } from "hono"
import { and, eq } from "drizzle-orm"
import { db, pushSubscriptions } from "../../src/db/index.js"
import { requireAuth, requireRole } from "../middleware/authMiddleware.js"
import { getVapidKeys, isPushEndpoint } from "../utils/webPush.js"
import { pingPhones } from "../utils/pushNotify.js"

/** Admin and kitchen staff: turn phone notifications for new orders on or off. */
export const adminPushRouter = new Hono()
adminPushRouter.use("*", requireAuth)
adminPushRouter.use("*", requireRole(["ADMIN", "STAFF"]))

const bad = (message: string) => ({ error: { code: "VALIDATION_ERROR", message, details: null } })

/** GET /api/admin/push/config -> { data: { publicKey } } (null until the keys are set on the server) */
adminPushRouter.get("/push/config", (c) => {
  c.header("Cache-Control", "no-store")
  return c.json({ data: { publicKey: getVapidKeys()?.publicKey ?? null } })
})

/** POST /api/admin/push/subscribe { endpoint } */
adminPushRouter.post("/push/subscribe", async (c) => {
  const body = (await c.req.json().catch(() => null)) as { endpoint?: unknown } | null
  if (!isPushEndpoint(body?.endpoint)) return c.json(bad("This phone cannot receive notifications"), 422)
  const user = c.get("user")!
  await db
    .insert(pushSubscriptions)
    .values({ userId: user.id, endpoint: body.endpoint })
    .onConflictDoUpdate({ target: pushSubscriptions.endpoint, set: { userId: user.id } })
  return c.json({ data: { subscribed: true } }, 201)
})

/** POST /api/admin/push/unsubscribe { endpoint } */
adminPushRouter.post("/push/unsubscribe", async (c) => {
  const body = (await c.req.json().catch(() => null)) as { endpoint?: unknown } | null
  if (typeof body?.endpoint !== "string") return c.json(bad("Missing phone"), 422)
  const user = c.get("user")!
  await db
    .delete(pushSubscriptions)
    .where(and(eq(pushSubscriptions.endpoint, body.endpoint), eq(pushSubscriptions.userId, user.id)))
  return c.json({ data: { subscribed: false } })
})

/** POST /api/admin/push/test: sends a notification to this person's own phones */
adminPushRouter.post("/push/test", async (c) => {
  if (!getVapidKeys()) {
    return c.json({ error: { code: "PUSH_NOT_SET_UP", message: "Phone notifications are not set up on the server yet", details: null } }, 503)
  }
  const user = c.get("user")!
  return c.json({ data: await pingPhones(user.id) })
})
