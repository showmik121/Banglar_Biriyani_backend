import { Hono } from "hono"
import { db, auditLogs } from "../../src/db/index.js"
import { requireAuth, requireRole } from "../middleware/authMiddleware.js"
import { mealWindowsSchema } from "../validators/settingsSchema.js"
import { getMealWindows, saveMealWindows } from "../utils/mealSettings.js"

/** GET /api/meal-hours: when same-day lunch and dinner orders are taken (Bangladesh time) */
export const publicSettingsRouter = new Hono()
publicSettingsRouter.get("/meal-hours", async (c) => {
  c.header("Cache-Control", "no-store")
  return c.json({ data: await getMealWindows() })
})

// Admin: reading ADMIN and STAFF, changing ADMIN only
export const adminSettingsRouter = new Hono()
adminSettingsRouter.use("*", requireAuth)

adminSettingsRouter.get("/meal-hours", requireRole(["ADMIN", "STAFF"]), async (c) => {
  c.header("Cache-Control", "no-store")
  return c.json({ data: await getMealWindows() })
})

adminSettingsRouter.put("/meal-hours", requireRole(["ADMIN"]), async (c) => {
  const body = await c.req.json().catch(() => null)
  const parsed = mealWindowsSchema.safeParse(body)
  if (!parsed.success) {
    return c.json(
      {
        error: {
          code: "VALIDATION_ERROR",
          message: "Please check the order hours",
          details: parsed.error.flatten().fieldErrors,
        },
      },
      422,
    )
  }
  await saveMealWindows(parsed.data)
  const user = c.get("user") as { id: number } | undefined
  await db.insert(auditLogs).values({
    actorId: user?.id ?? null,
    action: "UPDATE_MEAL_HOURS",
    entityType: "SETTING",
    entityId: "meal_windows",
    metadataJson: JSON.stringify(parsed.data),
  })
  return c.json({ data: parsed.data })
})
