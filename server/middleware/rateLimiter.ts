import type { Context, Next } from "hono"

interface RateLimitRecord {
  count: number
  firstRequestTime: number
  lastRequestTime: number
}

// In-memory sliding/fixed window rate limit store
const ipStore = new Map<string, RateLimitRecord>()

export interface RateLimitOptions {
  windowMs?: number // Window in milliseconds (default 15 minutes)
  max?: number // Max allowed requests in the window (default 10)
  message?: string
}

/**
 * Extracts client IP from headers or connection
 */
export function getClientIp(c: Context): string {
  const forwardedFor = c.req.header("x-forwarded-for")
  if (forwardedFor) {
    const first = forwardedFor.split(",")[0].trim()
    if (first) return first
  }

  const realIp = c.req.header("x-real-ip")
  if (realIp) return realIp.trim()

  const cfIp = c.req.header("cf-connecting-ip")
  if (cfIp) return cfIp.trim()

  return "127.0.0.1"
}

/**
 * Orders Rate Limiting Middleware
 * Enforces maximum 10 order submissions per IP per 15 minutes.
 */
export function orderRateLimiter(options: RateLimitOptions = {}) {
  const windowMs = options.windowMs ?? 15 * 60 * 1000 // 15 minutes
  const max = options.max ?? 10
  const message =
    options.message ?? "Too many order submissions. Maximum 10 orders per 15 minutes per IP."

  return async function rateLimitMiddleware(c: Context, next: Next) {
    // Only apply rate limit to order submissions (POST requests)
    if (c.req.method !== "POST") {
      return next()
    }

    const ip = getClientIp(c)
    const now = Date.now()

    let record = ipStore.get(ip)

    if (!record || now - record.firstRequestTime > windowMs) {
      // Start a new window
      record = {
        count: 1,
        firstRequestTime: now,
        lastRequestTime: now,
      }
      ipStore.set(ip, record)
    } else {
      // Existing window
      record.count += 1
      record.lastRequestTime = now
    }

    const remaining = Math.max(0, max - record.count)
    const resetTime = Math.ceil((record.firstRequestTime + windowMs - now) / 1000)

    c.header("X-RateLimit-Limit", max.toString())
    c.header("X-RateLimit-Remaining", remaining.toString())
    c.header("X-RateLimit-Reset", resetTime.toString())

    if (record.count > max) {
      c.header("Retry-After", resetTime.toString())
      return c.json(
        {
          error: {
            code: "RATE_LIMIT_EXCEEDED",
            message,
            details: {
              ip,
              limit: max,
              windowMinutes: Math.round(windowMs / 60000),
              retryAfterSeconds: resetTime,
            },
          },
        },
        429,
      )
    }

    await next()
  }
}

/**
 * Helper to reset rate limits (useful for testing)
 */
export function resetRateLimits() {
  ipStore.clear()
}
