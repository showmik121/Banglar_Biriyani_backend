import { test, describe, beforeAll, afterAll, beforeEach, expect } from "vitest"
import fs from "node:fs"
import path from "node:path"
import { app } from "../../server/index.js"
import { pool, db, orders, orderItems, dailyMenuSchedules } from "../../src/db/index.js"
import { eq, and } from "drizzle-orm"
import { resetRateLimits } from "../../server/middleware/rateLimiter.js"

describe("Banglar Biriyani API & Security Test Suite (TDD)", () => {
  afterAll(async () => {
    // Graceful teardown of pool connection
    await pool.end()
  })

  // =========================================================================
  // 1. Security & Environment Audits
  // =========================================================================
  describe("Security Checklist & Secrets Management", () => {
    test(".gitignore exists and ignores .env and .env.local", () => {
      const gitignorePath = path.resolve(process.cwd(), ".gitignore")
      expect(fs.existsSync(gitignorePath)).toBe(true)
      const content = fs.readFileSync(gitignorePath, "utf-8")
      const lines = content.split(/\r?\n/).map((l) => l.trim())
      expect(lines.includes(".env")).toBe(true)
      expect(lines.some((l) => l.includes(".env"))).toBe(true)
    })

    test("No Neon credentials (DATABASE_URL) are bundled or referenced in src/ client files", () => {
      const srcDir = path.resolve(process.cwd(), "src")
      const files: string[] = []

      function scan(dir: string) {
        for (const item of fs.readdirSync(dir)) {
          const fullPath = path.join(dir, item)
          const stat = fs.statSync(fullPath)
          if (stat.isDirectory()) {
            if (fullPath.endsWith(path.join("src", "db"))) continue
            scan(fullPath)
          } else if (/\.(tsx?|jsx?|html|css)$/.test(item)) {
            files.push(fullPath)
          }
        }
      }

      scan(srcDir)

      for (const file of files) {
        const text = fs.readFileSync(file, "utf-8")
        expect(text.includes("DATABASE_URL")).toBe(false)
        expect(text.includes("@neondatabase/serverless")).toBe(false)
      }
    })
  })

  // =========================================================================
  // 2. GET /api/menu/:day for all 7 days (SATURDAY through FRIDAY)
  // =========================================================================
  describe("GET /api/menu/:day for all 7 days", () => {
    const ALL_DAYS = [
      "SATURDAY",
      "SUNDAY",
      "MONDAY",
      "TUESDAY",
      "WEDNESDAY",
      "THURSDAY",
      "FRIDAY",
    ] as const

    for (const day of ALL_DAYS) {
      test(
        `GET /api/menu/${day} returns 200 with day-specific items and everyday staples`,
        { timeout: 30000 },
        async () => {
          const res = await app.request(`/api/menu/${day}`)
          expect(res.status).toBe(200)

          const body = await res.json()
          expect(body.data).toBeDefined()
          expect(body.data.day).toBe(day)
          expect(Array.isArray(body.data.items)).toBe(true)
          expect(body.data.items.length).toBeGreaterThan(0)

          // Verify deduplication and item integrity
          const seenIds = new Set<number>()
          for (const item of body.data.items) {
            expect(item.id).toBeDefined()
            expect(seenIds.has(item.id)).toBe(false)
            seenIds.add(item.id)

            expect(typeof item.name).toBe("string")
            expect(typeof item.priceBdt).toBe("number")
            expect(item.priceBdt).toBeGreaterThan(0)
            expect(typeof item.remainingPortions).toBe("number")
            expect(item.remainingPortions).toBeGreaterThanOrEqual(0)
          }

          // Verify presence of everyday staple items (e.g., Borhani, Firni, or Kebabs)
          const everydayItems = body.data.items.filter((i: any) => i.isEveryday)
          expect(everydayItems.length).toBeGreaterThan(0)
        },
      )
    }

    test("Case-Insensitive Day Parameter: /api/menu/saturday and /api/menu/Saturday work cleanly", async () => {
      const lowerRes = await app.request("/api/menu/saturday")
      expect(lowerRes.status).toBe(200)
      const lowerJson = await lowerRes.json()
      expect(lowerJson.data.day).toBe("SATURDAY")

      const mixedRes = await app.request("/api/menu/Saturday")
      expect(mixedRes.status).toBe(200)
      const mixedJson = await mixedRes.json()
      expect(mixedJson.data.day).toBe("SATURDAY")
    })

    test("GET /api/menu/INVALID_DAY returns HTTP 400 with descriptive error", async () => {
      const res = await app.request("/api/menu/INVALID_DAY")
      expect(res.status).toBe(400)
      const body = await res.json()
      expect(body.error?.code).toBe("INVALID_DAY")
    })
  })

  // =========================================================================
  // 3. POST /api/orders validation & persistence
  // =========================================================================
  describe("POST /api/orders validation and persistence", () => {
    let validSaturdayItemId = 1
    let saturdayItemQuota = 100
    let saturdayItemRemaining = 100

    beforeAll(async () => {
      const menuRes = await app.request("/api/menu/SATURDAY")
      const menuJson = await menuRes.json()
      if (menuJson.data?.items?.length > 0) {
        const scheduledDish =
          menuJson.data.items.find((i: any) => !i.isEveryday) || menuJson.data.items[0]
        validSaturdayItemId = scheduledDish.id
        saturdayItemQuota = 500
        saturdayItemRemaining = 500

        // Reset soldCount to 0 and ensure ample quota for tests
        await db
          .update(dailyMenuSchedules)
          .set({ soldCount: 0, dailyQuota: 500 })
          .where(
            and(
              eq(dailyMenuSchedules.menuItemId, validSaturdayItemId),
              eq(dailyMenuSchedules.dayOfWeek, "SATURDAY"),
            ),
          )
      }
    })

    beforeEach(() => {
      resetRateLimits()
    })

    test("Rejects malformed JSON body with HTTP 400", async () => {
      const res = await app.request("/api/orders", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "NOT_VALID_JSON{",
      })
      expect(res.status).toBe(400)
      const json = await res.json()
      expect(json.error?.code).toBe("INVALID_JSON")
    })

    test("Rejects empty cart with HTTP 422", async () => {
      const res = await app.request("/api/orders", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          customerName: "Rahim Chowdhury",
          customerPhone: "01712345678",
          customerAddress: "Road 10, Dhanmondi, Dhaka",
          scheduledDay: "SATURDAY",
          items: [],
        }),
      })

      expect(res.status).toBe(422)
      const json = await res.json()
      expect(json.error?.code).toBe("VALIDATION_ERROR")
    })

    test("Rejects negative or zero quantity with HTTP 422", async () => {
      const resNegative = await app.request("/api/orders", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          customerName: "Rahim Chowdhury",
          customerPhone: "01712345678",
          customerAddress: "Road 10, Dhanmondi, Dhaka",
          scheduledDay: "SATURDAY",
          items: [{ menuItemId: validSaturdayItemId, quantity: -2 }],
        }),
      })
      expect(resNegative.status).toBe(422)

      const resZero = await app.request("/api/orders", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          customerName: "Rahim Chowdhury",
          customerPhone: "01712345678",
          customerAddress: "Road 10, Dhanmondi, Dhaka",
          scheduledDay: "SATURDAY",
          items: [{ menuItemId: validSaturdayItemId, quantity: 0 }],
        }),
      })
      expect(resZero.status).toBe(422)
    })

    test("Rejects non-integer quantity with HTTP 422", async () => {
      const res = await app.request("/api/orders", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          customerName: "Rahim Chowdhury",
          customerPhone: "01712345678",
          customerAddress: "Road 10, Dhanmondi, Dhaka",
          scheduledDay: "SATURDAY",
          items: [{ menuItemId: validSaturdayItemId, quantity: 2.5 }],
        }),
      })
      expect(res.status).toBe(422)
    })

    test("Rejects non-existent menuItemId with HTTP 404", async () => {
      const res = await app.request("/api/orders", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          customerName: "Rahim Chowdhury",
          customerPhone: "01712345678",
          customerAddress: "Road 10, Dhanmondi, Dhaka",
          scheduledDay: "SATURDAY",
          items: [{ menuItemId: 999999, quantity: 1 }],
        }),
      })

      expect(res.status).toBe(404)
      const json = await res.json()
      expect(json.error?.code).toBe("ITEM_NOT_FOUND")
    })

    test("Enforces Daily Quota: Rejects order exceeding remaining stock with HTTP 422", async () => {
      // Set quota to 10 and soldCount to 8 (remaining = 2) for testing
      await db
        .update(dailyMenuSchedules)
        .set({ dailyQuota: 10, soldCount: 8 })
        .where(
          and(
            eq(dailyMenuSchedules.menuItemId, validSaturdayItemId),
            eq(dailyMenuSchedules.dayOfWeek, "SATURDAY"),
          ),
        )

      // Attempt to order 3 portions (exceeds remaining 2)
      const res = await app.request("/api/orders", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          customerName: "Greedy Customer",
          customerPhone: "01712345678",
          customerAddress: "Road 1, Dhanmondi, Dhaka",
          scheduledDay: "SATURDAY",
          items: [{ menuItemId: validSaturdayItemId, quantity: 3 }],
        }),
      })

      expect(res.status).toBe(422)
      const json = await res.json()
      expect(json.error?.code).toBe("QUOTA_EXCEEDED")
      expect(json.error?.message).toMatch(/Only 2 portions of .* left for SATURDAY/)

      // Restore ample quota for subsequent tests
      await db
        .update(dailyMenuSchedules)
        .set({ dailyQuota: 500, soldCount: 0 })
        .where(
          and(
            eq(dailyMenuSchedules.menuItemId, validSaturdayItemId),
            eq(dailyMenuSchedules.dayOfWeek, "SATURDAY"),
          ),
        )
    })

    const invalidPhones = [
      "12345",
      "01212345678",
      "0171234567890",
      "01712-345678",
      "+15551234567",
      "abcdefghijk",
    ]

    for (const phone of invalidPhones) {
      test(`Rejects invalid BD phone "${phone}" with HTTP 422`, async () => {
        const res = await app.request("/api/orders", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            customerName: "Test Customer",
            customerPhone: phone,
            customerAddress: "Gulshan-2, Dhaka",
            scheduledDay: "SATURDAY",
            items: [{ menuItemId: validSaturdayItemId, quantity: 1 }],
          }),
        })

        expect(res.status).toBe(422)
      })
    }

    test("Accepts case-insensitive scheduledDay (e.g. 'saturday') and normalizes to 'SATURDAY'", async () => {
      const res = await app.request("/api/orders", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          customerName: "Case Insensitive User",
          customerPhone: "01711223344",
          customerAddress: "Banani 11, Dhaka",
          scheduledDay: "saturday",
          paymentMethod: "COD",
          items: [{ menuItemId: validSaturdayItemId, quantity: 1 }],
        }),
      })

      expect(res.status).toBe(201)
      const json = await res.json()
      expect(json.data.order.scheduledDay).toBe("SATURDAY")
    })

    test(
      "Persists valid order into Neon PostgreSQL with subtotalBdt + 60 = totalBdt",
      { timeout: 30000 },
      async () => {
        const validPayload = {
          customerName: "Tamim Iqbal",
          customerPhone: "01812345678",
          customerAddress: "House 45, Road 11, Banani, Dhaka",
          scheduledDay: "SATURDAY",
          deliverySlot: "Dinner (7:30 PM - 8:30 PM)",
          paymentMethod: "COD",
          notes: "Ring the doorbell twice",
          items: [{ menuItemId: validSaturdayItemId, quantity: 2 }],
        }

        const res = await app.request("/api/orders", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Forwarded-For": "192.168.1.101",
          },
          body: JSON.stringify(validPayload),
        })

        expect(res.status).toBe(201)
        const json = await res.json()
        expect(json.data?.order).toBeDefined()
        expect(json.data.order.orderNumber.startsWith("BB-")).toBe(true)
        expect(json.data.order.customerPhone).toBe("01812345678")
        expect(json.data.order.deliveryFeeBdt).toBe(60)
        expect(json.data.order.totalBdt).toBe(json.data.order.subtotalBdt + 60)

        // Query database directly to confirm persistence
        const [dbOrder] = await db
          .select()
          .from(orders)
          .where(eq(orders.orderNumber, json.data.order.orderNumber))

        expect(dbOrder).toBeDefined()
        expect(dbOrder.customerName).toBe("Tamim Iqbal")
        expect(dbOrder.totalBdt).toBe(json.data.order.totalBdt)

        // Confirm order items were persisted
        const dbItems = await db.select().from(orderItems).where(eq(orderItems.orderId, dbOrder.id))

        expect(dbItems.length).toBe(1)
        expect(dbItems[0].menuItemId).toBe(validSaturdayItemId)
        expect(dbItems[0].quantity).toBe(2)
      },
    )

    test("Rejects BKASH payment without paymentTrxId with HTTP 422", async () => {
      const res = await app.request("/api/orders", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          customerName: "Bkash Customer",
          customerPhone: "01712345678",
          customerAddress: "Dhanmondi, Dhaka",
          scheduledDay: "SATURDAY",
          paymentMethod: "BKASH",
          items: [{ menuItemId: validSaturdayItemId, quantity: 1 }],
        }),
      })

      expect(res.status).toBe(422)
      const json = await res.json()
      expect(json.error?.details?.paymentTrxId).toBeDefined()
    })

    test(
      "Persists BKASH order with valid paymentTrxId and isPaymentVerified = false",
      { timeout: 30000 },
      async () => {
        const res = await app.request("/api/orders", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            customerName: "Bkash Verified Customer",
            customerPhone: "01712345678",
            customerAddress: "Banani, Dhaka",
            scheduledDay: "SATURDAY",
            paymentMethod: "BKASH",
            paymentTrxId: "BKASH-9J4K2L8M",
            items: [{ menuItemId: validSaturdayItemId, quantity: 1 }],
          }),
        })

        expect(res.status).toBe(201)
        const json = await res.json()
        expect(json.data.order.paymentTrxId).toBe("BKASH-9J4K2L8M")
        expect(json.data.order.isPaymentVerified).toBe(false)
      },
    )
  })

  // =========================================================================
  // 4. Client Price Tampering Resistance
  // =========================================================================
  describe("Price Tampering Resistance", () => {
    beforeEach(() => {
      resetRateLimits()
    })
    test(
      "Tampering with prices in client payload does NOT alter subtotalBdt or totalBdt",
      { timeout: 30000 },
      async () => {
        const menuRes = await app.request("/api/menu/SATURDAY")
        const menuJson = await menuRes.json()
        const item = menuJson.data.items[0]
        const authenticPrice = item.priceBdt

        // Attempt attack: inject subtotalBdt = 1, totalBdt = 1, price = 1
        const tamperedPayload = {
          customerName: "Attacker User",
          customerPhone: "01912345678",
          customerAddress: "Sector 3, Uttara, Dhaka",
          scheduledDay: "SATURDAY",
          subtotalBdt: 1,
          totalBdt: 1,
          deliveryFeeBdt: 0,
          items: [
            {
              menuItemId: item.id,
              quantity: 3,
              unitPriceBdt: 1,
              price: 1,
              lineTotalBdt: 3,
            },
          ],
        }

        const res = await app.request("/api/orders", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Forwarded-For": "192.168.1.102",
          },
          body: JSON.stringify(tamperedPayload),
        })

        expect(res.status).toBe(201)
        const json = await res.json()
        const createdOrder = json.data.order

        const expectedSubtotal = authenticPrice * 3
        const expectedTotal = expectedSubtotal + 60

        expect(createdOrder.subtotalBdt).toBe(expectedSubtotal)
        expect(createdOrder.totalBdt).toBe(expectedTotal)
        expect(createdOrder.deliveryFeeBdt).toBe(60)
      },
    )
  })

  // =========================================================================
  // 5. Input Sanitization
  // =========================================================================
  describe("Input Sanitization on POST /api/orders", () => {
    beforeEach(() => {
      resetRateLimits()
    })
    test(
      "Sanitizes HTML / script tags from customerName, customerAddress, and notes",
      { timeout: 30000 },
      async () => {
        const menuRes = await app.request("/api/menu/SATURDAY")
        const menuJson = await menuRes.json()
        const itemId = menuJson.data.items[0].id

        const xssPayload = {
          customerName: "<script>alert('xss')</script>Mushfiqur Rahim",
          customerPhone: "01799887766",
          customerAddress: "House 10 <img src=x onerror=alert(1)>, Dhanmondi",
          scheduledDay: "SATURDAY",
          notes: "<b>Extra spoons</b> <script>stealCookies()</script>",
          items: [{ menuItemId: itemId, quantity: 1 }],
        }

        const res = await app.request("/api/orders", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Forwarded-For": "192.168.10.50",
          },
          body: JSON.stringify(xssPayload),
        })

        expect(res.status).toBe(201)
        const json = await res.json()
        const order = json.data.order

        expect(order.customerName.includes("<script>")).toBe(false)
        expect(order.customerName.includes("Mushfiqur Rahim")).toBe(true)
        expect(order.customerAddress.includes("<img")).toBe(false)
        expect(order.notes?.includes("<script>")).toBe(false)
        expect(order.notes?.includes("<b>")).toBe(false)

        // Verify in database directly
        const [dbOrder] = await db
          .select()
          .from(orders)
          .where(eq(orders.orderNumber, order.orderNumber))

        expect(dbOrder.customerName.includes("<script>")).toBe(false)
        expect(dbOrder.customerAddress.includes("<img")).toBe(false)
        expect(dbOrder.notes?.includes("<script>")).toBe(false)
      },
    )
  })

  // =========================================================================
  // 6. Rate Limiting Middleware
  // =========================================================================
  describe("Rate-Limiting on POST /api/orders", () => {
    beforeEach(() => {
      resetRateLimits()
    })

    test(
      "Enforces max 10 order submissions per IP per 15 minutes",
      { timeout: 60000 },
      async () => {
        const menuRes = await app.request("/api/menu/SATURDAY")
        const menuJson = await menuRes.json()
        const itemId = menuJson.data.items[0].id

        const rateLimitIp = "10.0.0.99"

        const submitOrder = async () => {
          return await app.request("/api/orders", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "X-Forwarded-For": rateLimitIp,
            },
            body: JSON.stringify({
              customerName: "Rate Limit Tester",
              customerPhone: "01711223344",
              customerAddress: "Mohakhali, Dhaka",
              scheduledDay: "SATURDAY",
              items: [{ menuItemId: itemId, quantity: 1 }],
            }),
          })
        }

        // Submit 10 orders (allowed limit)
        for (let i = 1; i <= 10; i++) {
          const res = await submitOrder()
          expect(res.status).toBe(201)
        }

        // 11th order must be blocked by rate limiter with HTTP 429
        const blockedRes = await submitOrder()
        expect(blockedRes.status).toBe(429)

        const blockedJson = await blockedRes.json()
        expect(blockedJson.error?.code).toBe("RATE_LIMIT_EXCEEDED")

        // A different IP should NOT be blocked
        const differentIpRes = await app.request("/api/orders", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Forwarded-For": "10.0.0.100",
          },
          body: JSON.stringify({
            customerName: "Different User",
            customerPhone: "01711223355",
            customerAddress: "Gulshan, Dhaka",
            scheduledDay: "SATURDAY",
            items: [{ menuItemId: itemId, quantity: 1 }],
          }),
        })

        expect(differentIpRes.status).toBe(201)
      },
    )

    test("Allows ordering any 'Our Menu' item (such as Special Chicken Tehari) on FRIDAY without day restriction", async () => {
      const res = await app.request("/api/orders", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Forwarded-For": "10.0.0.105",
        },
        body: JSON.stringify({
          customerName: "Friday Tehari Lover",
          customerPhone: "01711223366",
          customerAddress: "Dhanmondi, Dhaka",
          scheduledDay: "FRIDAY",
          items: [{ menuItemId: 8, quantity: 1 }], // Special Chicken Tehari (ID 8)
        }),
      })

      expect(res.status).toBe(201)
      const json = await res.json()
      expect(json.data.order.orderNumber).toMatch(/^BB-\d{8}-\d+$/)
      expect(json.data.order.scheduledDay).toBe("FRIDAY")
      expect(json.data.items[0].itemNameSnapshot).toBe("Special Chicken Tehari")
      expect(json.data.items[0].unitPriceBdt).toBe(320)
    })
  })
})
