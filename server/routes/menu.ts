import { Hono } from "hono"
import { eq, and, asc, desc } from "drizzle-orm"
import { db, categories, menuItems, dailyMenuSchedules } from "../../src/db/index.js"

export const VALID_DAYS = [
  "SATURDAY",
  "SUNDAY",
  "MONDAY",
  "TUESDAY",
  "WEDNESDAY",
  "THURSDAY",
  "FRIDAY",
] as const

export type ValidDay = (typeof VALID_DAYS)[number]

/** How many special meals each day shows. Admins pick them in the admin panel (Meals tab). */
export const MEALS_PER_DAY = 3

export function normalizeDay(input?: string | null): ValidDay | null {
  if (!input) return null
  const upper = input.trim().toUpperCase()
  if ((VALID_DAYS as readonly string[]).includes(upper)) {
    return upper as ValidDay
  }
  return null
}

/**
 * Fetch menu items for a specific day:
 * 1. Items assigned in daily_menu_schedules for that day
 * 2. Everyday staple items (is_everyday = true)
 * Deduplicated by ID, with authoritative priceBdt (specialPriceBdt ?? basePriceBdt)
 */
export async function getMenuItemsForDay(day: ValidDay) {
  // 1. Items scheduled for this day
  const scheduled = await db
    .select({
      id: menuItems.id,
      categoryId: menuItems.categoryId,
      categoryName: categories.name,
      categorySlug: categories.slug,
      name: menuItems.name,
      description: menuItems.description,
      basePriceBdt: menuItems.basePriceBdt,
      specialPriceBdt: dailyMenuSchedules.specialPriceBdt,
      imageUrl: menuItems.imageUrl,
      portionSize: menuItems.portionSize,
      spiceLevel: menuItems.spiceLevel,
      rating: menuItems.rating,
      isEveryday: menuItems.isEveryday,
      isAvailable: menuItems.isAvailable,
      isFeatured: dailyMenuSchedules.isFeatured,
      dailyQuota: dailyMenuSchedules.dailyQuota,
      soldCount: dailyMenuSchedules.soldCount,
      categorySortOrder: categories.sortOrder,
    })
    .from(dailyMenuSchedules)
    .innerJoin(menuItems, eq(dailyMenuSchedules.menuItemId, menuItems.id))
    .innerJoin(categories, eq(menuItems.categoryId, categories.id))
    .where(and(eq(dailyMenuSchedules.dayOfWeek, day), eq(menuItems.isAvailable, true)))
    .orderBy(categories.sortOrder, menuItems.id)

  // 2. Everyday items (Borhani, Firni, Kebabs, etc.)
  const everyday = await db
    .select({
      id: menuItems.id,
      categoryId: menuItems.categoryId,
      categoryName: categories.name,
      categorySlug: categories.slug,
      name: menuItems.name,
      description: menuItems.description,
      basePriceBdt: menuItems.basePriceBdt,
      imageUrl: menuItems.imageUrl,
      portionSize: menuItems.portionSize,
      spiceLevel: menuItems.spiceLevel,
      rating: menuItems.rating,
      isEveryday: menuItems.isEveryday,
      isAvailable: menuItems.isAvailable,
      categorySortOrder: categories.sortOrder,
    })
    .from(menuItems)
    .innerJoin(categories, eq(menuItems.categoryId, categories.id))
    .where(eq(menuItems.isAvailable, true)) // every available dish is on the menu every day
    .orderBy(categories.sortOrder, menuItems.id)

  // Combine items without duplicate IDs
  const seenIds = new Set<number>()
  const combined = []

  for (const item of scheduled) {
    if (!seenIds.has(item.id)) {
      seenIds.add(item.id)
      const quota = item.dailyQuota ?? 100
      const sold = item.soldCount ?? 0
      const remainingPortions = Math.max(0, quota - sold)
      combined.push({
        ...item,
        dailyQuota: quota,
        soldCount: sold,
        remainingPortions,
        priceBdt: item.specialPriceBdt ?? item.basePriceBdt,
      })
    }
  }

  for (const item of everyday) {
    if (!seenIds.has(item.id)) {
      seenIds.add(item.id)
      combined.push({
        ...item,
        specialPriceBdt: null,
        isFeatured: false,
        dailyQuota: 200,
        soldCount: 0,
        remainingPortions: 200,
        priceBdt: item.basePriceBdt,
      })
    }
  }

  return combined
}

/**
 * The special meals chosen for one day (at most MEALS_PER_DAY), day specials first.
 */
