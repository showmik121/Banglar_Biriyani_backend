import { inArray, eq } from "drizzle-orm"
import { db, pushSubscriptions } from "../../src/db/index.js"
import { getVapidKeys, sendPushPing } from "./webPush.js"

/**
 * Pings every registered phone (optionally only one person's). Phones that no longer exist are
 * removed. Never throws. Returns how many pings were accepted and how many failed.
 */
export async function pingPhones(userId?: number): Promise<{ sent: number; failed: number }> {
  const keys = getVapidKeys()
  if (!keys) return { sent: 0, failed: 0 }
  try {
    const rows = userId
      ? await db.select().from(pushSubscriptions).where(eq(pushSubscriptions.userId, userId))
      : await db.select().from(pushSubscriptions)
    if (rows.length === 0) return { sent: 0, failed: 0 }
    const results = await Promise.all(rows.map((r) => sendPushPing(r.endpoint, keys)))
    const gone = rows.filter((_, i) => results[i] === "gone").map((r) => r.id)
    if (gone.length > 0) await db.delete(pushSubscriptions).where(inArray(pushSubscriptions.id, gone))
    return {
      sent: results.filter((r) => r === "ok").length,
      failed: results.filter((r) => r === "error" || r === "gone").length,
    }
  } catch (err) {
    console.error("[push] ping failed:", err instanceof Error ? err.message : err)
    return { sent: 0, failed: 0 }
  }
}

/** Tells the owner's and staff phones about a new order. Never blocks or fails the order. */
export async function pushNewOrder(): Promise<void> {
  const job = pingPhones().then(() => undefined)
  const runtime = (globalThis as any).EdgeRuntime
  if (runtime?.waitUntil) {
    runtime.waitUntil(job)
    return
  }
  await job
}
