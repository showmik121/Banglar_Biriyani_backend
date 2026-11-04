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
