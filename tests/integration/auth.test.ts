import { test, describe, afterAll as after } from "vitest"
import assert from "node:assert/strict"
import { app } from "../../server/index.js"
import {
  pool,
  db,
  users,
  sessions,
  dailyMenuSchedules,
  orders,
  orderItems,
} from "../../src/db/index.js"
import { eq, and, sql } from "drizzle-orm"

describe("Banglar Biriyani Auth & RBAC Test Suite (TDD)", () => {
  after(async () => {
    // Note: Pool remains open if other tests run or ends cleanly here
  })

  const testEmail = `testuser_${Date.now()}@banglarbiriyani.com`
  const testPhone = `01799${Math.floor(100000 + Math.random() * 900000)}`
  const testPassword = "StrongPassword@123"
  let sessionCookie = ""
  let userId: number

  // =========================================================================
  // 1. POST /api/auth/signup Tests
  // =========================================================================
  describe("POST /api/auth/signup", () => {
    test("Rejects signup with invalid BD phone format (HTTP 422)", async () => {
      const res = await app.request("http://localhost/api/auth/signup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          fullName: "Invalid Phone User",
          email: "invalid_phone@test.com",
          phone: "01234567890", // 012 is invalid operator in BD
          password: "ValidPassword123",
        }),
      })

      assert.equal(res.status, 422)
      const body = await res.json()
      assert.equal(body.error.code, "VALIDATION_ERROR")
    })

    test("Rejects signup with password shorter than 8 characters (HTTP 422)", async () => {
      const res = await app.request("http://localhost/api/auth/signup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          fullName: "Short Password User",
          email: "short_pwd@test.com",
          phone: "01711223344",
          password: "short",
        }),
      })

      assert.equal(res.status, 422)
      const body = await res.json()
      assert.equal(body.error.code, "VALIDATION_ERROR")
    })

    test("Successfully signs up new customer account with HTTP 201 and sets bb_session cookie", async () => {
      const res = await app.request("http://localhost/api/auth/signup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          fullName: "Test Customer",
          email: testEmail,
          phone: testPhone,
          password: testPassword,
          defaultAddress: "House 10, Road 5, Banani, Dhaka",
        }),
      })

      assert.equal(res.status, 201)
      const setCookie = res.headers.get("set-cookie")
      assert.ok(setCookie, "Response must include Set-Cookie header")
      assert.ok(setCookie.includes("bb_session="), "Cookie name must be bb_session")
      assert.ok(setCookie.toLowerCase().includes("httponly"), "Cookie must be HttpOnly")
      assert.ok(setCookie.toLowerCase().includes("samesite=lax"), "Cookie must have SameSite=Lax")

      // Extract cookie for subsequent tests
      sessionCookie = setCookie.split(";")[0]

      const body = await res.json()
      assert.ok(body.data.user, "Must return data.user")
      assert.equal(body.data.user.email, testEmail)
      assert.equal(body.data.user.role, "CUSTOMER")
      assert.equal(body.data.user.passwordHash, undefined, "passwordHash must NEVER be exposed")
      userId = body.data.user.id
    })

    test("Rejects duplicate email signup with HTTP 409 Conflict", async () => {
      const res = await app.request("http://localhost/api/auth/signup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          fullName: "Duplicate Email",
          email: testEmail,
          phone: "01711998877",
          password: testPassword,
        }),
      })

      assert.equal(res.status, 409)
      const body = await res.json()
      assert.equal(body.error.code, "CONFLICT")
    })

    test("Rejects duplicate phone signup with HTTP 409 Conflict", async () => {
      const res = await app.request("http://localhost/api/auth/signup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          fullName: "Duplicate Phone",
          email: "another_unique_email@test.com",
          phone: testPhone,
          password: testPassword,
        }),
      })

      assert.equal(res.status, 409)
      const body = await res.json()
      assert.equal(body.error.code, "CONFLICT")
    })
  })

  // =========================================================================
  // 2. POST /api/auth/login Tests
  // =========================================================================
  describe("POST /api/auth/login", () => {
    test("Fails login with wrong password (HTTP 401)", async () => {
      const res = await app.request("http://localhost/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          identifier: testEmail,
          password: "WrongPassword@999",
        }),
      })

      assert.equal(res.status, 401)
      const body = await res.json()
      assert.equal(body.error.code, "INVALID_CREDENTIALS")
    })

    test("Fails login with non-existent email (HTTP 401)", async () => {
      const res = await app.request("http://localhost/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          identifier: "does_not_exist@banglarbiriyani.com",
          password: "SomePassword123",
        }),
      })

      assert.equal(res.status, 401)
      const body = await res.json()
      assert.equal(body.error.code, "INVALID_CREDENTIALS")
    })

    test("Successfully logs in using email identifier (HTTP 200)", async () => {
      const res = await app.request("http://localhost/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          identifier: testEmail,
          password: testPassword,
        }),
      })

      assert.equal(res.status, 200)
      const setCookie = res.headers.get("set-cookie")
      assert.ok(setCookie && setCookie.includes("bb_session="))
      const body = await res.json()
      assert.equal(body.data.user.email, testEmail)
      assert.equal(body.data.user.passwordHash, undefined)
    })

    test("Successfully logs in using phone identifier with +88 prefix (HTTP 200)", async () => {
      const res = await app.request("http://localhost/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          identifier: `+88${testPhone}`,
          password: testPassword,
        }),
      })

      assert.equal(res.status, 200)
      const body = await res.json()
      assert.equal(body.data.user.phone, testPhone)
    })
  })

  // =========================================================================
  // 3. GET /api/auth/me & PATCH /api/auth/profile Tests
  // =========================================================================
  describe("GET /api/auth/me & PATCH /api/auth/profile", () => {
    test("GET /api/auth/me rejects unauthenticated request with HTTP 401", async () => {
      const res = await app.request("http://localhost/api/auth/me", {
        method: "GET",
      })

      assert.equal(res.status, 401)
      const body = await res.json()
      assert.equal(body.error.code, "UNAUTHORIZED")
    })

    test("GET /api/auth/me returns current user profile with valid session cookie", async () => {
      const res = await app.request("http://localhost/api/auth/me", {
        method: "GET",
        headers: { Cookie: sessionCookie },
      })

      assert.equal(res.status, 200)
      const body = await res.json()
      assert.equal(body.data.user.id, userId)
      assert.equal(body.data.user.email, testEmail)
      assert.equal(body.data.user.passwordHash, undefined)
    })

    test("PATCH /api/auth/profile updates profile information", async () => {
      const res = await app.request("http://localhost/api/auth/profile", {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          Cookie: sessionCookie,
        },
        body: JSON.stringify({
          fullName: "Updated Customer Name",
          defaultAddress: "Gulshan-1, Dhaka",
        }),
      })

      assert.equal(res.status, 200)
      const body = await res.json()
      assert.equal(body.data.user.fullName, "Updated Customer Name")
      assert.equal(body.data.user.defaultAddress, "Gulshan-1, Dhaka")
    })
  })

  // =========================================================================
  // 4. Authenticated Orders & Quota Tracking
  // =========================================================================
  describe("Authenticated Orders & Quota Tracking", () => {
    test("POST /api/orders with session cookie automatically assigns orders.userId and increments soldCount", async () => {
      // Fetch an available Sunday item to avoid interference with tests ordering on Saturday
      const menuRes = await app.request("http://localhost/api/menu/SUNDAY")
      const menuBody = await menuRes.json()
      const sundayItem = menuBody.data.items[0]
      assert.ok(sundayItem, "Must have a Sunday item")

      // Check current soldCount in DB
      const [scheduleBefore] = await db
        .select()
        .from(dailyMenuSchedules)
        .where(
          and(
            eq(dailyMenuSchedules.menuItemId, sundayItem.id),
            eq(dailyMenuSchedules.dayOfWeek, "SUNDAY"),
          ),
        )
      const beforeSoldCount = scheduleBefore?.soldCount ?? 0

      // Submit authenticated order
      const orderRes = await app.request("http://localhost/api/orders", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: sessionCookie,
        },
        body: JSON.stringify({
          customerName: "Updated Customer Name",
          customerPhone: testPhone,
          customerAddress: "Gulshan-1, Dhaka",
          scheduledDay: "SUNDAY",
          deliverySlot: "Dinner (7:30 PM - 8:30 PM)",
          paymentMethod: "BKASH",
          paymentTrxId: "BKASH-AUTH-TX7788",
          items: [{ menuItemId: sundayItem.id, quantity: 2 }],
        }),
      })

      assert.equal(orderRes.status, 201)
      const orderBody = await orderRes.json()
      assert.equal(orderBody.data.order.userId, userId, "Order must link to authenticated userId")

      // Verify soldCount incremented by ordered quantity (2) in DB
      const [scheduleAfter] = await db
        .select()
        .from(dailyMenuSchedules)
        .where(
          and(
            eq(dailyMenuSchedules.menuItemId, sundayItem.id),
            eq(dailyMenuSchedules.dayOfWeek, "SUNDAY"),
          ),
        )
      assert.equal(
        scheduleAfter.soldCount,
        beforeSoldCount + 2,
        "daily_menu_schedules.soldCount must increment atomically by quantity",
      )
    })

    test("GET /api/orders/my-orders returns orders placed by the authenticated customer", async () => {
      const res = await app.request("http://localhost/api/orders/my-orders", {
        method: "GET",
        headers: { Cookie: sessionCookie },
      })

      assert.equal(res.status, 200)
      const body = await res.json()
      assert.ok(Array.isArray(body.data))
      assert.ok(body.data.length >= 1, "Must return at least 1 order")
      assert.equal(body.data[0].order.userId, userId)
      assert.ok(Array.isArray(body.data[0].items))
    })

    test("GET /api/orders/my-orders rejects unauthenticated requests with HTTP 401", async () => {
      const res = await app.request("http://localhost/api/orders/my-orders", {
        method: "GET",
      })

      assert.equal(res.status, 401)
    })
  })

  // =========================================================================
  // 5. Rate Limiting on Failed Logins
  // =========================================================================
  describe("Failed Login Rate Limiting", () => {
    test("Enforces maximum 5 failed login attempts per 15 minutes per IP (HTTP 429)", async () => {
      const attackerIp = "192.168.10.88"
      for (let i = 0; i < 5; i++) {
        const failRes = await app.request("http://localhost/api/auth/login", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-forwarded-for": attackerIp,
          },
          body: JSON.stringify({
            identifier: testEmail,
            password: "WrongPasswordAttempts",
          }),
        })
        assert.equal(failRes.status, 401)
      }

      // 6th attempt from the same IP must be rejected with 429
      const blockedRes = await app.request("http://localhost/api/auth/login", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-forwarded-for": attackerIp,
        },
        body: JSON.stringify({
          identifier: testEmail,
          password: "WrongPasswordAttempts",
        }),
      })

      assert.equal(blockedRes.status, 429)
      const body = await blockedRes.json()
      assert.equal(body.error.code, "RATE_LIMIT_EXCEEDED")
      assert.ok(blockedRes.headers.get("retry-after"))
    })
  })

  // =========================================================================
  // 6. Role-Based Access Control (RBAC) Tests
  // =========================================================================
  describe("Role-Based Access Control (RBAC)", () => {
    test("requireRole rejects customer from accessing staff/admin routes with HTTP 403 Forbidden", async () => {
      const { Hono } = await import("hono")
      const { requireRole } = await import("../../server/middleware/authMiddleware.js")
      const testRbacApp = new Hono()
      testRbacApp.get("/admin-panel", requireRole(["ADMIN"]), (c) =>
        c.json({ data: { message: "Admin Panel Access Granted" } }),
      )

      // Customer tries to access admin route
      const customerRes = await testRbacApp.request("http://localhost/admin-panel", {
        method: "GET",
        headers: { Cookie: sessionCookie },
      })

      assert.equal(customerRes.status, 403)
      const body = await customerRes.json()
      assert.equal(body.error.code, "FORBIDDEN")
      assert.equal(body.error.message, "Insufficient permissions")
    })

    test("requireRole allows admin account (admin@banglarbiriyani.com) to access admin routes with HTTP 200", async () => {
      const { Hono } = await import("hono")
      const { requireRole } = await import("../../server/middleware/authMiddleware.js")
      const testRbacApp = new Hono()
      testRbacApp.get("/admin-panel", requireRole(["ADMIN"]), (c) =>
        c.json({ data: { message: "Admin Panel Access Granted" } }),
      )

      // Login as admin
      const adminLoginRes = await app.request("http://localhost/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          identifier: "admin@banglarbiriyani.com",
          password: "Admin@1234",
        }),
      })

      assert.equal(adminLoginRes.status, 200)
      const adminCookie = adminLoginRes.headers.get("set-cookie")?.split(";")[0]
      assert.ok(adminCookie)

      const adminAccessRes = await testRbacApp.request("http://localhost/admin-panel", {
        method: "GET",
        headers: { Cookie: adminCookie },
      })

      assert.equal(adminAccessRes.status, 200)
      const body = await adminAccessRes.json()
      assert.equal(body.data.message, "Admin Panel Access Granted")
    })
  })

  // =========================================================================
  // 7. POST /api/auth/logout Tests
  // =========================================================================
  describe("POST /api/auth/logout", () => {
    test("POST /api/auth/logout clears cookie and invalidates session in database", async () => {
      const res = await app.request("http://localhost/api/auth/logout", {
        method: "POST",
        headers: { Cookie: sessionCookie },
      })

      assert.equal(res.status, 200)
      const setCookie = res.headers.get("set-cookie")
      assert.ok(setCookie, "Must set cookie header")
      assert.ok(
        setCookie.includes("Max-Age=0") || setCookie.includes("bb_session=;"),
        "Must clear cookie",
      )

      // Subsequent request with the same cookie must now be rejected (401)
      const meRes = await app.request("http://localhost/api/auth/me", {
        method: "GET",
        headers: { Cookie: sessionCookie },
      })
      assert.equal(meRes.status, 401)
    })
  })
})
