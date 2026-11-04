import { randomInt } from "node:crypto"
import { Hono } from "hono"
import { eq, and, inArray, sql } from "drizzle-orm"
import {
  db,
  menuItems,
  dailyMenuSchedules,
  orders,
  orderItems,
  offers,
  deliveryZones,
} from "../../src/db/index.js"
import { DELIVERY_FEE_BDT, computeTotal, evaluateOffer } from "../utils/pricing.js"
import { createOrderSchema } from "../validators/orderSchema.js"
import { orderRateLimiter } from "../middleware/rateLimiter.js"
import { optionalAuth, requireAuth } from "../middleware/authMiddleware.js"
import { dhakaNow, isMealOpen, mealForHour, mealWindowsEnabled, windowText, type MealName } from "../utils/mealWindows.js"
import { samePhone } from "../utils/phone.js"
import { sendOrderEmail } from "../utils/email.js"
import { errorDetails } from "../utils/errors.js"
import { parsePaging } from "../utils/paging.js"
import { createFailureLimiter, getClientIp } from "../middleware/rateLimiter.js"

export const ordersRouter = new Hono()

// Stops people guessing order number + phone combinations: 20 wrong lookups per 15 minutes per IP
const lookupFailures = createFailureLimiter(20, 15 * 60 * 1000)
// ...and 5 wrong phone numbers per order number, whatever address they come from, so a
// spread-out or spoofed-address attack cannot keep guessing the phone for one known order.
const MAX_WRONG_PHONES_PER_ORDER = 5
const orderLookupFailures = createFailureLimiter(MAX_WRONG_PHONES_PER_ORDER, 15 * 60 * 1000)

function generateOrderNumber(): string {
  const now = new Date()
  const year = now.getFullYear()
  const month = String(now.getMonth() + 1).padStart(2, "0")
  const day = String(now.getDate()).padStart(2, "0")
  const millis = String(now.getMilliseconds()).padStart(3, "0")
  // Cryptographic randomness: order numbers must not be predictable
  const randomSuffix = randomInt(1000, 10000)
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

        // The same dish can be on both lunch and dinner, so schedules are found by dish AND meal.
        // An older website that does not send the meal gets the dish's only meal, or the one that fits the time of day.
        const nowDhaka = dhakaNow()
        const mealsOfItem = new Map<number, string[]>()
        for (const s of schedules) mealsOfItem.set(s.menuItemId, [...(mealsOfItem.get(s.menuItemId) ?? []), s.mealTime])
        const mealOf = (reqItem: { menuItemId: number; mealTime?: MealName }): MealName => {
          if (reqItem.mealTime) return reqItem.mealTime
          const meals = mealsOfItem.get(reqItem.menuItemId) ?? []
          if (meals.length === 1 && (meals[0] === "LUNCH" || meals[0] === "DINNER")) return meals[0]
          return mealForHour(nowDhaka.hour)
        }
        const scheduleKey = (menuItemId: number, meal: string) => `${menuItemId}:${meal}`
        const scheduleLookup = new Map(schedules.map((s) => [scheduleKey(s.menuItemId, s.mealTime), s]))

        // Same-day orders are taken only in each meal's hours (pre-orders for other days are not limited)
        if (mealWindowsEnabled() && data.scheduledDay === nowDhaka.day) {
          for (const reqItem of data.items) {
            const meal = mealOf(reqItem)
            if (!isMealOpen(meal, nowDhaka.hour)) {
              throw new Error(
                `MEAL_CLOSED: ${meal === "LUNCH" ? "Lunch" : "Dinner"} orders for today are taken from ${windowText(meal)} (Bangladesh time)`,
              )
            }
          }
        }

        // 3. Aggregate requested quantities per item ID to prevent quota evasion
        const requestedQuantities = new Map<string, { menuItemId: number; meal: MealName; qty: number }>()
        for (const reqItem of data.items) {
          const meal = mealOf(reqItem)
          const key = scheduleKey(reqItem.menuItemId, meal)
          const prev = requestedQuantities.get(key)
          requestedQuantities.set(key, {
            menuItemId: reqItem.menuItemId,
            meal,
            qty: (prev?.qty ?? 0) + reqItem.quantity,
          })
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
          const daySchedule = scheduleLookup.get(scheduleKey(reqItem.menuItemId, mealOf(reqItem)))

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
        for (const { menuItemId, meal, qty: totalQty } of requestedQuantities.values()) {
          const dbItem = itemLookup.get(menuItemId)!
          const daySchedule = scheduleLookup.get(scheduleKey(menuItemId, meal))

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

        // Delivery is free; the delivery point only tells the rider where to go.
        const deliveryFeeBdt = DELIVERY_FEE_BDT
        let deliveryZoneId: number | null = null
        if (data.deliveryZoneId) {
          const [zone] = await tx
            .select()
            .from(deliveryZones)
            .where(eq(deliveryZones.id, data.deliveryZoneId))
            .limit(1)
          if (!zone || !zone.isActive) {
            throw new Error("ZONE_UNAVAILABLE: We do not deliver to this point right now")
          }
          deliveryZoneId = zone.id
        }

        // Promo code discount, re-checked on the server
        let discountBdt = 0
        let offerCode: string | null = null
        if (data.offerCode) {
          const [offer] = await tx
            .select()
            .from(offers)
            .where(eq(offers.code, data.offerCode))
            .limit(1)
          if (!offer) throw new Error("OFFER_INVALID: This promo code does not exist")
          const check = evaluateOffer(offer, subtotalBdt)
          if (!check.ok) throw new Error(`OFFER_INVALID: ${check.message}`)
          discountBdt = check.discountBdt
          offerCode = offer.code
        }

        const totalBdt = computeTotal(subtotalBdt, discountBdt, deliveryFeeBdt)
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
                deliveryZoneId,
                offerCode,
                discountBdt,
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
        for (const reqItem of data.items) {
          const meal = mealOf(reqItem)
          if (scheduleLookup.has(scheduleKey(reqItem.menuItemId, meal))) {
            await tx
              .update(dailyMenuSchedules)
              .set({
                soldCount: sql`${dailyMenuSchedules.soldCount} + ${reqItem.quantity}`,
              })
              .where(
                and(
                  eq(dailyMenuSchedules.menuItemId, reqItem.menuItemId),
                  eq(dailyMenuSchedules.dayOfWeek, data.scheduledDay),
                  eq(dailyMenuSchedules.mealTime, meal),
                ),
              )
          }
        }

        return {
          order: orderRecord,
          items: insertedLineItems,
        }
      })

      // Confirmation email for signed-in customers (never blocks or fails the order)
      // The order is already saved here, so nothing about the email (not even building its
      // data) may turn this into an error response: the customer would retry and order twice.
      try {
        const buyer = c.get("user")
        await sendOrderEmail(buyer?.email, "PLACED", {
          orderNumber: result.order.orderNumber,
          customerName: result.order.customerName,
          customerAddress: result.order.customerAddress,
          totalBdt: result.order.totalBdt,
          paymentMethod: result.order.paymentMethod,
          items: result.items.map((i: any) => ({ name: i.itemNameSnapshot, quantity: i.quantity, lineTotalBdt: i.lineTotalBdt })),
        })
      } catch (emailErr) {
        console.error("[email] order confirmation skipped:", emailErr)
      }

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
        errorMessage.startsWith("ITEM_NOT_SCHEDULED") ||
        errorMessage.startsWith("ZONE_UNAVAILABLE") ||
        errorMessage.startsWith("MEAL_CLOSED") ||
        errorMessage.startsWith("OFFER_INVALID")
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
            details: errorDetails(error),
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
    const { limit, offset } = parsePaging(c.req.query(), 50, 100)

    const userOrders = await db
      .select()
      .from(orders)
      .where(eq(orders.userId, user.id))
      .orderBy(sql`${orders.createdAt} DESC`)
      .limit(limit)
      .offset(offset)

    if (userOrders.length === 0) {
      return c.json({ data: [], meta: { limit, offset } }, 200)
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

    return c.json({ data: result, meta: { limit, offset } }, 200)
  } catch (error) {
    console.error("Error fetching my-orders:", error)
    return c.json(
      {
        error: {
          code: "DATABASE_ERROR",
          message: "Failed to retrieve user orders",
          details: errorDetails(error),
        },
      },
      500,
    )
  }
})

