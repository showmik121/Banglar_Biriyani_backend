import { eq, inArray } from "drizzle-orm"
import { db, orderPushSubscriptions } from "../../src/db/index.js"
import { getVapidKeys, sendPush } from "./webPush.js"

type Lang = "bn" | "en"

const STATUS_TEXT: Record<string, { bn: [string, string]; en: [string, string] }> = {
  CONFIRMED: {
    bn: ["অর্ডার কনফার্ম হয়েছে ✅", "আপনার অর্ডার গ্রহণ করা হয়েছে।"],
    en: ["Order confirmed ✅", "We have accepted your order."],
  },
  PREPARING: {
    bn: ["রান্না চলছে 👨‍🍳", "আপনার বিরিয়ানি তৈরি হচ্ছে।"],
    en: ["Cooking in progress 👨‍🍳", "Your biriyani is being prepared."],
  },
  OUT_FOR_DELIVERY: {
    bn: ["ডেলিভারির পথে 🛵", "আপনার অর্ডার রওনা হয়েছে।"],
    en: ["On the way 🛵", "Your order is out for delivery."],
  },
  DELIVERED: {
    bn: ["ডেলিভারি সম্পন্ন 🎉", "ধন্যবাদ! খাবার উপভোগ করুন।"],
    en: ["Delivered 🎉", "Thank you! Enjoy your meal."],
  },
  CANCELLED: {
    bn: ["অর্ডার বাতিল হয়েছে", "দুঃখিত, আপনার অর্ডার বাতিল করা হয়েছে।"],
    en: ["Order cancelled", "Sorry, your order was cancelled."],
  },
}

/** Orders that are finished: their phones need no more messages */
const FINAL = new Set(["DELIVERED", "CANCELLED"])

/** The notification a customer sees for a status; null for statuses that need no message (PENDING). */
export function orderStatusMessage(status: string, orderNumber: string, lang: Lang) {
  const text = STATUS_TEXT[status]
  if (!text) return null
  const [title, body] = text[lang]
  return { title, body: `#${orderNumber} · ${body}`, url: "/", tag: `bb-order-${orderNumber}` }
}

/**
 * Sends the customer a phone notification for a changed order status. Phones that no longer
 * exist are forgotten, and finished orders drop their subscriptions. Never throws.
 */
export async function notifyOrderStatus(orderId: number, orderNumber: string, status: string): Promise<void> {
  const keys = getVapidKeys()
  if (!keys || !STATUS_TEXT[status]) return
  try {
    const rows = await db.select().from(orderPushSubscriptions).where(eq(orderPushSubscriptions.orderId, orderId))
    if (rows.length === 0) return
    const results = await Promise.all(
      rows.map((r) => {
        const message = orderStatusMessage(status, orderNumber, r.lang === "en" ? "en" : "bn")!
        return sendPush({ endpoint: r.endpoint, p256dh: r.p256dh, auth: r.auth }, JSON.stringify(message), keys)
      }),
    )
    const remove = rows.filter((r, i) => results[i] === "gone" || FINAL.has(status)).map((r) => r.id)
    if (remove.length > 0) await db.delete(orderPushSubscriptions).where(inArray(orderPushSubscriptions.id, remove))
  } catch (err) {
    console.error("[push] customer notification failed:", err instanceof Error ? err.message : err)
  }
}

/** Runs the notification in the background so the admin's status change is never slowed or failed by it. */
export async function pushOrderStatus(orderId: number, orderNumber: string, status: string): Promise<void> {
  const job = notifyOrderStatus(orderId, orderNumber, status)
  const runtime = (globalThis as any).EdgeRuntime
  if (runtime?.waitUntil) {
    runtime.waitUntil(job)
    return
  }
  await job
}

