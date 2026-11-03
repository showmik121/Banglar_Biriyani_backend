/**
 * Order update emails, sent through Brevo's HTTP API (free plan: 300 emails/day).
 *
 * Settings (Supabase → Edge Functions → Secrets, or .env when running locally):
 *   BREVO_API_KEY    API key from Brevo → SMTP & API → API keys
 *   EMAIL_FROM       a sender address verified in Brevo (e.g. your Gmail)
 *   EMAIL_FROM_NAME  optional, defaults to "Banglar Biriyani"
 *   SITE_URL         optional, defaults to https://banglarbiriyani.netlify.app
 *
 * If BREVO_API_KEY or EMAIL_FROM is missing, emails are skipped silently.
 * A failed email never fails the order or the status change.
 */

export type OrderEmailKind = "PLACED" | "CONFIRMED" | "PREPARING" | "OUT_FOR_DELIVERY" | "DELIVERED" | "CANCELLED"

export interface OrderEmailData {
  orderNumber: string
  customerName: string
  customerAddress: string
  totalBdt: number
  paymentMethod: string
  items?: { name: string; quantity: number; lineTotalBdt: number }[]
}

/** Status changes that send an email. PREPARING is skipped to keep the inbox quiet. */
export const EMAIL_STATUSES: ReadonlySet<string> = new Set(["CONFIRMED", "OUT_FOR_DELIVERY", "DELIVERED", "CANCELLED"])

const COPY: Record<OrderEmailKind, { subject: string; heading: string; body: string }> = {
  PLACED: {
    subject: "We got your order",
    heading: "Thanks, we got your order!",
    body: "We'll confirm it shortly. You'll get an email at every step.",
  },
  CONFIRMED: {
    subject: "Your order is confirmed",
    heading: "Your order is confirmed",
    body: "Our kitchen will start cooking it soon.",
  },
  PREPARING: {
    subject: "Your biriyani is cooking",
    heading: "Your biriyani is cooking",
    body: "We'll send it out as soon as it's ready.",
  },
  OUT_FOR_DELIVERY: {
    subject: "Your order is on the way",
    heading: "Your order is on the way",
    body: "Our rider has picked it up. Please keep your phone close.",
  },
  DELIVERED: {
    subject: "Your order was delivered",
    heading: "Enjoy your meal!",
    body: "Your order was delivered. Thank you for ordering from Banglar Biriyani.",
  },
  CANCELLED: {
    subject: "Your order was cancelled",
    heading: "Your order was cancelled",
    body: "If this is a surprise, please call us and we'll sort it out.",
  },
}

const esc = (s: string) =>
  s.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]!)

const taka = (n: number) => `৳${n.toLocaleString("en-US")}`

export function buildOrderEmail(kind: OrderEmailKind, order: OrderEmailData, siteUrl: string) {
  const copy = COPY[kind]
  const subject = `${copy.subject} · ${order.orderNumber}`
  const rows = (order.items ?? [])
    .map(
      (i) =>
        `<tr><td style="padding:6px 0">${i.quantity} × ${esc(i.name)}</td><td style="padding:6px 0;text-align:right">${taka(i.lineTotalBdt)}</td></tr>`,
    )
    .join("")
  const payment = order.paymentMethod === "COD" ? "Cash on delivery" : order.paymentMethod

  const html = `<!doctype html><html><body style="margin:0;background:#fdf8f3;font-family:Arial,sans-serif;color:#2b1d1a">
<div style="max-width:520px;margin:0 auto;padding:24px 16px">
  <div style="background:#8c0a12;color:#fff;border-radius:12px 12px 0 0;padding:16px 20px;font-weight:bold;font-size:18px">Banglar Biriyani</div>
  <div style="background:#fff;border:1px solid #eadfd8;border-top:0;border-radius:0 0 12px 12px;padding:20px">
    <h1 style="margin:0 0 8px;font-size:20px">${esc(copy.heading)}</h1>
    <p style="margin:0 0 16px;color:#6e5c58">Hi ${esc(order.customerName)}, ${esc(copy.body)}</p>
    <p style="margin:0 0 4px"><strong>Order:</strong> ${esc(order.orderNumber)}</p>
    <p style="margin:0 0 4px"><strong>Deliver to:</strong> ${esc(order.customerAddress)}</p>
    <p style="margin:0 0 16px"><strong>Payment:</strong> ${esc(payment)}</p>
    ${rows ? `<table style="width:100%;border-collapse:collapse;border-top:1px solid #eadfd8;margin-bottom:8px">${rows}</table>` : ""}
    <p style="margin:0 0 20px;font-size:16px"><strong>Total: ${taka(order.totalBdt)}</strong> <span style="color:#6e5c58">(free delivery)</span></p>
    <a href="${esc(siteUrl)}" style="display:inline-block;background:#d6131e;color:#fff;text-decoration:none;padding:12px 20px;border-radius:8px;font-weight:bold">Track my order</a>
    <p style="margin:16px 0 0;font-size:12px;color:#6e5c58">On the site, open "My orders" to see the live status.</p>
  </div>
</div></body></html>`

  const text = [
    copy.heading,
    `Hi ${order.customerName}, ${copy.body}`,
    `Order: ${order.orderNumber}`,
    `Deliver to: ${order.customerAddress}`,
    ...(order.items ?? []).map((i) => `${i.quantity} x ${i.name} — ${taka(i.lineTotalBdt)}`),
    `Total: ${taka(order.totalBdt)} (free delivery)`,
    `Track your order: ${siteUrl}`,
  ].join("\n")

  return { subject, html, text }
}

async function send(to: string, kind: OrderEmailKind, order: OrderEmailData): Promise<void> {
  const apiKey = process.env.BREVO_API_KEY
  const from = process.env.EMAIL_FROM
  if (!apiKey || !from || !to) return
  const siteUrl = process.env.SITE_URL || "https://banglarbiriyani.netlify.app"
  const { subject, html, text } = buildOrderEmail(kind, order, siteUrl)
  try {
    const res = await fetch("https://api.brevo.com/v3/smtp/email", {
      method: "POST",
      headers: { "api-key": apiKey, "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({
        sender: { email: from, name: process.env.EMAIL_FROM_NAME || "Banglar Biriyani" },
        to: [{ email: to, name: order.customerName }],
        subject,
        htmlContent: html,
        textContent: text,
      }),
      signal: AbortSignal.timeout(8000),
    })
    if (!res.ok) console.error(`[email] Brevo ${res.status} for ${order.orderNumber}:`, await res.text())
  } catch (err) {
    console.error(`[email] failed for ${order.orderNumber}:`, err)
  }
}

/**
 * Sends the email without making the customer or admin wait for it.
 * On Supabase the runtime keeps the function alive until it finishes.
 */
export async function sendOrderEmail(
  to: string | null | undefined,
  kind: OrderEmailKind,
  order: OrderEmailData,
): Promise<void> {
  if (!to) return
  const job = send(to, kind, order)
  const runtime = (globalThis as any).EdgeRuntime
  if (runtime?.waitUntil) {
    runtime.waitUntil(job)
    return
  }
  await job
}
