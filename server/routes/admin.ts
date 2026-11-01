import { Hono } from "hono"
import { eq, and, or, inArray, sql, desc, ilike } from "drizzle-orm"
import {
  db,
  users,
  orders,
  orderItems,
  menuItems,
  categories,
  dailyMenuSchedules,
  auditLogs,
  type dayOfWeekEnum,
  type orderStatusEnum,
  type paymentMethodEnum,
} from "../../src/db/index.js"
import { requireAuth, requireRole } from "../middleware/authMiddleware.js"
import {
  dayOfWeekEnumSchema,
  updateOrderStatusSchema,
  syncScheduleSchema,
  createMenuItemSchema,
  updateMenuItemSchema,
  updateUserRoleSchema,
} from "../validators/adminSchema.js"

export const adminRouter = new Hono()

// Apply requireAuth to all admin routes
adminRouter.use("*", requireAuth)

function slugify(text: string): string {
  return text
    .toLowerCase()
    .trim()
    .replace(/[^\w\s-]/g, "")
    .replace(/[\s_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
}

const ALL_DAYS: (typeof dayOfWeekEnum.enumValues)[number][] = [
  "SATURDAY",
  "SUNDAY",
  "MONDAY",
  "TUESDAY",
  "WEDNESDAY",
  "THURSDAY",
  "FRIDAY",
]

// =========================================================================
// 1. GET /api/admin/stats (ADMIN, STAFF)
// =========================================================================
adminRouter.get("/stats", requireRole(["ADMIN", "STAFF"]), async (c) => {
  try {
    // 1. Overall Revenue & Orders
    const [revStats] = await db
      .select({
        totalRevenueBdt: sql<number>`COALESCE(SUM(CASE WHEN ${orders.status} != 'CANCELLED' THEN ${orders.totalBdt} ELSE 0 END), 0)::int`,
        todayRevenueBdt: sql<number>`COALESCE(SUM(CASE WHEN ${orders.status} != 'CANCELLED' AND ${orders.createdAt}::date = CURRENT_DATE THEN ${orders.totalBdt} ELSE 0 END), 0)::int`,
        totalOrders: sql<number>`COUNT(*)::int`,
      })
      .from(orders)

    // 2. Order counts by status
    const statusRows = await db
      .select({
        status: orders.status,
        count: sql<number>`COUNT(*)::int`,
      })
      .from(orders)
      .groupBy(orders.status)

    const orderCountsByStatus: Record<string, number> = {
      PENDING: 0,
      CONFIRMED: 0,
      PREPARING: 0,
      OUT_FOR_DELIVERY: 0,
      DELIVERED: 0,
      CANCELLED: 0,
    }
    for (const row of statusRows) {
      orderCountsByStatus[row.status] = Number(row.count)
    }

    // 3. Revenue & Order Breakdown by Day of Week
    const dayRows = await db
      .select({
        day: orders.scheduledDay,
        orderCount: sql<number>`COUNT(*)::int`,
        revenueBdt: sql<number>`COALESCE(SUM(CASE WHEN ${orders.status} != 'CANCELLED' THEN ${orders.totalBdt} ELSE 0 END), 0)::int`,
      })
      .from(orders)
      .groupBy(orders.scheduledDay)

    const dayMap = new Map(dayRows.map((r) => [r.day, r]))
    const revenueByDayOfWeek = ALL_DAYS.map((day) => ({
      day,
      orderCount: Number(dayMap.get(day)?.orderCount || 0),
      revenueBdt: Number(dayMap.get(day)?.revenueBdt || 0),
    }))

    // 4. Total Customers Count
    const [customerCount] = await db
      .select({ count: sql<number>`COUNT(*)::int` })
      .from(users)
      .where(eq(users.role, "CUSTOMER"))

    // 5. Recent 10 Orders
    const recentOrders = await db
      .select({
        id: orders.id,
        orderNumber: orders.orderNumber,
        customerName: orders.customerName,
        customerPhone: orders.customerPhone,
        customerAddress: orders.customerAddress,
        scheduledDay: orders.scheduledDay,
        totalBdt: orders.totalBdt,
        status: orders.status,
        paymentMethod: orders.paymentMethod,
        createdAt: orders.createdAt,
      })
      .from(orders)
      .orderBy(desc(orders.createdAt))
      .limit(10)

    return c.json({
      data: {
        totalRevenueBdt: Number(revStats?.totalRevenueBdt || 0),
        todayRevenueBdt: Number(revStats?.todayRevenueBdt || 0),
        totalOrders: Number(revStats?.totalOrders || 0),
        totalCustomers: Number(customerCount?.count || 0),
        orderCountsByStatus,
        revenueByDayOfWeek,
        recentOrders,
      },
    })
  } catch (error) {
    console.error("Admin stats error:", error)
    return c.json(
      {
        error: {
          code: "STATS_ERROR",
          message: "Failed to aggregate admin statistics",
          details: error instanceof Error ? error.message : String(error),
        },
      },
      500,
    )
  }
})

// =========================================================================
// 2. GET /api/admin/schedule & PUT /api/admin/schedule/:day (ADMIN, STAFF)
// =========================================================================
adminRouter.get("/schedule", requireRole(["ADMIN", "STAFF"]), async (c) => {
  try {
    // 1. Fetch all schedules joined with menu items and category names
    const scheduleRows = await db
      .select({
        id: dailyMenuSchedules.id,
        menuItemId: dailyMenuSchedules.menuItemId,
        dayOfWeek: dailyMenuSchedules.dayOfWeek,
        specialPriceBdt: dailyMenuSchedules.specialPriceBdt,
        dailyQuota: dailyMenuSchedules.dailyQuota,
        soldCount: dailyMenuSchedules.soldCount,
        isFeatured: dailyMenuSchedules.isFeatured,
        item: {
          id: menuItems.id,
          name: menuItems.name,
          description: menuItems.description,
          basePriceBdt: menuItems.basePriceBdt,
          imageUrl: menuItems.imageUrl,
          portionSize: menuItems.portionSize,
          spiceLevel: menuItems.spiceLevel,
          rating: menuItems.rating,
          isEveryday: menuItems.isEveryday,
          isAvailable: menuItems.isAvailable,
          categoryId: menuItems.categoryId,
          categoryName: categories.name,
        },
      })
      .from(dailyMenuSchedules)
      .innerJoin(menuItems, eq(dailyMenuSchedules.menuItemId, menuItems.id))
      .innerJoin(categories, eq(menuItems.categoryId, categories.id))

    const days: Record<string, typeof scheduleRows> = {
      SATURDAY: [],
      SUNDAY: [],
      MONDAY: [],
      TUESDAY: [],
      WEDNESDAY: [],
      THURSDAY: [],
      FRIDAY: [],
    }

    for (const row of scheduleRows) {
      if (days[row.dayOfWeek]) {
        days[row.dayOfWeek].push(row)
      }
    }

    // 2. Fetch all menu items for the catalog
    const allMenuItems = await db
      .select({
        id: menuItems.id,
        name: menuItems.name,
        description: menuItems.description,
        basePriceBdt: menuItems.basePriceBdt,
        imageUrl: menuItems.imageUrl,
        portionSize: menuItems.portionSize,
        spiceLevel: menuItems.spiceLevel,
        rating: menuItems.rating,
        isEveryday: menuItems.isEveryday,
        isAvailable: menuItems.isAvailable,
        categoryId: menuItems.categoryId,
        categoryName: categories.name,
      })
      .from(menuItems)
      .innerJoin(categories, eq(menuItems.categoryId, categories.id))
      .orderBy(categories.sortOrder, menuItems.name)

    const allCategories = await db.select().from(categories).orderBy(categories.sortOrder)

    return c.json({
      data: {
        days,
        menuCatalog: allMenuItems,
        categories: allCategories,
      },
    })
  } catch (error) {
    console.error("Admin schedule get error:", error)
    return c.json(
      {
        error: {
          code: "SCHEDULE_FETCH_FAILED",
          message: "Failed to retrieve schedules",
          details: error instanceof Error ? error.message : String(error),
        },
      },
      500,
    )
  }
})

adminRouter.put("/schedule/:day", requireRole(["ADMIN", "STAFF"]), async (c) => {
  const dayParam = c.req.param("day").toUpperCase()
  const dayParsed = dayOfWeekEnumSchema.safeParse(dayParam)
  if (!dayParsed.success) {
    return c.json(
      {
        error: {
          code: "INVALID_DAY",
          message: `Invalid day of week '${dayParam}'. Expected one of: ${ALL_DAYS.join(", ")}`,
          details: null,
        },
      },
      400,
    )
  }

  const validDay = dayParsed.data
  const rawBody = await c.req.json().catch(() => null)
  if (!rawBody) {
    return c.json(
      {
        error: {
          code: "INVALID_JSON",
          message: "Malformed or missing JSON request body",
          details: null,
        },
      },
      400,
    )
  }

  const parseResult = syncScheduleSchema.safeParse(rawBody)
  if (!parseResult.success) {
    return c.json(
      {
        error: {
          code: "VALIDATION_ERROR",
          message: "Schedule assignments payload failed validation",
          details: parseResult.error.flatten().fieldErrors,
        },
      },
      422,
    )
  }

  const { assignments } = parseResult.data
  const user = c.get("user")!

  try {
    const updatedSchedules = await db.transaction(async (tx) => {
      // 1. Fetch existing schedules for this day to preserve soldCount
      const existing = await tx
        .select({
          menuItemId: dailyMenuSchedules.menuItemId,
          soldCount: dailyMenuSchedules.soldCount,
        })
        .from(dailyMenuSchedules)
        .where(eq(dailyMenuSchedules.dayOfWeek, validDay))

      const existingSoldCountMap = new Map(existing.map((e) => [e.menuItemId, e.soldCount]))

      // 2. Delete existing schedules for this day
      await tx.delete(dailyMenuSchedules).where(eq(dailyMenuSchedules.dayOfWeek, validDay))

      // 3. Insert updated assignments
      if (assignments.length > 0) {
        await tx.insert(dailyMenuSchedules).values(
          assignments.map((a) => ({
            menuItemId: a.menuItemId,
            dayOfWeek: validDay,
            specialPriceBdt: a.specialPriceBdt ?? null,
            dailyQuota: a.dailyQuota ?? 100,
            soldCount: existingSoldCountMap.get(a.menuItemId) || 0,
            isFeatured: a.isFeatured ?? false,
          })),
        )
      }

      // 4. Log to audit_logs
      await tx.insert(auditLogs).values({
        actorId: user.id,
        action: "UPDATE_SCHEDULE",
        entityType: "DAILY_MENU_SCHEDULE",
        entityId: validDay,
        metadataJson: JSON.stringify({
          day: validDay,
          assignedCount: assignments.length,
          itemIds: assignments.map((a) => a.menuItemId),
        }),
      })

      // 5. Return updated schedules
      return await tx
        .select({
          id: dailyMenuSchedules.id,
          menuItemId: dailyMenuSchedules.menuItemId,
          dayOfWeek: dailyMenuSchedules.dayOfWeek,
          specialPriceBdt: dailyMenuSchedules.specialPriceBdt,
          dailyQuota: dailyMenuSchedules.dailyQuota,
          soldCount: dailyMenuSchedules.soldCount,
          isFeatured: dailyMenuSchedules.isFeatured,
          itemName: menuItems.name,
          basePriceBdt: menuItems.basePriceBdt,
        })
        .from(dailyMenuSchedules)
        .innerJoin(menuItems, eq(dailyMenuSchedules.menuItemId, menuItems.id))
        .where(eq(dailyMenuSchedules.dayOfWeek, validDay))
        .orderBy(desc(dailyMenuSchedules.isFeatured), menuItems.name)
    })

    return c.json({
      data: {
        day: validDay,
        assignments: updatedSchedules,
      },
    })
  } catch (error) {
    console.error("Admin sync schedule error:", error)
    return c.json(
      {
        error: {
          code: "SYNC_SCHEDULE_FAILED",
          message: "Failed to update daily menu schedule",
          details: error instanceof Error ? error.message : String(error),
        },
      },
      500,
    )
  }
})

// =========================================================================
// 3. Menu Item Operations (POST: ADMIN, PATCH: ADMIN/STAFF, DELETE: ADMIN)
// =========================================================================

// POST /api/admin/menu - Create a new menu item
adminRouter.post("/menu", requireRole(["ADMIN"]), async (c) => {
  const rawBody = await c.req.json().catch(() => null)
  if (!rawBody) {
    return c.json(
      {
        error: {
          code: "INVALID_JSON",
          message: "Malformed or missing JSON request body",
          details: null,
        },
      },
      400,
    )
  }

  const parseResult = createMenuItemSchema.safeParse(rawBody)
  if (!parseResult.success) {
    return c.json(
      {
        error: {
          code: "VALIDATION_ERROR",
          message: "Menu item data failed validation",
          details: parseResult.error.flatten().fieldErrors,
        },
      },
      422,
    )
  }

  const data = parseResult.data
  const user = c.get("user")!

  try {
    const createdItem = await db.transaction(async (tx) => {
      let finalCategoryId = data.categoryId

      // Create new category if requested
      if (!finalCategoryId && data.categoryName) {
        const slug = slugify(data.categoryName)
        const [existingCategory] = await tx
          .select()
          .from(categories)
          .where(eq(categories.slug, slug))
          .limit(1)

        if (existingCategory) {
          finalCategoryId = existingCategory.id
        } else {
          const [newCategory] = await tx
            .insert(categories)
            .values({
              name: data.categoryName,
              slug,
              sortOrder: 10,
            })
            .returning()
          finalCategoryId = newCategory.id
        }
      }

      // Default category fallback if not provided
      if (!finalCategoryId) {
        const [defaultCategory] = await tx.select().from(categories).limit(1)
        finalCategoryId = defaultCategory?.id || 1
      }

      // Insert menu item
      const [item] = await tx
        .insert(menuItems)
        .values({
          categoryId: finalCategoryId,
          name: data.name,
          description: data.description,
          basePriceBdt: data.basePriceBdt,
          imageUrl: data.imageUrl,
          portionSize: data.portionSize,
          spiceLevel: data.spiceLevel,
          rating: data.rating,
          isEveryday: data.isEveryday,
          isAvailable: data.isAvailable,
        })
        .returning()

      // Assign initial days if specified
      if (data.initialDays && data.initialDays.length > 0) {
        await tx.insert(dailyMenuSchedules).values(
          data.initialDays.map((day) => ({
            menuItemId: item.id,
            dayOfWeek: day,
            dailyQuota: 100,
            soldCount: 0,
            isFeatured: false,
          })),
        )
      }

      // Audit log
      await tx.insert(auditLogs).values({
        actorId: user.id,
        action: "CREATE_MENU_ITEM",
        entityType: "MENU_ITEM",
        entityId: String(item.id),
        metadataJson: JSON.stringify({
          name: item.name,
          basePriceBdt: item.basePriceBdt,
          categoryId: finalCategoryId,
        }),
      })

      return item
    })

    return c.json(
      {
        data: {
          menuItem: createdItem,
        },
      },
      201,
    )
  } catch (error) {
    console.error("Create menu item error:", error)
    return c.json(
      {
        error: {
          code: "CREATE_MENU_ITEM_FAILED",
          message: "Failed to create menu item",
          details: error instanceof Error ? error.message : String(error),
        },
      },
      500,
    )
  }
})

// PATCH /api/admin/menu/:id - Update dish fields
adminRouter.patch("/menu/:id", requireRole(["ADMIN", "STAFF"]), async (c) => {
  const id = parseInt(c.req.param("id"), 10)
  if (isNaN(id) || id <= 0) {
    return c.json(
      {
        error: {
          code: "INVALID_ID",
          message: "Invalid menu item ID",
          details: null,
        },
      },
      400,
    )
  }

  const rawBody = await c.req.json().catch(() => null)
  if (!rawBody) {
    return c.json(
      {
        error: {
          code: "INVALID_JSON",
          message: "Malformed or missing JSON request body",
          details: null,
        },
      },
      400,
    )
  }

  const parseResult = updateMenuItemSchema.safeParse(rawBody)
  if (!parseResult.success) {
    return c.json(
      {
        error: {
          code: "VALIDATION_ERROR",
          message: "Update data failed validation",
          details: parseResult.error.flatten().fieldErrors,
        },
      },
      422,
    )
  }

  const data = parseResult.data
  const user = c.get("user")!

  try {
    const [existing] = await db.select().from(menuItems).where(eq(menuItems.id, id)).limit(1)

    if (!existing) {
      return c.json(
        {
          error: {
            code: "NOT_FOUND",
            message: `Menu item with ID #${id} not found`,
            details: null,
          },
        },
        404,
      )
    }

    const [updatedItem] = await db
      .update(menuItems)
      .set({
        ...(data.name ? { name: data.name } : {}),
        ...(data.description ? { description: data.description } : {}),
        ...(data.basePriceBdt !== undefined ? { basePriceBdt: data.basePriceBdt } : {}),
        ...(data.imageUrl ? { imageUrl: data.imageUrl } : {}),
        ...(data.portionSize ? { portionSize: data.portionSize } : {}),
        ...(data.spiceLevel ? { spiceLevel: data.spiceLevel } : {}),
        ...(data.rating ? { rating: data.rating } : {}),
        ...(data.isEveryday !== undefined ? { isEveryday: data.isEveryday } : {}),
        ...(data.isAvailable !== undefined ? { isAvailable: data.isAvailable } : {}),
        ...(data.categoryId ? { categoryId: data.categoryId } : {}),
      })
      .where(eq(menuItems.id, id))
      .returning()

    // Audit log
    await db.insert(auditLogs).values({
      actorId: user.id,
      action: "UPDATE_MENU_ITEM",
      entityType: "MENU_ITEM",
      entityId: String(id),
      metadataJson: JSON.stringify({
        updatedFields: Object.keys(data),
      }),
    })

    return c.json({
      data: {
        menuItem: updatedItem,
      },
    })
  } catch (error) {
    console.error("Update menu item error:", error)
    return c.json(
      {
        error: {
          code: "UPDATE_MENU_ITEM_FAILED",
          message: "Failed to update menu item",
          details: error instanceof Error ? error.message : String(error),
        },
      },
      500,
    )
  }
})

// DELETE /api/admin/menu/:id - Delete a menu item
adminRouter.delete("/menu/:id", requireRole(["ADMIN"]), async (c) => {
  const id = parseInt(c.req.param("id"), 10)
  if (isNaN(id) || id <= 0) {
    return c.json(
      {
        error: {
          code: "INVALID_ID",
          message: "Invalid menu item ID",
          details: null,
        },
      },
      400,
    )
  }

  const user = c.get("user")!

  try {
    const [existing] = await db.select().from(menuItems).where(eq(menuItems.id, id)).limit(1)

    if (!existing) {
      return c.json(
        {
          error: {
            code: "NOT_FOUND",
            message: `Menu item with ID #${id} not found`,
            details: null,
          },
        },
        404,
      )
    }

    // Check if item is referenced in any customer orders
    const [orderItemRef] = await db
      .select({ id: orderItems.id })
      .from(orderItems)
      .where(eq(orderItems.menuItemId, id))
      .limit(1)

    if (orderItemRef) {
      // Historical orders preserve integrity: mark as unavailable/archived
      await db.update(menuItems).set({ isAvailable: false }).where(eq(menuItems.id, id))

      await db.insert(auditLogs).values({
        actorId: user.id,
        action: "ARCHIVE_MENU_ITEM",
        entityType: "MENU_ITEM",
        entityId: String(id),
        metadataJson: JSON.stringify({
          reason: "Item referenced in past customer orders, marked unavailable",
          name: existing.name,
        }),
      })

      return c.json({
        data: {
          message:
            "Menu item archived (marked unavailable) because it is referenced in past customer orders",
          archived: true,
          id,
        },
      })
    }

    // No historical orders: safe to permanently delete
    await db.delete(menuItems).where(eq(menuItems.id, id))

    await db.insert(auditLogs).values({
      actorId: user.id,
      action: "DELETE_MENU_ITEM",
      entityType: "MENU_ITEM",
      entityId: String(id),
      metadataJson: JSON.stringify({
        name: existing.name,
      }),
    })

    return c.json({
      data: {
        message: "Menu item successfully deleted",
        archived: false,
        id,
      },
    })
  } catch (error) {
    console.error("Delete menu item error:", error)
    return c.json(
      {
        error: {
          code: "DELETE_MENU_ITEM_FAILED",
          message: "Failed to delete menu item",
          details: error instanceof Error ? error.message : String(error),
        },
      },
      500,
    )
  }
})

// =========================================================================
// 4. Orders Management (ADMIN, STAFF)
// =========================================================================

// GET /api/admin/orders - Filtered list of orders with line items
adminRouter.get("/orders", requireRole(["ADMIN", "STAFF"]), async (c) => {
  try {
    const day = c.req.query("day")?.toUpperCase()
    const status = c.req.query("status")?.toUpperCase()
    const paymentMethod = c.req.query("paymentMethod")?.toUpperCase()
    const search = c.req.query("search")?.trim()
    const limit = Math.min(100, Math.max(1, parseInt(c.req.query("limit") || "50", 10)))
    const offset = Math.max(0, parseInt(c.req.query("offset") || "0", 10))

    const conditions = []

    if (day && dayOfWeekEnumSchema.safeParse(day).success) {
      conditions.push(eq(orders.scheduledDay, day as any))
    }

    if (status) {
      conditions.push(eq(orders.status, status as any))
    }

    if (paymentMethod) {
      conditions.push(eq(orders.paymentMethod, paymentMethod as any))
    }

    if (search) {
      conditions.push(
        or(
          ilike(orders.orderNumber, `%${search}%`),
          ilike(orders.customerName, `%${search}%`),
          ilike(orders.customerPhone, `%${search}%`),
          ilike(orders.paymentTrxId, `%${search}%`),
        ),
      )
    }

    const whereClause = conditions.length > 0 ? and(...conditions) : undefined

    // Total count matching filters
    const [countResult] = await db
      .select({ count: sql<number>`COUNT(*)::int` })
      .from(orders)
      .where(whereClause)

    // Fetch matched orders
    const matchedOrders = await db
      .select()
      .from(orders)
      .where(whereClause)
      .orderBy(desc(orders.createdAt))
      .limit(limit)
      .offset(offset)

    if (matchedOrders.length === 0) {
      return c.json({
        data: [],
        meta: {
          total: Number(countResult?.count || 0),
          limit,
          offset,
        },
      })
    }

    // Fetch items for matched orders
    const orderIds = matchedOrders.map((o) => o.id)
    const items = await db
      .select({
        id: orderItems.id,
        orderId: orderItems.orderId,
        menuItemId: orderItems.menuItemId,
        scheduledDay: orderItems.scheduledDay,
        itemNameSnapshot: orderItems.itemNameSnapshot,
        quantity: orderItems.quantity,
        unitPriceBdt: orderItems.unitPriceBdt,
        lineTotalBdt: orderItems.lineTotalBdt,
        imageUrl: menuItems.imageUrl,
        portionSize: menuItems.portionSize,
      })
      .from(orderItems)
      .leftJoin(menuItems, eq(orderItems.menuItemId, menuItems.id))
      .where(inArray(orderItems.orderId, orderIds))

    const itemsByOrderId = new Map<number, typeof items>()
    for (const item of items) {
      const list = itemsByOrderId.get(item.orderId) || []
      list.push(item)
      itemsByOrderId.set(item.orderId, list)
    }

    const result = matchedOrders.map((order) => ({
      order,
      items: itemsByOrderId.get(order.id) || [],
    }))

    return c.json({
      data: result,
      meta: {
        total: Number(countResult?.count || 0),
        limit,
        offset,
      },
    })
  } catch (error) {
    console.error("Admin orders get error:", error)
    return c.json(
      {
        error: {
          code: "ORDERS_FETCH_FAILED",
          message: "Failed to retrieve orders",
          details: error instanceof Error ? error.message : String(error),
        },
      },
      500,
    )
  }
})

// PATCH /api/admin/orders/:id/status - Update order status with audit log
adminRouter.patch("/orders/:id/status", requireRole(["ADMIN", "STAFF"]), async (c) => {
  const idParam = c.req.param("id")
  const isNumeric = /^\d+$/.test(idParam)

  const rawBody = await c.req.json().catch(() => null)
  if (!rawBody) {
    return c.json(
      {
        error: {
          code: "INVALID_JSON",
          message: "Malformed or missing JSON request body",
          details: null,
        },
      },
      400,
    )
  }

  const parseResult = updateOrderStatusSchema.safeParse(rawBody)
  if (!parseResult.success) {
    return c.json(
      {
        error: {
          code: "VALIDATION_ERROR",
          message: "Order status payload failed validation",
          details: parseResult.error.flatten().fieldErrors,
        },
      },
      422,
    )
  }

  const data = parseResult.data
  const user = c.get("user")!

  try {
    const condition = isNumeric
      ? or(eq(orders.id, parseInt(idParam, 10)), eq(orders.orderNumber, idParam))
      : eq(orders.orderNumber, idParam)

    const [existingOrder] = await db.select().from(orders).where(condition).limit(1)

    if (!existingOrder) {
      return c.json(
        {
          error: {
            code: "NOT_FOUND",
            message: `Order #${idParam} not found`,
            details: null,
          },
        },
        404,
      )
    }

    const [updatedOrder] = await db
      .update(orders)
      .set({
        status: data.status,
        ...(data.notes ? { notes: data.notes } : {}),
      })
      .where(eq(orders.id, existingOrder.id))
      .returning()

    // Record audit log
    await db.insert(auditLogs).values({
      actorId: user.id,
      action: "UPDATE_ORDER_STATUS",
      entityType: "ORDER",
      entityId: String(existingOrder.id),
      metadataJson: JSON.stringify({
        orderNumber: existingOrder.orderNumber,
        previousStatus: existingOrder.status,
        newStatus: data.status,
        notes: data.notes || null,
      }),
    })

    return c.json({
      data: {
        order: updatedOrder,
      },
    })
  } catch (error) {
    console.error("Admin update order status error:", error)
    return c.json(
      {
        error: {
          code: "UPDATE_STATUS_FAILED",
          message: "Failed to update order status",
          details: error instanceof Error ? error.message : String(error),
        },
      },
      500,
    )
  }
})

// PATCH /api/admin/orders/:id/verify-payment - Toggle or set payment verification status
adminRouter.patch("/orders/:id/verify-payment", requireRole(["ADMIN", "STAFF"]), async (c) => {
  const idParam = c.req.param("id")
  const isNumeric = /^\d+$/.test(idParam)
  const user = c.get("user")!

  try {
    const condition = isNumeric
      ? or(eq(orders.id, parseInt(idParam, 10)), eq(orders.orderNumber, idParam))
      : eq(orders.orderNumber, idParam)

    const [existingOrder] = await db.select().from(orders).where(condition).limit(1)

    if (!existingOrder) {
      return c.json(
        {
          error: {
            code: "NOT_FOUND",
            message: `Order #${idParam} not found`,
            details: null,
          },
        },
        404,
      )
    }

    const body = await c.req.json().catch(() => ({}))
    const nextVerified =
      typeof body.isVerified === "boolean" ? body.isVerified : !existingOrder.isPaymentVerified

    const [updatedOrder] = await db
      .update(orders)
      .set({
        isPaymentVerified: nextVerified,
      })
      .where(eq(orders.id, existingOrder.id))
      .returning()

    // Audit log
    await db.insert(auditLogs).values({
      actorId: user.id,
      action: "VERIFY_PAYMENT",
      entityType: "ORDER",
      entityId: String(existingOrder.id),
      metadataJson: JSON.stringify({
        orderNumber: existingOrder.orderNumber,
        previousVerified: existingOrder.isPaymentVerified,
        newVerified: nextVerified,
        paymentMethod: existingOrder.paymentMethod,
        paymentTrxId: existingOrder.paymentTrxId,
      }),
    })

    return c.json({
      data: {
        order: updatedOrder,
      },
    })
  } catch (error) {
    console.error("Admin verify payment error:", error)
    return c.json(
      {
        error: {
          code: "VERIFY_PAYMENT_FAILED",
          message: "Failed to update payment verification status",
          details: error instanceof Error ? error.message : String(error),
        },
      },
      500,
    )
  }
})

// =========================================================================
// 5. User Management & Role Administration (ADMIN ONLY)
// =========================================================================

// GET /api/admin/users - Lists users with order count and total spend
adminRouter.get("/users", requireRole(["ADMIN"]), async (c) => {
  try {
    const userList = await db
      .select({
        id: users.id,
        fullName: users.fullName,
        email: users.email,
        phone: users.phone,
        role: users.role,
        defaultAddress: users.defaultAddress,
        isActive: users.isActive,
        createdAt: users.createdAt,
        updatedAt: users.updatedAt,
        orderCount: sql<number>`COUNT(${orders.id})::int`,
        totalSpendBdt: sql<number>`COALESCE(SUM(CASE WHEN ${orders.status} != 'CANCELLED' THEN ${orders.totalBdt} ELSE 0 END), 0)::int`,
      })
      .from(users)
      .leftJoin(orders, eq(users.id, orders.userId))
      .groupBy(users.id)
      .orderBy(desc(users.createdAt))

    return c.json({
      data: userList,
    })
  } catch (error) {
    console.error("Admin users get error:", error)
    return c.json(
      {
        error: {
          code: "USERS_FETCH_FAILED",
          message: "Failed to retrieve user accounts",
          details: error instanceof Error ? error.message : String(error),
        },
      },
      500,
    )
  }
})

// PATCH /api/admin/users/:id/role - Update user role or active status
adminRouter.patch("/users/:id/role", requireRole(["ADMIN"]), async (c) => {
  const targetId = parseInt(c.req.param("id"), 10)
  if (isNaN(targetId) || targetId <= 0) {
    return c.json(
      {
        error: {
          code: "INVALID_ID",
          message: "Invalid user ID",
          details: null,
        },
      },
      400,
    )
  }

  const currentUser = c.get("user")!

  const rawBody = await c.req.json().catch(() => null)
  if (!rawBody) {
    return c.json(
      {
        error: {
          code: "INVALID_JSON",
          message: "Malformed or missing JSON request body",
          details: null,
        },
      },
      400,
    )
  }

  const parseResult = updateUserRoleSchema.safeParse(rawBody)
  if (!parseResult.success) {
    return c.json(
      {
        error: {
          code: "VALIDATION_ERROR",
          message: "User role payload failed validation",
          details: parseResult.error.flatten().fieldErrors,
        },
      },
      422,
    )
  }

  const data = parseResult.data

  try {
    const [targetUser] = await db.select().from(users).where(eq(users.id, targetId)).limit(1)

    if (!targetUser) {
      return c.json(
        {
          error: {
            code: "NOT_FOUND",
            message: `User with ID #${targetId} not found`,
            details: null,
          },
        },
        404,
      )
    }

    // Safety guardrail: Admins cannot demote or deactivate their own user account
    if (targetUser.id === currentUser.id) {
      if (data.role !== undefined && data.role !== "ADMIN") {
        return c.json(
          {
            error: {
              code: "FORBIDDEN",
              message: "Admins cannot demote their own account role",
              details: null,
            },
          },
          403,
        )
      }
      if (data.isActive === false) {
        return c.json(
          {
            error: {
              code: "FORBIDDEN",
              message: "Admins cannot deactivate their own account",
              details: null,
            },
          },
          403,
        )
      }
    }

    const [updatedUser] = await db
      .update(users)
      .set({
        ...(data.role ? { role: data.role } : {}),
        ...(data.isActive !== undefined ? { isActive: data.isActive } : {}),
        updatedAt: new Date(),
      })
      .where(eq(users.id, targetId))
      .returning({
        id: users.id,
        fullName: users.fullName,
        email: users.email,
        phone: users.phone,
        role: users.role,
        defaultAddress: users.defaultAddress,
        isActive: users.isActive,
        createdAt: users.createdAt,
        updatedAt: users.updatedAt,
      })

    // Audit log
    await db.insert(auditLogs).values({
      actorId: currentUser.id,
      action: "UPDATE_USER_ROLE",
      entityType: "USER",
      entityId: String(targetId),
      metadataJson: JSON.stringify({
        targetUserEmail: targetUser.email,
        fromRole: targetUser.role,
        toRole: data.role || targetUser.role,
        fromActive: targetUser.isActive,
        toActive: data.isActive !== undefined ? data.isActive : targetUser.isActive,
      }),
    })

    return c.json({
      data: {
        user: updatedUser,
      },
    })
  } catch (error) {
    console.error("Admin update user role error:", error)
    return c.json(
      {
        error: {
          code: "UPDATE_USER_ROLE_FAILED",
          message: "Failed to update user role",
          details: error instanceof Error ? error.message : String(error),
        },
      },
      500,
    )
  }
})
