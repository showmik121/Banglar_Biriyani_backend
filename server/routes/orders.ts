import { Hono } from "hono"
import { eq, and, inArray, sql } from "drizzle-orm"
import { db, menuItems, dailyMenuSchedules, orders, orderItems } from "../../src/db/index.js"
import { createOrderSchema } from "../validators/orderSchema.js"
import { orderRateLimiter } from "../middleware/rateLimiter.js"
import { optionalAuth, requireAuth } from "../middleware/authMiddleware.js"

export const ordersRouter = new Hono()

function generateOrderNumber(): string {
  const now = new Date()
  const year = now.getFullYear()
  const month = String(now.getMonth() + 1).padStart(2, "0")
  const day = String(now.getDate()).padStart(2, "0")
  const millis = String(now.getMilliseconds()).padStart(3, "0")
  const randomSuffix = Math.floor(1000 + Math.random() * 9000)
  return `BB-${year}${month}${day}-${millis}${randomSuffix}`
}

/**
 * POST /api/orders
 * Creates an order inside an ACID database transaction.
 * Rate-limited: Maximum 10 order submissions per IP per 15 minutes.
 * Authoritative: NEVER trusts client-submitted prices.
 */
ordersRouter.post(
  "/",
  optionalAuth,
  orderRateLimiter({
    windowMs: 15 * 60 * 1000,
    max: 10,
    message: "Too many order submissions. Maximum 10 orders per 15 minutes per IP.",
  }),
  async (c) => {
    try {
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

      const parseResult = createOrderSchema.safeParse(rawBody)
      if (!parseResult.success) {
        return c.json(
          {
            error: {
              code: "VALIDATION_ERROR",
              message: "Request body failed validation",
              details: parseResult.error.flatten().fieldErrors,
            },
          },
          422,
        )
      }

      const data = parseResult.data
      const requestedItemIds = data.items.map((i) => i.menuItemId)

      // Run order creation and validation inside an ACID transaction
      const result = await db.transaction(async (tx) => {
        // 1. Fetch authoritative menu items
        const dbItems = await tx
          .select()
          .from(menuItems)
          .where(inArray(menuItems.id, requestedItemIds))

        const itemLookup = new Map(dbItems.map((item) => [item.id, item]))

        // 2. Fetch any special schedule price overrides for the requested scheduledDay with row-level locking
        const schedules = await tx
          .select()
          .from(dailyMenuSchedules)
          .where(
            and(
              inArray(dailyMenuSchedules.menuItemId, requestedItemIds),
              eq(dailyMenuSchedules.dayOfWeek, data.scheduledDay),
            ),
          )
          .for("update")

        const scheduleLookup = new Map(schedules.map((s) => [s.menuItemId, s]))

        // 3. Aggregate requested quantities per item ID to prevent quota evasion
        const requestedQuantities = new Map<number, number>()
        for (const reqItem of data.items) {
          requestedQuantities.set(
            reqItem.menuItemId,
            (requestedQuantities.get(reqItem.menuItemId) || 0) + reqItem.quantity,
          )
        }

        // 4. Validate every requested item exists, is available, and matches schedule
        const calculatedLineItems: {
          menuItemId: number
          scheduledDay: typeof data.scheduledDay
          itemNameSnapshot: string
          quantity: number
          unitPriceBdt: number
          lineTotalBdt: number
        }[] = []

        let subtotalBdt = 0

        for (const reqItem of data.items) {
          const dbItem = itemLookup.get(reqItem.menuItemId)
          if (!dbItem) {
            throw new Error(
              `ITEM_NOT_FOUND: Menu item with ID ${reqItem.menuItemId} does not exist`,
            )
          }
          if (!dbItem.isAvailable) {
            throw new Error(`ITEM_UNAVAILABLE: Menu item '${dbItem.name}' is currently unavailable`)
          }

          // Lookup optional day schedule for special price override or quota
          const daySchedule = scheduleLookup.get(reqItem.menuItemId)

          // Authoritative price calculation:
          // If scheduled on requested day with specialPriceBdt, use that; otherwise basePriceBdt
          const unitPriceBdt = daySchedule?.specialPriceBdt ?? dbItem.basePriceBdt
          const lineTotalBdt = unitPriceBdt * reqItem.quantity
          subtotalBdt += lineTotalBdt

          calculatedLineItems.push({
            menuItemId: dbItem.id,
            scheduledDay: data.scheduledDay,
            itemNameSnapshot: dbItem.name,
            quantity: reqItem.quantity,
            unitPriceBdt,
            lineTotalBdt,
          })
        }

        // 5. Atomic Quota Enforcement: Ensure total ordered portions do not exceed remaining stock
        for (const [menuItemId, totalQty] of requestedQuantities.entries()) {
          const dbItem = itemLookup.get(menuItemId)!
          const daySchedule = scheduleLookup.get(menuItemId)

          if (
            daySchedule &&
            daySchedule.dailyQuota !== null &&
            daySchedule.dailyQuota !== undefined
          ) {
            const currentSold = daySchedule.soldCount ?? 0
            const remaining = daySchedule.dailyQuota - currentSold
            if (totalQty > remaining) {
              throw new Error(
                `QUOTA_EXCEEDED: Only ${Math.max(0, remaining)} portions of '${dbItem.name}' left for ${data.scheduledDay}`,
              )
            }
          }
        }

        // Standard delivery fee across Dhaka
        const deliveryFeeBdt = 60
        const totalBdt = subtotalBdt + deliveryFeeBdt
        // Insert master order record with collision retry
        const authenticatedUser = c.get("user")
        let orderRecord: any

        for (let attempt = 0; attempt < 3; attempt++) {
          try {
            const [inserted] = await tx
              .insert(orders)
              .values({
                orderNumber: generateOrderNumber(),
                userId: authenticatedUser?.id ?? null,
                customerName: data.customerName,
                customerPhone: data.customerPhone,
                customerAddress: data.customerAddress,
                scheduledDay: data.scheduledDay,
                deliverySlot: data.deliverySlot,
                paymentMethod: data.paymentMethod,
                subtotalBdt,
                deliveryFeeBdt,
                totalBdt,
                status: "PENDING",
                paymentTrxId: data.paymentTrxId || null,
                isPaymentVerified: false,
                notes: data.notes || null,
              })
              .returning()
            orderRecord = inserted
            break
          } catch (err: any) {
            if (err?.code === "23505" && attempt < 2) {
              continue
            }
            throw err
          }
        }

        // Insert line items
        const itemsToInsert = calculatedLineItems.map((item) => ({
          ...item,
          orderId: orderRecord.id,
        }))

        const insertedLineItems = await tx.insert(orderItems).values(itemsToInsert).returning()

        // Increment daily_menu_schedules.soldCount inside the transaction for quota tracking (if schedule row exists)
        for (const item of calculatedLineItems) {
          if (scheduleLookup.has(item.menuItemId)) {
            await tx
              .update(dailyMenuSchedules)
              .set({
                soldCount: sql`${dailyMenuSchedules.soldCount} + ${item.quantity}`,
              })
              .where(
                and(
                  eq(dailyMenuSchedules.menuItemId, item.menuItemId),
                  eq(dailyMenuSchedules.dayOfWeek, data.scheduledDay),
                ),
              )
          }
        }

        return {
          order: orderRecord,
          items: insertedLineItems,
        }
      })

      c.header("Location", `/api/orders/${result.order.orderNumber}`)
      return c.json(
        {
          data: result,
        },
        201,
      )
    } catch (error: any) {
      console.error("Error creating order:", error)

      const errorMessage = error?.message || String(error)

      if (errorMessage.startsWith("QUOTA_EXCEEDED")) {
        const [code, ...msgParts] = errorMessage.split(": ")
        return c.json(
          {
            error: {
              code: "QUOTA_EXCEEDED",
              message: msgParts.join(": "),
              details: null,
            },
          },
          422,
        )
      }

      if (errorMessage.startsWith("ITEM_NOT_FOUND")) {
        const [code, ...msgParts] = errorMessage.split(": ")
        return c.json(
          {
            error: {
              code: "ITEM_NOT_FOUND",
              message: msgParts.join(": "),
              details: null,
            },
          },
          404,
        )
      }

      if (
        errorMessage.startsWith("ITEM_UNAVAILABLE") ||
        errorMessage.startsWith("ITEM_NOT_SCHEDULED")
      ) {
        const [code, ...msgParts] = errorMessage.split(": ")
        return c.json(
          {
            error: {
              code,
              message: msgParts.join(": "),
              details: null,
            },
          },
          422,
        )
      }

      return c.json(
        {
          error: {
            code: "ORDER_CREATION_FAILED",
            message: "Failed to create order",
            details: errorMessage,
          },
        },
        500,
      )
    }
  },
)

