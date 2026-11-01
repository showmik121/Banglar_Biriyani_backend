import { describe, test, expect, beforeAll } from "vitest"
import type { Hono } from "hono"

// These routes don't touch the database. A placeholder connection string lets the
// app module load; no connection is opened because no query runs.
let app: Hono

beforeAll(async () => {
  process.env.DATABASE_URL ||= "postgresql://ci:ci@localhost:5432/ci"
  process.env.NODE_ENV = "test"
  app = (await import("../../server/index.js")).app
})

describe("API routes that need no database", () => {
  test("GET /api/health returns ok", async () => {
    const res = await app.request("/api/health")
    expect(res.status).toBe(200)
    const body = (await res.json()) as { data?: any; error?: any }
    expect(body.data.status).toBe("ok")
  })

  test("unknown endpoints return a JSON 404", async () => {
    const res = await app.request("/api/does-not-exist")
    expect(res.status).toBe(404)
    const body = (await res.json()) as { data?: any; error?: any }
    expect(body.error.code).toBe("NOT_FOUND")
  })

  test("protected routes reject requests without a session", async () => {
    for (const url of ["/api/orders/my-orders", "/api/auth/me"]) {
      const res = await app.request(url)
      expect(res.status).toBe(401)
      const body = (await res.json()) as { data?: any; error?: any }
      expect(body.error.code).toBe("UNAUTHORIZED")
    }
  })
})
