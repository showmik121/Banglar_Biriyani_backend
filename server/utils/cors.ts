// Which websites may call the API from a browser (CORS).
//
// The live shop reaches the API through its own address (Netlify forwards /api), so normal
// visits are same-origin and need no CORS at all. This list only matters for other websites
// (a custom domain, a preview site) that call the API directly.

import { isDevOrTestEnv } from "./auth.js"

// Only the origin of the live shop is allowed by default; SITE_URL can change it.
const DEFAULT_SITE_URL = "https://banglarbiriyani.netlify.app"
const LOCAL_ORIGIN = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/

/**
 * Turns "https://Shop.example.com/" (or any full address) into a bare lower-case origin
 * ("https://shop.example.com"). Returns null for anything that is not an http(s) address,
 * which also drops wildcards such as "*" instead of treating them as "allow everyone".
 */
export function toOrigin(value: string): string | null {
  try {
    const url = new URL(value.trim())
    if (url.protocol !== "https:" && url.protocol !== "http:") return null
    return url.origin.toLowerCase()
  } catch {
    return null
  }
}

/** The shop's own site (SITE_URL) plus everything listed in ALLOWED_ORIGINS, normalised. */
export function allowedOrigins(): string[] {
  const listed = (process.env.ALLOWED_ORIGINS || "").split(",")
  const site = process.env.SITE_URL || DEFAULT_SITE_URL
  return [...listed, site].map(toOrigin).filter((origin): origin is string => origin !== null)
}

/**
 * True when a browser at `origin` may call the API with cookies.
 * localhost is only trusted while developing or testing, never on the live site.
 */
export function isAllowedOrigin(origin: string | undefined): boolean {
  if (!origin) return false
  const normalised = origin.toLowerCase()
  if (allowedOrigins().includes(normalised)) return true
  return isDevOrTestEnv() && LOCAL_ORIGIN.test(normalised)
}