/**
 * GET /api/orders/:orderNumber?phone=01XXXXXXXXX
 * Track one order. Allowed for the signed-in customer who placed it, the admin,
 * or anyone who also gives the phone number used for the order (guest orders).
 * Without that, it answers "not found" so order numbers can't be used to look up
 * other people's details.
 */
ordersRouter.get("/:orderNumber", optionalAuth, async (c) => {
  try {
    const orderNumber = c.req.param("orderNumber").trim().toUpperCase()
    const phone = c.req.query("phone") || ""
    const user = c.get("user")
    const ip = getClientIp(c)

    // Signed-in visitors are checked against their own account, so only phone guesses count
    const wait = Math.max(
      lookupFailures.retryAfterSeconds(ip),
      user ? 0 : orderLookupFailures.retryAfterSeconds(orderNumber),
    )
    if (wait > 0) {
      c.header("Retry-After", String(wait))
      return c.json(
        {
          error: {
            code: "RATE_LIMIT_EXCEEDED",
            message: "Too many wrong tries. Please wait a few minutes and try again.",
            details: { retryAfterSeconds: wait },
          },
        },
        429,
      )
    }

    if (!user && !phone) {
      return c.json(
        {
          error: {
            code: "PHONE_REQUIRED",
            message: "Enter the phone number you used for this order.",
            details: null,
          },
        },
        400,
      )
    }

    const [found] = await db.select().from(orders).where(eq(orders.orderNumber, orderNumber))
    const allowed =
      !!found &&
      ((user && (user.role === "ADMIN" || user.role === "STAFF" || found.userId === user.id)) ||
        (phone !== "" && samePhone(phone, found.customerPhone)))
    const order = allowed ? found : undefined

    if (!order) {
      lookupFailures.recordFailure(ip)
      if (!user && found) orderLookupFailures.recordFailure(orderNumber)
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
          details: errorDetails(error),
        },
      },
      500,
    )
  }
})
