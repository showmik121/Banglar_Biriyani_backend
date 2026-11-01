import { test, describe, beforeAll as before, afterAll as after } from "vitest"
import assert from "node:assert/strict"
import { app } from "../../server/index.js"
import {
  pool,
  db,
  users,
  orders,
  menuItems,
  dailyMenuSchedules,
  auditLogs,
} from "../../src/db/index.js"
import { eq, desc, and } from "drizzle-orm"

describe("Banglar Biriyani Admin API & RBAC Test Suite (TDD)", () => {
  let adminCookie = ""
  let staffCookie = ""
  let customerCookie = ""
  let adminUserId: number
  let customerUserId: number

  before(async () => {
    // 1. Log in as seeded Admin
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

    // 2. Log in as seeded Staff
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

    // 3. Log in as seeded Customer
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

  after(async () => {
    // Keep pool cleanly intact for any other sequential tests
  })

  // =========================================================================
  // 1. GET /api/admin/stats
  // =========================================================================
  describe("GET /api/admin/stats", () => {
    test("Rejects unauthenticated request with HTTP 401", async () => {
      const res = await app.request("http://localhost/api/admin/stats")
      assert.equal(res.status, 401)
    })

    test("Rejects customer account with HTTP 403 Forbidden", async () => {
      const res = await app.request("http://localhost/api/admin/stats", {
        headers: { Cookie: customerCookie },
      })
      assert.equal(res.status, 403)
      const body = await res.json()
      assert.equal(body.error.code, "FORBIDDEN")
    })

    test("Allows staff and admin to fetch aggregated dashboard stats (HTTP 200)", async () => {
      const res = await app.request("http://localhost/api/admin/stats", {
        headers: { Cookie: staffCookie },
      })
      assert.equal(res.status, 200)
      const body = await res.json()
      assert.ok(body.data, "Must return data")
      assert.equal(typeof body.data.totalRevenueBdt, "number")
      assert.equal(typeof body.data.todayRevenueBdt, "number")
      assert.equal(typeof body.data.totalCustomers, "number")
      assert.ok(body.data.orderCountsByStatus, "Must return status counts")
      assert.equal(typeof body.data.orderCountsByStatus.PENDING, "number")
      assert.ok(Array.isArray(body.data.revenueByDayOfWeek))
      assert.equal(body.data.revenueByDayOfWeek.length, 7)
      assert.ok(Array.isArray(body.data.recentOrders))
    })
  })

  // =========================================================================
  // 2. GET & PUT /api/admin/schedule
  // =========================================================================
  describe("GET & PUT /api/admin/schedule", () => {
    test("Rejects unauthenticated PUT /api/admin/schedule/SATURDAY with HTTP 401", async () => {
      const res = await app.request("http://localhost/api/admin/schedule/SATURDAY", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ items: [] }),
      })
      assert.equal(res.status, 401)
    })

    test("Rejects customer account from PUT /api/admin/schedule/SATURDAY with HTTP 403", async () => {
      const res = await app.request("http://localhost/api/admin/schedule/SATURDAY", {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          Cookie: customerCookie,
        },
        body: JSON.stringify({ items: [] }),
      })
      assert.equal(res.status, 403)
    })

    test("GET /api/admin/schedule returns 7-day assignments and menu catalog (HTTP 200)", async () => {
      const res = await app.request("http://localhost/api/admin/schedule", {
        headers: { Cookie: adminCookie },
      })
      assert.equal(res.status, 200)
      const body = await res.json()
      assert.ok(body.data.days.SATURDAY)
      assert.ok(body.data.days.FRIDAY)
      assert.ok(Array.isArray(body.data.menuCatalog))
      assert.ok(Array.isArray(body.data.categories))
    })

    test("PUT /api/admin/schedule/:day syncs daily meal schedule atomically", async () => {
      // Pick first 2 items from catalog
      const catRes = await app.request("http://localhost/api/admin/schedule", {
        headers: { Cookie: adminCookie },
      })
      const catBody = await catRes.json()
      const item1 = catBody.data.menuCatalog[0]
      const item2 = catBody.data.menuCatalog[1]

      const putRes = await app.request("http://localhost/api/admin/schedule/WEDNESDAY", {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          Cookie: adminCookie,
        },
        body: JSON.stringify({
          assignments: [
            {
              menuItemId: item1.id,
              specialPriceBdt: 420,
              dailyQuota: 150,
              isFeatured: true,
            },
            {
              menuItemId: item2.id,
              specialPriceBdt: null,
              dailyQuota: 80,
              isFeatured: false,
            },
          ],
        }),
      })

      assert.equal(putRes.status, 200)
      const putBody = await putRes.json()
      assert.equal(putBody.data.day, "WEDNESDAY")
      assert.equal(putBody.data.assignments.length, 2)
      const updatedItem1 = putBody.data.assignments.find((a: any) => a.menuItemId === item1.id)
      assert.ok(updatedItem1, "Must find updated item 1")
      assert.equal(updatedItem1.specialPriceBdt, 420)
    })
  })

  // =========================================================================
  // 3. POST, PATCH, DELETE /api/admin/menu
  // =========================================================================
  describe("Menu Management (POST, PATCH, DELETE)", () => {
    let createdDishId: number

    test("POST /api/admin/menu blocks staff from creating dishes (HTTP 403)", async () => {
      const res = await app.request("http://localhost/api/admin/menu", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: staffCookie,
        },
        body: JSON.stringify({
          name: "Unauthorized Dish",
          description: "Chef trying to add dish directly without admin approval",
          basePriceBdt: 500,
          imageUrl: "https://images.unsplash.com/photo-1589302168068-964664d93dc0",
        }),
      })
      assert.equal(res.status, 403)
    })

    test("POST /api/admin/menu allows Admin to create a new dish (HTTP 201)", async () => {
      const res = await app.request("http://localhost/api/admin/menu", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: adminCookie,
        },
        body: JSON.stringify({
          categoryName: "Dhakaiya Specialties",
          name: "Special Puran Dhaka Morog Kacchi",
          description: "Aromatic chinigura rice with tender chicken, alu bokhara, and pure ghee.",
          basePriceBdt: 390,
          imageUrl: "https://images.unsplash.com/photo-1589302168068-964664d93dc0",
          portionSize: "1:1 Large",
          spiceLevel: "Medium Hot",
          isEveryday: false,
          isAvailable: true,
          initialDays: ["MONDAY", "WEDNESDAY"],
        }),
      })

      assert.equal(res.status, 201)
      const body = await res.json()
      assert.ok(body.data.menuItem.id)
      assert.equal(body.data.menuItem.name, "Special Puran Dhaka Morog Kacchi")
      createdDishId = body.data.menuItem.id
    })

    test("PATCH /api/admin/menu/:id allows Staff to update price and availability", async () => {
      const res = await app.request(`http://localhost/api/admin/menu/${createdDishId}`, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          Cookie: staffCookie,
        },
        body: JSON.stringify({
          basePriceBdt: 410,
          isAvailable: true,
          description: "Updated chef description with saffron infusion",
        }),
      })

      assert.equal(res.status, 200)
      const body = await res.json()
      assert.equal(body.data.menuItem.basePriceBdt, 410)
    })

    test("DELETE /api/admin/menu/:id allows Admin to delete newly created un-ordered dish", async () => {
      const res = await app.request(`http://localhost/api/admin/menu/${createdDishId}`, {
        method: "DELETE",
        headers: { Cookie: adminCookie },
      })

      assert.equal(res.status, 200)
      const body = await res.json()
      assert.equal(body.data.id, createdDishId)
    })
  })

  // =========================================================================
  // 4. GET /api/admin/orders & PATCH /api/admin/orders/:id/status
  // =========================================================================
  describe("Orders Administration", () => {
    let orderToUpdate: any

    test("Customer cannot access GET /api/admin/orders (HTTP 403)", async () => {
      const res = await app.request("http://localhost/api/admin/orders", {
        headers: { Cookie: customerCookie },
      })
      assert.equal(res.status, 403)
    })

    test("Customer cannot update order status via PATCH /api/admin/orders/:id/status (HTTP 403)", async () => {
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

    test("GET /api/admin/orders filters orders and returns line items", async () => {
      const res = await app.request("http://localhost/api/admin/orders?limit=10", {
        headers: { Cookie: staffCookie },
      })
      assert.equal(res.status, 200)
      const body = await res.json()
      assert.ok(Array.isArray(body.data))
      assert.ok(body.data.length > 0)
      orderToUpdate = body.data[0].order
      assert.ok(orderToUpdate.orderNumber)
      assert.ok(Array.isArray(body.data[0].items))
    })

    test("PATCH /api/admin/orders/:id/status updates status and logs to audit_logs", async () => {
      const res = await app.request(
        `http://localhost/api/admin/orders/${orderToUpdate.id}/status`,
        {
          method: "PATCH",
          headers: {
            "Content-Type": "application/json",
            Cookie: staffCookie,
          },
          body: JSON.stringify({
            status: "PREPARING",
            notes: "Kitchen started preparing meal order",
          }),
        },
      )

      assert.equal(res.status, 200)
      const body = await res.json()
      assert.equal(body.data.order.status, "PREPARING")

      // Verify audit log entry exists in DB
      const [log] = await db
        .select()
        .from(auditLogs)
        .where(eq(auditLogs.entityId, String(orderToUpdate.id)))
        .orderBy(desc(auditLogs.createdAt))
        .limit(1)

      assert.ok(log, "Audit log must be registered")
      assert.equal(log.action, "UPDATE_ORDER_STATUS")
    })

    test("Customer cannot verify payment via PATCH /api/admin/orders/:id/verify-payment (HTTP 403)", async () => {
      const res = await app.request(
        `http://localhost/api/admin/orders/${orderToUpdate.id}/verify-payment`,
        {
          method: "PATCH",
          headers: {
            "Content-Type": "application/json",
            Cookie: customerCookie,
          },
          body: JSON.stringify({ isVerified: true }),
        },
      )
      assert.equal(res.status, 403)
    })

    test("Staff can toggle order payment verification and record audit log (HTTP 200)", async () => {
      const res = await app.request(
        `http://localhost/api/admin/orders/${orderToUpdate.id}/verify-payment`,
        {
          method: "PATCH",
          headers: {
            "Content-Type": "application/json",
            Cookie: staffCookie,
          },
          body: JSON.stringify({ isVerified: true }),
        },
      )

      assert.equal(res.status, 200)
      const body = await res.json()
      assert.equal(body.data.order.isPaymentVerified, true)

      // Verify audit log entry
      const [log] = await db
        .select()
        .from(auditLogs)
        .where(
          and(
            eq(auditLogs.entityId, String(orderToUpdate.id)),
            eq(auditLogs.action, "VERIFY_PAYMENT"),
          ),
        )
        .orderBy(desc(auditLogs.createdAt))
        .limit(1)

      assert.ok(log, "Audit log must be registered for VERIFY_PAYMENT")
      assert.equal(log.action, "VERIFY_PAYMENT")
    })
  })

  // =========================================================================
  // 5. GET /api/admin/users & PATCH /api/admin/users/:id/role
  // =========================================================================
  describe("Users Administration (ADMIN ONLY)", () => {
    test("Staff cannot access /api/admin/users (HTTP 403)", async () => {
      const res = await app.request("http://localhost/api/admin/users", {
        headers: { Cookie: staffCookie },
      })
      assert.equal(res.status, 403)
    })

    test("GET /api/admin/users lists all users with order count and total spend", async () => {
      const res = await app.request("http://localhost/api/admin/users", {
        headers: { Cookie: adminCookie },
      })
      assert.equal(res.status, 200)
      const body = await res.json()
      assert.ok(Array.isArray(body.data))
      const foundCustomer = body.data.find((u: any) => u.id === customerUserId)
      assert.ok(foundCustomer)
      assert.equal(typeof foundCustomer.orderCount, "number")
      assert.equal(typeof foundCustomer.totalSpendBdt, "number")
      assert.equal(foundCustomer.passwordHash, undefined, "passwordHash must NEVER be exposed")
    })

    test("Safety Guardrail: Admin CANNOT demote their own account role (HTTP 403)", async () => {
      const res = await app.request(`http://localhost/api/admin/users/${adminUserId}/role`, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          Cookie: adminCookie,
        },
        body: JSON.stringify({
          role: "CUSTOMER",
        }),
      })

      assert.equal(res.status, 403)
      const body = await res.json()
      assert.equal(body.error.code, "FORBIDDEN")
    })

    test("Safety Guardrail: Admin CANNOT deactivate their own account (HTTP 403)", async () => {
      const res = await app.request(`http://localhost/api/admin/users/${adminUserId}/role`, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          Cookie: adminCookie,
        },
        body: JSON.stringify({
          isActive: false,
        }),
      })

      assert.equal(res.status, 403)
      const body = await res.json()
      assert.equal(body.error.code, "FORBIDDEN")
    })

    test("Admin can promote or update another customer's role", async () => {
      const res = await app.request(`http://localhost/api/admin/users/${customerUserId}/role`, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          Cookie: adminCookie,
        },
        body: JSON.stringify({
          role: "STAFF",
        }),
      })

      assert.equal(res.status, 200)
      const body = await res.json()
      assert.equal(body.data.user.role, "STAFF")

      // Revert back to CUSTOMER for clean state
      await app.request(`http://localhost/api/admin/users/${customerUserId}/role`, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          Cookie: adminCookie,
        },
        body: JSON.stringify({
          role: "CUSTOMER",
        }),
      })
    })
  })
})
