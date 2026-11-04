import type { Context, Next } from "hono"

interface RateLimitRecord {
  count: number
  firstRequestTime: number
  lastRequestTime: number
}

// In-memory sliding/fixed window rate limit store
const ipStore = new Map<string, RateLimitRecord>()

// Upper bound for every limiter store. Visitors can invent endless addresses (a typed
// x-forwarded-for) or account names, so without a cap the maps could grow until memory runs out.
export const MAX_TRACKED_KEYS = 10_000

/** Frees space before a new key is added: drops expired entries first, then the oldest one. */
function makeRoom<T>(store: Map<string, T>, isExpired: (record: T) => boolean): void {
  if (store.size < MAX_TRACKED_KEYS) return
  for (const [key, record] of store) {
    if (isExpired(record)) store.delete(key)
  }
  if (store.size >= MAX_TRACKED_KEYS) {
    const oldestKey = store.keys().next().value
    if (oldestKey !== undefined) store.delete(oldestKey)
  }
}

export interface RateLimitOptions {
  windowMs?: number // Window in milliseconds (default 15 minutes)
  max?: number // Max allowed requests in the window (default 10)
  message?: string
}

/**
 * Extracts client IP from headers or connection
 */
export function getClientIp(c: Context): string {
  // Netlify forwards /api to the backend and adds the real visitor address in this header.
  // Prefer it: x-forwarded-for can be typed by the visitor, so it is easy to fake.
  const netlifyIp = c.req.header("x-nf-client-connection-ip")
  if (netlifyIp && netlifyIp.trim()) return netlifyIp.trim()

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
      makeRoom(ipStore, (r) => now - r.firstRequestTime > windowMs)
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
  for (const limiter of failureLimiters) limiter.reset()
}

/**
 * Counts failed attempts per IP (for example wrong order number + phone combinations)
 * and blocks the IP for the rest of the window after too many.
 */
const failureLimiters: { reset(): void }[] = []

export function createFailureLimiter(max: number, windowMs: number) {
  const store = new Map<string, { count: number; first: number }>()
  const current = (ip: string) => {
    const rec = store.get(ip)
    if (!rec || Date.now() - rec.first > windowMs) return undefined
    return rec
  }
  const limiter = {
    retryAfterSeconds(ip: string): number {
      const rec = current(ip)
      if (!rec || rec.count < max) return 0
      return Math.max(1, Math.ceil((rec.first + windowMs - Date.now()) / 1000))
    },
    recordFailure(ip: string) {
      const rec = current(ip)
      if (rec) {
        rec.count += 1
        return
      }
      makeRoom(store, (r) => Date.now() - r.first > windowMs)
      store.set(ip, { count: 1, first: Date.now() })
    },
    /** Forget one key, for example after a successful login. */
    clear(ip: string) {
      store.delete(ip)
    },
    /** Number of tracked keys (used by tests to check the memory cap). */
    size(): number {
      return store.size
    },
    reset() {
      store.clear()
    },
  }
  failureLimiters.push(limiter)
  return limiter
}

/**
 * Limits how many requests one IP can make to a route in a time window (every request counts).
 * Each call makes its own counter, so routes do not use up each other's allowance.
 */
export function createRequestLimiter(max: number, windowMs: number, message: string) {
  const limiter = createFailureLimiter(max, windowMs)
  return async function requestLimitMiddleware(c: Context, next: Next) {
    const ip = getClientIp(c)
    const wait = limiter.retryAfterSeconds(ip)
    if (wait > 0) {
      c.header("Retry-After", String(wait))
      return c.json(
        { error: { code: "RATE_LIMIT_EXCEEDED", message, details: { retryAfterSeconds: wait } } },
        429,
      )
    }
    limiter.recordFailure(ip)
    return next()
  }
}