/**
 * GET /api/orders/my-orders
 * Returns all orders placed by the authenticated customer with line items
 */
ordersRouter.get("/my-orders", requireAuth, async (c) => {
  try {
    const user = c.get("user")!

    const userOrders = await db
      .select()
      .from(orders)
      .where(eq(orders.userId, user.id))
      .orderBy(sql`${orders.createdAt} DESC`)

    if (userOrders.length === 0) {
      return c.json({ data: [] }, 200)
    }

    const orderIds = userOrders.map((o) => o.id)
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

    const result = userOrders.map((order) => ({
      order,
      items: itemsByOrderId.get(order.id) || [],
    }))

    return c.json({ data: result }, 200)
  } catch (error) {
    console.error("Error fetching my-orders:", error)
    return c.json(
      {
        error: {
          code: "DATABASE_ERROR",
          message: "Failed to retrieve user orders",
          details: error instanceof Error ? error.message : String(error),
        },
      },
      500,
    )
  }
})

/**
 * GET /api/orders/:orderNumber
 * Returns order details and line items by orderNumber
 */
ordersRouter.get("/:orderNumber", async (c) => {
  try {
    const orderNumber = c.req.param("orderNumber")

    const [order] = await db.select().from(orders).where(eq(orders.orderNumber, orderNumber))

    if (!order) {
      return c.json(
        {
          error: {
            code: "ORDER_NOT_FOUND",
            message: `Order #${orderNumber} not found`,
            details: null,
          },
        },
        404,
      )
    }

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
      .where(eq(orderItems.orderId, order.id))

    return c.json({
      data: {
        order,
        items,
      },
    })
  } catch (error) {
    console.error("Error fetching order:", error)
    return c.json(
      {
        error: {
          code: "DATABASE_ERROR",
          message: "Failed to retrieve order",
          details: error instanceof Error ? error.message : String(error),
        },
      },
      500,
    )
  }
})
