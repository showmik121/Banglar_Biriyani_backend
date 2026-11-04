import { afterAll, beforeEach, describe, expect, test } from "vitest"
import { eq, and, inArray } from "drizzle-orm"
import { app } from "../../server/index.js"
import { pool, db, menuItems, dailyMenuSchedules, orders } from "../../src/db/index.js"
import { resetRateLimits } from "../../server/middleware/rateLimiter.js"
import { dhakaNow } from "../../server/utils/mealWindows.js"

const customer = {
  customerName: "Meal Tester",
  customerPhone: "01712345678",
  customerAddress: "House 1, Road 2, Dhaka",
}

const post = (body: object) =>
  app.request("/api/orders", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-forwarded-for": "198.51.100.77" },
    body: JSON.stringify({ ...customer, ...body }),
  })

describe("lunch and dinner are counted separately", () => {
  const createdOrderIds: number[] = []
  let itemId = 0
  let day: "SATURDAY" | "SUNDAY" | "MONDAY" | "TUESDAY" | "WEDNESDAY" | "THURSDAY" | "FRIDAY" = "TUESDAY"

  beforeEach(() => resetRateLimits())

  afterAll(async () => {
    if (createdOrderIds.length) await db.delete(orders).where(inArray(orders.id, createdOrderIds))
    if (itemId) {
      await db
        .delete(dailyMenuSchedules)
        .where(and(eq(dailyMenuSchedules.menuItemId, itemId), eq(dailyMenuSchedules.dayOfWeek, day)))
    }
    await pool.end()
  })

  test("ordering the dinner portion does not use up the lunch portion", async () => {
    // A dish that has no Tuesday schedule yet, so nothing real is touched
    const all = (await db.select().from(menuItems)).filter((m) => m.isAvailable)
    const schedules = await db.select().from(dailyMenuSchedules)
    const days = ["TUESDAY", "WEDNESDAY", "THURSDAY", "MONDAY", "SUNDAY", "SATURDAY", "FRIDAY"] as const
    let found: { id: number; day: (typeof days)[number] } | null = null
    for (const d of days) {
      const dish = all.find((m) => !schedules.some((s) => s.menuItemId === m.id && s.dayOfWeek === d))
      if (dish) {
        found = { id: dish.id, day: d }
        break
      }
    }
    expect(found).toBeTruthy()
    itemId = found!.id
    day = found!.day
    await db.insert(dailyMenuSchedules).values([
      { menuItemId: itemId, dayOfWeek: day, mealTime: "LUNCH", dailyQuota: 50, soldCount: 0 },
      { menuItemId: itemId, dayOfWeek: day, mealTime: "DINNER", dailyQuota: 50, soldCount: 0 },
    ])

    const res = await post({ scheduledDay: day, items: [{ menuItemId: itemId, quantity: 2, mealTime: "DINNER" }] })
    expect(res.status).toBe(201)
    const json = await res.json()
    createdOrderIds.push(json.data.order.id)

    const rows = await db
      .select()
      .from(dailyMenuSchedules)
      .where(and(eq(dailyMenuSchedules.menuItemId, itemId), eq(dailyMenuSchedules.dayOfWeek, day)))
    expect(rows.find((r) => r.mealTime === "DINNER")?.soldCount).toBe(2)
    expect(rows.find((r) => r.mealTime === "LUNCH")?.soldCount).toBe(0)
  })

  test("rejects a same-day order outside the meal's hours, when the hours rule is on", async () => {
    const now = dhakaNow()
    const closedMeal = now.hour >= 12 && now.hour < 16 ? "DINNER" : "LUNCH"
    const old = process.env.MEAL_WINDOWS
    process.env.MEAL_WINDOWS = "on"
    try {
      const res = await post({ scheduledDay: now.day, items: [{ menuItemId: itemId || 1, quantity: 1, mealTime: closedMeal }] })
      expect(res.status).toBe(422)
      const json = await res.json()
      expect(json.error.code).toBe("MEAL_CLOSED")
    } finally {
      process.env.MEAL_WINDOWS = old
    }
  })
})
