import { Hono, type Context } from "hono"
import { and, asc, desc, eq, gte, isNull, lte, or } from "drizzle-orm"
import { db, offers, deliveryZones, auditLogs } from "../../src/db/index.js"
import { requireAuth, requireRole } from "../middleware/authMiddleware.js"
import { evaluateOffer } from "../utils/pricing.js"
import {
  deliveryZoneInputSchema,
  deliveryZoneUpdateSchema,
  offerInputSchema,
  offerUpdateSchema,
  validateOfferSchema,
} from "../validators/promotionSchema.js"

// ---------------------------------------------------------------------------
// Small helpers so every route answers in the same { data } / { error } shape
// ---------------------------------------------------------------------------
function fail(c: Context, status: 400 | 404 | 409 | 422 | 500, code: string, message: string, details: unknown = null) {
  return c.json({ error: { code, message, details } }, status)
}

async function readJson(c: Context) {
  return c.req.json().catch(() => null)
}

function parseId(raw: string): number | null {
  const id = Number(raw)
  return Number.isInteger(id) && id > 0 ? id : null
}

async function audit(c: Context, action: string, entityType: string, entityId: number, meta: unknown) {
  const user = c.get("user") as { id: number } | undefined
  await db.insert(auditLogs).values({
    actorId: user?.id ?? null,
    action,
    entityType,
    entityId: String(entityId),
    metadataJson: JSON.stringify(meta),
  })
}

const isUniqueViolation = (err: unknown) => (err as { code?: string })?.code === "23505"

// ===========================================================================
// PUBLIC: offers and delivery points the storefront can show
// ===========================================================================
export const publicPromotionsRouter = new Hono()

/** GET /api/offers — active, currently running offers marked for the homepage */
publicPromotionsRouter.get("/offers", async (c) => {
  const now = new Date()
  const rows = await db
    .select({
      code: offers.code,
      title: offers.title,
      description: offers.description,
      discountType: offers.discountType,
      discountValue: offers.discountValue,
      maxDiscountBdt: offers.maxDiscountBdt,
      minOrderBdt: offers.minOrderBdt,
      endsAt: offers.endsAt,
    })
    .from(offers)
    .where(
      and(
        eq(offers.isActive, true),
        eq(offers.showOnHomepage, true),
        or(isNull(offers.startsAt), lte(offers.startsAt, now)),
        or(isNull(offers.endsAt), gte(offers.endsAt, now)),
      ),
    )
    .orderBy(desc(offers.createdAt))
  return c.json({ data: rows })
})

/** POST /api/offers/validate — { code, subtotalBdt } -> discount preview for checkout */
publicPromotionsRouter.post("/offers/validate", async (c) => {
  const parsed = validateOfferSchema.safeParse(await readJson(c))
  if (!parsed.success) {
    return fail(c, 422, "VALIDATION_ERROR", "Enter a promo code", parsed.error.flatten().fieldErrors)
  }
  const [offer] = await db.select().from(offers).where(eq(offers.code, parsed.data.code)).limit(1)
  if (!offer) return fail(c, 404, "OFFER_NOT_FOUND", "This promo code does not exist")

  const check = evaluateOffer(offer, parsed.data.subtotalBdt)
  if (!check.ok) return fail(c, 422, `OFFER_${check.reason}`, check.message)

  return c.json({
    data: { code: offer.code, title: offer.title, discountBdt: check.discountBdt },
  })
})

/** GET /api/delivery-zones — active delivery points with their delivery time (delivery is free) */
publicPromotionsRouter.get("/delivery-zones", async (c) => {
  const rows = await db
    .select({
      id: deliveryZones.id,
      name: deliveryZones.name,
      area: deliveryZones.area,
      etaMinutes: deliveryZones.etaMinutes,
    })
    .from(deliveryZones)
    .where(eq(deliveryZones.isActive, true))
    .orderBy(asc(deliveryZones.sortOrder), asc(deliveryZones.id))
  return c.json({ data: rows })
})

// ===========================================================================
// ADMIN: manage offers and delivery points
// Reading: ADMIN and STAFF. Creating, editing, deleting: ADMIN only.
// ===========================================================================
export const adminPromotionsRouter = new Hono()
adminPromotionsRouter.use("*", requireAuth)

// ---- Offers ----------------------------------------------------------------
adminPromotionsRouter.get("/offers", requireRole(["ADMIN", "STAFF"]), async (c) => {
  const rows = await db.select().from(offers).orderBy(desc(offers.createdAt))
  return c.json({ data: rows })
})

