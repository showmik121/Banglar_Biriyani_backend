import { describe, expect, test } from "vitest"
import { Hono } from "hono"
import { parsePaging } from "../../server/utils/paging.js"
import { createRequestLimiter } from "../../server/middleware/rateLimiter.js"

describe("list paging", () => {
  test("uses the defaults when nothing is given", () => {
    expect(parsePaging({}, 50, 100)).toEqual({ limit: 50, offset: 0 })
  })

  test("keeps limit between 1 and the maximum", () => {
    expect(parsePaging({ limit: "500" }, 50, 100).limit).toBe(100)
    expect(parsePaging({ limit: "0" }, 50, 100).limit).toBe(1)
    expect(parsePaging({ limit: "-5" }, 50, 100).limit).toBe(1)
  })

  test("text that is not a number does not break the request", () => {
    expect(parsePaging({ limit: "abc", offset: "xyz" }, 50, 100)).toEqual({ limit: 50, offset: 0 })
  })

  test("offset cannot be negative", () => {
    expect(parsePaging({ offset: "-10" }, 50, 100).offset).toBe(0)
    expect(parsePaging({ offset: "40" }, 50, 100).offset).toBe(40)
  })
})

describe("request limiter", () => {
  const call = (app: Hono, path: string, ip: string) =>
    app.request(path, { method: "POST", headers: { "x-forwarded-for": ip } })

  test("blocks after the limit with a 429 and Retry-After, per address", async () => {
    const app = new Hono()
    app.post("/a", createRequestLimiter(2, 60_000, "slow down"), (c) => c.json({ data: "ok" }))
    expect((await call(app, "/a", "203.0.113.1")).status).toBe(200)
    expect((await call(app, "/a", "203.0.113.1")).status).toBe(200)
    const blocked = await call(app, "/a", "203.0.113.1")
    expect(blocked.status).toBe(429)
    expect(Number(blocked.headers.get("retry-after"))).toBeGreaterThan(0)
    const body = (await blocked.json()) as { error: { code: string; message: string } }
    expect(body.error.code).toBe("RATE_LIMIT_EXCEEDED")
    expect(body.error.message).toBe("slow down")
    // another visitor is not affected
    expect((await call(app, "/a", "203.0.113.2")).status).toBe(200)
  })

  test("two routes do not share one allowance", async () => {
    const app = new Hono()
    app.post("/a", createRequestLimiter(1, 60_000, "a"), (c) => c.json({ data: 1 }))
    app.post("/b", createRequestLimiter(1, 60_000, "b"), (c) => c.json({ data: 2 }))
    expect((await call(app, "/a", "203.0.113.9")).status).toBe(200)
    expect((await call(app, "/b", "203.0.113.9")).status).toBe(200)
    expect((await call(app, "/a", "203.0.113.9")).status).toBe(429)
  })
})
