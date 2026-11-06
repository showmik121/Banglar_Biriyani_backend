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

  test("responses carry basic security headers", async () => {
    const res = await app.request("/api/health")
    expect(res.headers.get("x-content-type-options")).toBe("nosniff")
    expect(res.headers.get("x-frame-options")).toBeTruthy()
  })

  test("only known websites get CORS access", async () => {
    const other = await app.request("/api/health", { headers: { Origin: "https://evil.example" } })
    expect(other.headers.get("access-control-allow-origin")).toBeFalsy()

    const local = await app.request("/api/health", { headers: { Origin: "http://localhost:5173" } })
    expect(local.headers.get("access-control-allow-origin")).toBe("http://localhost:5173")

    process.env.ALLOWED_ORIGINS = "https://shop.example.com"
    const listed = await app.request("/api/health", { headers: { Origin: "https://shop.example.com" } })
    expect(listed.headers.get("access-control-allow-origin")).toBe("https://shop.example.com")
    delete process.env.ALLOWED_ORIGINS
  })

  test("the sign-in screen can ask whether Google sign-in is set up", async () => {
    delete process.env.GOOGLE_CLIENT_ID
    const off = await app.request("/api/auth/config")
    expect(off.status).toBe(200)
    expect(((await off.json()) as any).data.googleClientId).toBeNull()

    process.env.GOOGLE_CLIENT_ID = "123-shop.apps.googleusercontent.com"
    const on = await app.request("/api/auth/config")
    expect(((await on.json()) as any).data.googleClientId).toBe("123-shop.apps.googleusercontent.com")
    delete process.env.GOOGLE_CLIENT_ID
  })

  test("Google sign-in refuses everything that is not a valid Google token", async () => {
    const post = (body: unknown) =>
      app.request("/api/auth/google", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      })

    delete process.env.GOOGLE_CLIENT_ID
    expect((await post({ credential: "x.y.z" })).status).toBe(503)

    process.env.GOOGLE_CLIENT_ID = "123-shop.apps.googleusercontent.com"
    expect((await post({})).status).toBe(422)
    expect((await post({ credential: 42 })).status).toBe(422)
    const bad = await post({ credential: "not-a-token" })
    expect(bad.status).toBe(401)
    expect(((await bad.json()) as any).error.code).toBe("INVALID_GOOGLE_TOKEN")
    delete process.env.GOOGLE_CLIENT_ID
  })

  test("unknown endpoints return a JSON 404", async () => {
    const res = await app.request("/api/does-not-exist")
    expect(res.status).toBe(404)
    const body = (await res.json()) as { data?: any; error?: any }
    expect(body.error.code).toBe("NOT_FOUND")
  })

  test("tracking an order needs the phone number when not signed in", async () => {
    const res = await app.request("/api/orders/BB-20261103-1234567")
    expect(res.status).toBe(400)
    const body = (await res.json()) as { data?: any; error?: any }
    expect(body.error.code).toBe("PHONE_REQUIRED")
  })

  test("protected routes reject requests without a session", async () => {
    for (const url of [
      "/api/orders/my-orders",
      "/api/auth/me",
      "/api/admin/orders",
      "/api/admin/offers",
      "/api/admin/delivery-zones",
      "/api/admin/push/config",
    ]) {
      const res = await app.request(url)
      expect(res.status).toBe(401)
      const body = (await res.json()) as { data?: any; error?: any }
      expect(body.error.code).toBe("UNAUTHORIZED")
    }
  })

  test("admin write routes also reject anonymous requests", async () => {
    const attempts: [string, string][] = [
      ["POST", "/api/admin/offers"],
      ["PATCH", "/api/admin/offers/1"],
      ["DELETE", "/api/admin/offers/1"],
      ["POST", "/api/admin/delivery-zones"],
      ["PATCH", "/api/admin/menu/1"],
      ["PATCH", "/api/admin/orders/1/status"],
      ["POST", "/api/admin/push/subscribe"],
      ["POST", "/api/admin/push/unsubscribe"],
      ["POST", "/api/admin/push/test"],
    ]
    for (const [method, url] of attempts) {
      const res = await app.request(url, {
        method,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      })
      expect(res.status, `${method} ${url}`).toBe(401)
    }
  })

  test("a forged session token is rejected", async () => {
    const res = await app.request("/api/admin/offers", {
      headers: { authorization: "Bearer not-a-real-token" },
    })
    expect(res.status).toBe(401)
  })
})