adminPromotionsRouter.post("/offers", requireRole(["ADMIN"]), async (c) => {
  const parsed = offerInputSchema.safeParse(await readJson(c))
  if (!parsed.success) {
    return fail(c, 422, "VALIDATION_ERROR", "Please fix the highlighted fields", parsed.error.flatten().fieldErrors)
  }
  try {
    const [row] = await db.insert(offers).values(parsed.data).returning()
    await audit(c, "CREATE_OFFER", "OFFER", row.id, { code: row.code })
    return c.json({ data: row }, 201)
  } catch (err) {
    if (isUniqueViolation(err)) return fail(c, 409, "OFFER_CODE_TAKEN", "An offer with this code already exists")
    throw err
  }
})

adminPromotionsRouter.patch("/offers/:id", requireRole(["ADMIN"]), async (c) => {
  const id = parseId(c.req.param("id"))
  if (!id) return fail(c, 400, "INVALID_ID", "Invalid offer id")
  const parsed = offerUpdateSchema.safeParse(await readJson(c))
  if (!parsed.success) {
    return fail(c, 422, "VALIDATION_ERROR", "Please fix the highlighted fields", parsed.error.flatten().fieldErrors)
  }
  try {
    const [row] = await db.update(offers).set(parsed.data).where(eq(offers.id, id)).returning()
    if (!row) return fail(c, 404, "OFFER_NOT_FOUND", "Offer not found")
    await audit(c, "UPDATE_OFFER", "OFFER", id, parsed.data)
    return c.json({ data: row })
  } catch (err) {
    if (isUniqueViolation(err)) return fail(c, 409, "OFFER_CODE_TAKEN", "An offer with this code already exists")
    throw err
  }
})

adminPromotionsRouter.delete("/offers/:id", requireRole(["ADMIN"]), async (c) => {
  const id = parseId(c.req.param("id"))
  if (!id) return fail(c, 400, "INVALID_ID", "Invalid offer id")
  const [row] = await db.delete(offers).where(eq(offers.id, id)).returning({ id: offers.id, code: offers.code })
  if (!row) return fail(c, 404, "OFFER_NOT_FOUND", "Offer not found")
  await audit(c, "DELETE_OFFER", "OFFER", id, { code: row.code })
  return c.json({ data: { id } })
})

// ---- Delivery points -------------------------------------------------------
adminPromotionsRouter.get("/delivery-zones", requireRole(["ADMIN", "STAFF"]), async (c) => {
  const rows = await db
    .select()
    .from(deliveryZones)
    .orderBy(asc(deliveryZones.sortOrder), asc(deliveryZones.id))
  return c.json({ data: rows })
})

adminPromotionsRouter.post("/delivery-zones", requireRole(["ADMIN"]), async (c) => {
  const parsed = deliveryZoneInputSchema.safeParse(await readJson(c))
  if (!parsed.success) {
    return fail(c, 422, "VALIDATION_ERROR", "Please fix the highlighted fields", parsed.error.flatten().fieldErrors)
  }
  const [row] = await db.insert(deliveryZones).values(parsed.data).returning()
  await audit(c, "CREATE_DELIVERY_ZONE", "DELIVERY_ZONE", row.id, { name: row.name })
  return c.json({ data: row }, 201)
})

adminPromotionsRouter.patch("/delivery-zones/:id", requireRole(["ADMIN"]), async (c) => {
  const id = parseId(c.req.param("id"))
  if (!id) return fail(c, 400, "INVALID_ID", "Invalid delivery point id")
  const parsed = deliveryZoneUpdateSchema.safeParse(await readJson(c))
  if (!parsed.success) {
    return fail(c, 422, "VALIDATION_ERROR", "Please fix the highlighted fields", parsed.error.flatten().fieldErrors)
  }
  const [row] = await db.update(deliveryZones).set(parsed.data).where(eq(deliveryZones.id, id)).returning()
  if (!row) return fail(c, 404, "ZONE_NOT_FOUND", "Delivery point not found")
  await audit(c, "UPDATE_DELIVERY_ZONE", "DELIVERY_ZONE", id, parsed.data)
  return c.json({ data: row })
})

adminPromotionsRouter.delete("/delivery-zones/:id", requireRole(["ADMIN"]), async (c) => {
  const id = parseId(c.req.param("id"))
  if (!id) return fail(c, 400, "INVALID_ID", "Invalid delivery point id")
  const [row] = await db
    .delete(deliveryZones)
    .where(eq(deliveryZones.id, id))
    .returning({ id: deliveryZones.id, name: deliveryZones.name })
  if (!row) return fail(c, 404, "ZONE_NOT_FOUND", "Delivery point not found")
  await audit(c, "DELETE_DELIVERY_ZONE", "DELIVERY_ZONE", id, { name: row.name })
  return c.json({ data: { id } })
})
