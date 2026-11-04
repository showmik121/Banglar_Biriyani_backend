import { afterEach, describe, expect, test } from "vitest"
import { createFailureLimiter } from "../../server/middleware/rateLimiter.js"
import { errorDetails } from "../../server/utils/errors.js"

describe("failure limiter", () => {
  test("blocks an IP after too many failures and leaves others alone", () => {
    const limiter = createFailureLimiter(3, 60_000)
    for (let i = 0; i < 2; i++) limiter.recordFailure("1.1.1.1")
    expect(limiter.retryAfterSeconds("1.1.1.1")).toBe(0)
    limiter.recordFailure("1.1.1.1")
    expect(limiter.retryAfterSeconds("1.1.1.1")).toBeGreaterThan(0)
    expect(limiter.retryAfterSeconds("2.2.2.2")).toBe(0)
    limiter.reset()
    expect(limiter.retryAfterSeconds("1.1.1.1")).toBe(0)
  })
})

describe("error details", () => {
  const original = process.env.NODE_ENV
  afterEach(() => {
    process.env.NODE_ENV = original
  })

  test("hidden on the live site, shown while developing", () => {
    process.env.NODE_ENV = "production"
    expect(errorDetails(new Error("relation users does not exist"))).toBeNull()
    process.env.NODE_ENV = "development"
    expect(errorDetails(new Error("boom"))).toBe("boom")
  })
})

describe("client address and JWT secret hardening", () => {
  test("prefers the Netlify visitor address over a typed x-forwarded-for", async () => {
    const { getClientIp } = await import("../../server/middleware/rateLimiter.js")
    const c = {
      req: {
        header: (n: string) =>
          ({ "x-nf-client-connection-ip": "203.0.113.9", "x-forwarded-for": "1.2.3.4" })[n.toLowerCase()],
      },
    } as never
    expect(getClientIp(c)).toBe("203.0.113.9")
  })

  test("refuses to start without JWT_SECRET unless NODE_ENV is development or test", async () => {
    const { getJwtSecret } = await import("../../server/utils/auth.js")
    const oldEnv = process.env.NODE_ENV
    const oldSecret = process.env.JWT_SECRET
    delete process.env.JWT_SECRET
    try {
      process.env.NODE_ENV = ""
      expect(() => getJwtSecret()).toThrow()
      process.env.NODE_ENV = "production"
      expect(() => getJwtSecret()).toThrow()
      process.env.NODE_ENV = "test"
      expect(getJwtSecret()).toBeTruthy()
    } finally {
      process.env.NODE_ENV = oldEnv
      if (oldSecret !== undefined) process.env.JWT_SECRET = oldSecret
    }
  })
})