export async function getMealsForDay(day: ValidDay) {
  const rows = await db
    .select({
      id: menuItems.id,
      categoryId: menuItems.categoryId,
      categoryName: categories.name,
      categorySlug: categories.slug,
      name: menuItems.name,
      description: menuItems.description,
      basePriceBdt: menuItems.basePriceBdt,
      specialPriceBdt: dailyMenuSchedules.specialPriceBdt,
      imageUrl: menuItems.imageUrl,
      portionSize: menuItems.portionSize,
      spiceLevel: menuItems.spiceLevel,
      rating: menuItems.rating,
      isEveryday: menuItems.isEveryday,
      isAvailable: menuItems.isAvailable,
      isFeatured: dailyMenuSchedules.isFeatured,
      dailyQuota: dailyMenuSchedules.dailyQuota,
      soldCount: dailyMenuSchedules.soldCount,
    })
    .from(dailyMenuSchedules)
    .innerJoin(menuItems, eq(dailyMenuSchedules.menuItemId, menuItems.id))
    .innerJoin(categories, eq(menuItems.categoryId, categories.id))
    .where(and(eq(dailyMenuSchedules.dayOfWeek, day), eq(menuItems.isAvailable, true)))
    .orderBy(desc(dailyMenuSchedules.isFeatured), asc(dailyMenuSchedules.id))
    .limit(MEALS_PER_DAY)

  return rows.map((item) => {
    const quota = item.dailyQuota ?? 100
    const sold = item.soldCount ?? 0
    return {
      ...item,
      dailyQuota: quota,
      soldCount: sold,
      remainingPortions: Math.max(0, quota - sold),
      priceBdt: item.specialPriceBdt ?? item.basePriceBdt,
    }
  })
}

/** Every available dish, for the "Our menu" section. */
export async function getCatalog() {
  const rows = await db
    .select({
      id: menuItems.id,
      categoryId: menuItems.categoryId,
      categoryName: categories.name,
      categorySlug: categories.slug,
      name: menuItems.name,
      description: menuItems.description,
      basePriceBdt: menuItems.basePriceBdt,
      imageUrl: menuItems.imageUrl,
      portionSize: menuItems.portionSize,
      spiceLevel: menuItems.spiceLevel,
      rating: menuItems.rating,
      isEveryday: menuItems.isEveryday,
      isAvailable: menuItems.isAvailable,
    })
    .from(menuItems)
    .innerJoin(categories, eq(menuItems.categoryId, categories.id))
    .where(eq(menuItems.isAvailable, true))
    .orderBy(categories.sortOrder, menuItems.id)
  return rows.map((item) => ({ ...item, priceBdt: item.basePriceBdt, isFeatured: false }))
}

export const menuRouter = new Hono()

/**
 * GET /api/menu
 * Returns all 7 days SATURDAY..FRIDAY grouped for instant client switching,
 * or filters by ?day=DAY
 */
menuRouter.get("/", async (c) => {
  try {
    const dayParam = c.req.query("day")
    if (dayParam) {
      const normalized = normalizeDay(dayParam)
      if (!normalized) {
        return c.json(
          {
            error: {
              code: "INVALID_DAY",
              message: `Invalid day '${dayParam}'. Valid options: ${VALID_DAYS.join(", ")}`,
              details: { validDays: VALID_DAYS },
            },
          },
          400,
        )
      }
      const items = await getMenuItemsForDay(normalized)
      return c.json({
        data: {
          day: normalized,
          count: items.length,
          items,
        },
      })
    }

    // Return complete 7-day schedule map
    const scheduleByDay: Record<ValidDay, any[]> = {
      SATURDAY: [],
      SUNDAY: [],
      MONDAY: [],
      TUESDAY: [],
      WEDNESDAY: [],
      THURSDAY: [],
      FRIDAY: [],
    }

    // days: the special meals chosen for each day; items: every dish for "Our menu"
    const [meals, items] = await Promise.all([Promise.all(VALID_DAYS.map((d) => getMealsForDay(d))), getCatalog()])
    VALID_DAYS.forEach((d, i) => {
      scheduleByDay[d] = meals[i]
    })

    return c.json({
      data: {
        days: scheduleByDay,
        items,
        mealsPerDay: MEALS_PER_DAY,
      },
    })
  } catch (error) {
    console.error("Error fetching menu:", error)
    return c.json(
      {
        error: {
          code: "DATABASE_ERROR",
          message: "Failed to retrieve menu data from database",
          details: error instanceof Error ? error.message : String(error),
        },
      },
      500,
    )
  }
})

/**
 * GET /api/menu/:day
 * Returns menu items for a specific day plus isEveryday: true items
 */
menuRouter.get("/:day", async (c) => {
  try {
    const dayParam = c.req.param("day")
    const normalized = normalizeDay(dayParam)

    if (!normalized) {
      return c.json(
        {
          error: {
            code: "INVALID_DAY",
            message: `Invalid day '${dayParam}'. Must be one of: ${VALID_DAYS.join(", ")}`,
            details: { validDays: VALID_DAYS },
          },
        },
        400,
      )
    }

    const items = await getMenuItemsForDay(normalized)
    return c.json({
      data: {
        day: normalized,
        count: items.length,
        items,
      },
    })
  } catch (error) {
    console.error("Error fetching day menu:", error)
    return c.json(
      {
        error: {
          code: "DATABASE_ERROR",
          message: "Failed to retrieve day menu",
          details: error instanceof Error ? error.message : String(error),
        },
      },
      500,
    )
  }
})
