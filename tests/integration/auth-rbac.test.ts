import { test, describe, beforeAll as before, afterAll as after } from "vitest"
import assert from "node:assert/strict"
import { app } from "../../server/index.js"
import { db, users } from "../../src/db/index.js"
import { eq, or } from "drizzle-orm"
import { normalizeBdPhone } from "../../server/utils/auth.js"

describe("Banglar Biriyani Auth, Phone Normalization & RBAC Test Suite", () => {
  let adminCookie = ""
  let staffCookie = ""
  let customerCookie = ""
  let adminUserId: number
  let staffUserId: number
  let customerUserId: number

  // Dynamic test users to ensure clean state
  const testPhoneCanonical = `01788${Math.floor(100000 + Math.random() * 900000)}`
  const testPhonePlus88 = `+88${testPhoneCanonical}`
  const testPhone88 = `88${testPhoneCanonical}`
  const testEmailMixed = `TestCustomer_${Date.now()}@BanglarBiriyani.COM`
  const testEmailLower = testEmailMixed.toLowerCase()
  const testPassword = "SecurePassword@123"

  before(async () => {
    // 1. Authenticate seeded Admin
    const adminRes = await app.request("http://localhost/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        identifier: "admin@banglarbiriyani.com",
        password: "Admin@1234",
      }),
    })
    assert.equal(adminRes.status, 200, "Admin login must succeed")
    adminCookie = adminRes.headers.get("set-cookie")?.split(";")[0] || ""
    const adminBody = await adminRes.json()
    adminUserId = adminBody.data.user.id

    // 2. Authenticate seeded Staff
    const staffRes = await app.request("http://localhost/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        identifier: "kitchen@banglarbiriyani.com",
        password: "Staff@1234",
      }),
    })
    assert.equal(staffRes.status, 200, "Staff login must succeed")
    staffCookie = staffRes.headers.get("set-cookie")?.split(";")[0] || ""
    const staffBody = await staffRes.json()
    staffUserId = staffBody.data.user.id

    // 3. Authenticate seeded Customer
    const customerRes = await app.request("http://localhost/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        identifier: "customer@banglarbiriyani.com",
        password: "Customer@1234",
      }),
    })
    assert.equal(customerRes.status, 200, "Customer login must succeed")
    customerCookie = customerRes.headers.get("set-cookie")?.split(";")[0] || ""
    const customerBody = await customerRes.json()
    customerUserId = customerBody.data.user.id
  })

  // =========================================================================
  // Section 1: Phone Normalization Unit & Integration Tests
  // =========================================================================
  describe("1. Bangladesh Phone Normalization Tests", () => {
    test("normalizeBdPhone helper accurately canonicalizes all Bangladesh formats", () => {
      assert.equal(normalizeBdPhone("+8801711000003"), "01711000003")
      assert.equal(normalizeBdPhone("8801711000003"), "01711000003")
      assert.equal(normalizeBdPhone("01711000003"), "01711000003")
      assert.equal(normalizeBdPhone("+880 1711-000003"), "01711000003")
      assert.equal(normalizeBdPhone("880 1711 000003"), "01711000003")
      assert.equal(normalizeBdPhone("+88 (017) 11000003"), "01711000003")
    })

    test("POST /api/auth/signup normalizes +8801... phone to canonical 01... in Neon DB", async () => {
      const res = await app.request("http://localhost/api/auth/signup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          fullName: "Phone Normalization User",
          email: testEmailMixed,
          phone: testPhonePlus88, // starts with +8801...
          password: testPassword,
          defaultAddress: "Mirpur 10, Dhaka",
        }),
      })

      assert.equal(res.status, 201, "Signup with +88 phone should succeed")
      const body = await res.json()
      assert.equal(
        body.data.user.phone,
        testPhoneCanonical,
        "User response phone must be canonical 01...",
      )
      assert.equal(body.data.user.passwordHash, undefined, "passwordHash must NOT be returned")

      // Verify in DB directly
      const [dbUser] = await db.select().from(users).where(eq(users.id, body.data.user.id)).limit(1)

      assert.ok(dbUser, "User must exist in database")
      assert.equal(
        dbUser.phone,
        testPhoneCanonical,
        "Stored DB phone must be canonical 11-digit format",
      )
      assert.equal(dbUser.email, testEmailLower, "Stored DB email must be lowercased")
    })

    test("POST /api/auth/signup prevents duplicate phone when submitted in 8801... format", async () => {
      const res = await app.request("http://localhost/api/auth/signup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          fullName: "Duplicate User",
          email: `unique_${Date.now()}@test.com`,
          phone: testPhone88, // 8801... format
          password: testPassword,
        }),
      })

      assert.equal(res.status, 409, "Must return 409 Conflict for matching canonical phone")
      const body = await res.json()
      assert.equal(body.error.code, "CONFLICT")
    })

    test("POST /api/auth/login succeeds using +8801... prefix for account registered as canonical", async () => {
      const res = await app.request("http://localhost/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          identifier: testPhonePlus88,
          password: testPassword,
        }),
      })

      assert.equal(res.status, 200, "Login with +8801... phone prefix must succeed")
      const body = await res.json()
      assert.equal(body.data.user.phone, testPhoneCanonical)
      assert.equal(body.data.user.passwordHash, undefined, "passwordHash must NEVER be exposed")
    })

    test("POST /api/auth/login succeeds using 8801... prefix without plus sign", async () => {
      const res = await app.request("http://localhost/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          identifier: testPhone88,
          password: testPassword,
        }),
      })

      assert.equal(res.status, 200, "Login with 8801... phone prefix must succeed")
      const body = await res.json()
      assert.equal(body.data.user.phone, testPhoneCanonical)
    })

    test("POST /api/auth/login succeeds using canonical 01... phone number", async () => {
      const res = await app.request("http://localhost/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          identifier: testPhoneCanonical,
          password: testPassword,
        }),
      })

      assert.equal(res.status, 200, "Login with canonical 01... phone must succeed")
      const body = await res.json()
      assert.equal(body.data.user.phone, testPhoneCanonical)
    })
  })

  // =========================================================================
  // Section 2: Case-Insensitive Email Authentication Tests
  // =========================================================================
  describe("2. Case-Insensitive Email Authentication Tests", () => {
    test("POST /api/auth/login succeeds with UPPERCASE email", async () => {
      const res = await app.request("http://localhost/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          identifier: "CUSTOMER@BANGLARBIRIYANI.COM",
          password: "Customer@1234",
        }),
      })

      assert.equal(res.status, 200, "Uppercase email login must succeed")
      const body = await res.json()
      assert.equal(body.data.user.email, "customer@banglarbiriyani.com")
      assert.equal(body.data.user.passwordHash, undefined)
    })

    test("POST /api/auth/login succeeds with mixed-case and padded whitespace email", async () => {
      const res = await app.request("http://localhost/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          identifier: "   CuStOmEr@BanglarBiriyani.Com   ",
          password: "Customer@1234",
        }),
      })

      assert.equal(res.status, 200, "Mixed-case trimmed email login must succeed")
      const body = await res.json()
      assert.equal(body.data.user.email, "customer@banglarbiriyani.com")
    })

    test("POST /api/auth/signup rejects duplicate email with different casing (HTTP 409)", async () => {
      const res = await app.request("http://localhost/api/auth/signup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          fullName: "Case Duplicate User",
          email: "ADMIN@BANGLARBIRIYANI.COM",
          phone: `01711${Math.floor(100000 + Math.random() * 900000)}`,
          password: "SomePassword123",
        }),
      })

      assert.equal(res.status, 409, "Must return 409 Conflict for case-variant existing email")
    })
  })

  // =========================================================================
  // Section 3: passwordHash Zero-Leak Guarantee Across All Endpoints
  // =========================================================================
  describe("3. passwordHash Exposure Prevention Audit", () => {
    test("GET /api/auth/me does NOT contain passwordHash", async () => {
      const res = await app.request("http://localhost/api/auth/me", {
        headers: { Cookie: customerCookie },
      })
      assert.equal(res.status, 200)
      const body = await res.json()
      assert.equal(
        body.data.user.passwordHash,
        undefined,
        "passwordHash must not be in /api/auth/me",
      )
    })

    test("PATCH /api/auth/profile does NOT contain passwordHash", async () => {
      const res = await app.request("http://localhost/api/auth/profile", {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          Cookie: customerCookie,
        },
        body: JSON.stringify({
          fullName: "Banglar Food Lover",
        }),
      })
      assert.equal(res.status, 200)
      const body = await res.json()
      assert.equal(
        body.data.user.passwordHash,
        undefined,
        "passwordHash must not be in /api/auth/profile",
      )
    })

    test("GET /api/admin/users does NOT contain passwordHash in any user record", async () => {
      const res = await app.request("http://localhost/api/admin/users", {
        headers: { Cookie: adminCookie },
      })
      assert.equal(res.status, 200)
      const body = await res.json()
      assert.ok(Array.isArray(body.data), "Users list must be an array")
      assert.ok(body.data.length > 0, "Must have users")

      for (const u of body.data) {
        assert.equal(
          u.passwordHash,
          undefined,
          `User #${u.id} (${u.email}) must NOT expose passwordHash`,
        )
      }
    })

    test("PATCH /api/admin/users/:id/role does NOT contain passwordHash", async () => {
      const res = await app.request(`http://localhost/api/admin/users/${customerUserId}/role`, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          Cookie: adminCookie,
        },
        body: JSON.stringify({
          role: "CUSTOMER", // safe update
        }),
      })
      assert.equal(res.status, 200)
      const body = await res.json()
      assert.equal(
        body.data.user.passwordHash,
        undefined,
        "passwordHash must not be in user role update response",
      )
    })
  })

  // =========================================================================
  // Section 4: Unauthenticated Access Guard (HTTP 401 on All Admin Routes)
  // =========================================================================
  describe("4. Unauthenticated Admin Route Protection (401 Unauthorized)", () => {
    test("GET /api/admin/stats returns 401 without session cookie", async () => {
      const res = await app.request("http://localhost/api/admin/stats")
      assert.equal(res.status, 401)
      const body = await res.json()
      assert.equal(body.error.code, "UNAUTHORIZED")
    })

    test("GET /api/admin/schedule returns 401 without session cookie", async () => {
      const res = await app.request("http://localhost/api/admin/schedule")
      assert.equal(res.status, 401)
    })

    test("PUT /api/admin/schedule/SATURDAY returns 401 without session cookie", async () => {
      const res = await app.request("http://localhost/api/admin/schedule/SATURDAY", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ items: [] }),
      })
      assert.equal(res.status, 401)
    })

    test("GET /api/admin/orders returns 401 without session cookie", async () => {
      const res = await app.request("http://localhost/api/admin/orders")
      assert.equal(res.status, 401)
    })

    test("POST /api/admin/menu returns 401 without session cookie", async () => {
      const res = await app.request("http://localhost/api/admin/menu", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Unauthorized Dish" }),
      })
      assert.equal(res.status, 401)
    })

    test("GET /api/admin/users returns 401 without session cookie", async () => {
      const res = await app.request("http://localhost/api/admin/users")
      assert.equal(res.status, 401)
    })
  })

  // =========================================================================
  // Section 5: CUSTOMER Role RBAC Enforcement (HTTP 403 on All Admin Routes)
  // =========================================================================
  describe("5. Customer Role RBAC Restriction (403 Forbidden)", () => {
    test("Customer cannot access GET /api/admin/stats (403 Forbidden)", async () => {
      const res = await app.request("http://localhost/api/admin/stats", {
        headers: { Cookie: customerCookie },
      })
      assert.equal(res.status, 403)
      const body = await res.json()
      assert.equal(body.error.code, "FORBIDDEN")
    })

    test("Customer cannot access GET /api/admin/schedule (403 Forbidden)", async () => {
      const res = await app.request("http://localhost/api/admin/schedule", {
        headers: { Cookie: customerCookie },
      })
      assert.equal(res.status, 403)
    })

    test("Customer cannot access PUT /api/admin/schedule/SUNDAY (403 Forbidden)", async () => {
      const res = await app.request("http://localhost/api/admin/schedule/SUNDAY", {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          Cookie: customerCookie,
        },
        body: JSON.stringify({ items: [] }),
      })
      assert.equal(res.status, 403)
    })

    test("Customer cannot access GET /api/admin/orders (403 Forbidden)", async () => {
      const res = await app.request("http://localhost/api/admin/orders", {
        headers: { Cookie: customerCookie },
      })
      assert.equal(res.status, 403)
    })

    test("Customer cannot access PATCH /api/admin/orders/1/status (403 Forbidden)", async () => {
      const res = await app.request("http://localhost/api/admin/orders/1/status", {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          Cookie: customerCookie,
        },
        body: JSON.stringify({ status: "CONFIRMED" }),
      })
      assert.equal(res.status, 403)
    })

    test("Customer cannot access POST /api/admin/menu (403 Forbidden)", async () => {
      const res = await app.request("http://localhost/api/admin/menu", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: customerCookie,
        },
        body: JSON.stringify({
          name: "Hacker Kacchi",
          categorySlug: "biriyani",
          basePriceBdt: 300,
        }),
      })
      assert.equal(res.status, 403)
    })

    test("Customer cannot access DELETE /api/admin/menu/1 (403 Forbidden)", async () => {
      const res = await app.request("http://localhost/api/admin/menu/1", {
        method: "DELETE",
        headers: { Cookie: customerCookie },
      })
      assert.equal(res.status, 403)
    })

    test("Customer cannot access GET /api/admin/users (403 Forbidden)", async () => {
      const res = await app.request("http://localhost/api/admin/users", {
        headers: { Cookie: customerCookie },
      })
      assert.equal(res.status, 403)
    })

    test("Customer cannot access PATCH /api/admin/users/1/role (403 Forbidden)", async () => {
      const res = await app.request("http://localhost/api/admin/users/1/role", {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          Cookie: customerCookie,
        },
        body: JSON.stringify({ role: "ADMIN" }),
      })
      assert.equal(res.status, 403)
    })
  })

  // =========================================================================
  // Section 6: STAFF Role RBAC Permissions & Restrictions
  // =========================================================================
  describe("6. Staff Role RBAC Permissions & Restrictions", () => {
    test("Staff CAN access GET /api/admin/stats (HTTP 200)", async () => {
      const res = await app.request("http://localhost/api/admin/stats", {
        headers: { Cookie: staffCookie },
      })
      assert.equal(res.status, 200)
      const body = await res.json()
      assert.ok(body.data.totalRevenueBdt !== undefined)
      assert.ok(body.data.orderCountsByStatus)
    })

    test("Staff CAN access GET /api/admin/schedule (HTTP 200)", async () => {
      const res = await app.request("http://localhost/api/admin/schedule", {
        headers: { Cookie: staffCookie },
      })
      assert.equal(res.status, 200)
    })

    test("Staff CAN access GET /api/admin/orders (HTTP 200)", async () => {
      const res = await app.request("http://localhost/api/admin/orders", {
        headers: { Cookie: staffCookie },
      })
      assert.equal(res.status, 200)
    })

    test("Staff CANNOT delete menu items (DELETE /api/admin/menu/:id returns 403)", async () => {
      const res = await app.request("http://localhost/api/admin/menu/1", {
        method: "DELETE",
        headers: { Cookie: staffCookie },
      })
      assert.equal(res.status, 403, "Staff must be blocked from deleting menu items")
      const body = await res.json()
      assert.equal(body.error.code, "FORBIDDEN")
    })

    test("Staff CANNOT create menu items (POST /api/admin/menu returns 403)", async () => {
      const res = await app.request("http://localhost/api/admin/menu", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: staffCookie,
        },
        body: JSON.stringify({
          name: "Staff Created Dish",
          categorySlug: "biriyani",
          basePriceBdt: 350,
        }),
      })
      assert.equal(res.status, 403, "Staff must be blocked from creating menu items")
    })

    test("Staff CANNOT view users list (GET /api/admin/users returns 403)", async () => {
      const res = await app.request("http://localhost/api/admin/users", {
        headers: { Cookie: staffCookie },
      })
      assert.equal(res.status, 403, "Staff must be blocked from viewing user list")
    })

    test("Staff CANNOT change user roles (PATCH /api/admin/users/:id/role returns 403)", async () => {
      const res = await app.request(`http://localhost/api/admin/users/${customerUserId}/role`, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          Cookie: staffCookie,
        },
        body: JSON.stringify({ role: "STAFF" }),
      })
      assert.equal(res.status, 403, "Staff must be blocked from updating user roles")
    })
  })

  // =========================================================================
  // Section 7: ADMIN Full Access & Self-Protection Guardrails
  // =========================================================================
  describe("7. Admin Management & Self-Protection Guardrails", () => {
    test("Admin CAN access all admin routes (stats, schedule, orders, users)", async () => {
      const statsRes = await app.request("http://localhost/api/admin/stats", {
        headers: { Cookie: adminCookie },
      })
      assert.equal(statsRes.status, 200)

      const ordersRes = await app.request("http://localhost/api/admin/orders", {
        headers: { Cookie: adminCookie },
      })
      assert.equal(ordersRes.status, 200)

      const usersRes = await app.request("http://localhost/api/admin/users", {
        headers: { Cookie: adminCookie },
      })
      assert.equal(usersRes.status, 200)
    })

    test("Admin CANNOT demote their own role (HTTP 403)", async () => {
      const res = await app.request(`http://localhost/api/admin/users/${adminUserId}/role`, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          Cookie: adminCookie,
        },
        body: JSON.stringify({ role: "CUSTOMER" }),
      })

      assert.equal(res.status, 403, "Admin cannot self-demote")
      const body = await res.json()
      assert.equal(body.error.code, "FORBIDDEN")
      assert.equal(body.error.message, "Admins cannot demote their own account role")
    })

    test("Admin CANNOT deactivate their own account (HTTP 403)", async () => {
      const res = await app.request(`http://localhost/api/admin/users/${adminUserId}/role`, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          Cookie: adminCookie,
        },
        body: JSON.stringify({ isActive: false }),
      })

      assert.equal(res.status, 403, "Admin cannot self-deactivate")
      const body = await res.json()
      assert.equal(body.error.code, "FORBIDDEN")
      assert.equal(body.error.message, "Admins cannot deactivate their own account")
    })

    test("Admin CAN promote and demote other users", async () => {
      // Promote customer to STAFF
      const promoteRes = await app.request(
        `http://localhost/api/admin/users/${customerUserId}/role`,
        {
          method: "PATCH",
          headers: {
            "Content-Type": "application/json",
            Cookie: adminCookie,
          },
          body: JSON.stringify({ role: "STAFF" }),
        },
      )
      assert.equal(promoteRes.status, 200)
      const promoteBody = await promoteRes.json()
      assert.equal(promoteBody.data.user.role, "STAFF")

      // Revert back to CUSTOMER
      const revertRes = await app.request(
        `http://localhost/api/admin/users/${customerUserId}/role`,
        {
          method: "PATCH",
          headers: {
            "Content-Type": "application/json",
            Cookie: adminCookie,
          },
          body: JSON.stringify({ role: "CUSTOMER" }),
        },
      )
      assert.equal(revertRes.status, 200)
      const revertBody = await revertRes.json()
      assert.equal(revertBody.data.user.role, "CUSTOMER")
    })
  })
})
