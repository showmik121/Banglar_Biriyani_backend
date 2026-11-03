import { describe, test, expect } from "vitest"
import { DELIVERY_FEE_BDT, computeTotal, evaluateOffer, normalizeOfferCode, type OfferRule } from "../../server/utils/pricing.js"
import {
  deliveryZoneInputSchema,
  deliveryZoneUpdateSchema,
  offerInputSchema,
  validateOfferSchema,
} from "../../server/validators/promotionSchema.js"

const base: OfferRule = {
  code: "DIU10",
  discountType: "PERCENT",
  discountValue: 10,
  maxDiscountBdt: 100,
  minOrderBdt: 300,
  startsAt: null,
  endsAt: null,
  isActive: true,
}

describe("evaluateOffer", () => {
  test("percent discount is rounded down", () => {
    expect(evaluateOffer(base, 455)).toEqual({ ok: true, discountBdt: 45 })
  })

  test("percent discount respects the maximum", () => {
    expect(evaluateOffer(base, 2000)).toEqual({ ok: true, discountBdt: 100 })
  })

  test("flat discount never goes above the subtotal", () => {
    const flat: OfferRule = { ...base, discountType: "FLAT", discountValue: 500, minOrderBdt: 0 }
    expect(evaluateOffer(flat, 300)).toEqual({ ok: true, discountBdt: 300 })
  })

  test("rejects orders below the minimum", () => {
    const r = evaluateOffer(base, 299)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe("MIN_ORDER")
  })

  test("rejects inactive, not-started and expired offers", () => {
    const now = new Date("2026-11-03T12:00:00Z")
    const day = 24 * 60 * 60 * 1000
    const inactive = evaluateOffer({ ...base, isActive: false }, 500, now)
    const early = evaluateOffer({ ...base, startsAt: new Date(now.getTime() + day) }, 500, now)
    const late = evaluateOffer({ ...base, endsAt: new Date(now.getTime() - day) }, 500, now)
    expect([inactive, early, late].map((r) => (r.ok ? "ok" : r.reason))).toEqual([
      "INACTIVE",
      "NOT_STARTED",
      "EXPIRED",
    ])
  })
})

describe("computeTotal", () => {
  test("delivery is free", () => {
    expect(DELIVERY_FEE_BDT).toBe(0)
    expect(computeTotal(450, 45, DELIVERY_FEE_BDT)).toBe(405)
  })
  test("subtotal minus discount plus delivery fee", () => {
    expect(computeTotal(800, 80, 30)).toBe(750)
  })
  test("never negative before the fee", () => {
    expect(computeTotal(100, 500, 40)).toBe(40)
  })
})

describe("promo code input", () => {
  test("codes are trimmed and upper-cased", () => {
    expect(normalizeOfferCode("  diu 10 ")).toBe("DIU10")
    expect(validateOfferSchema.parse({ code: "diu10", subtotalBdt: 500 }).code).toBe("DIU10")
  })

  test("a valid offer passes; bad ones are rejected", () => {
    const ok = offerInputSchema.safeParse({ code: "eid25", title: "Eid offer", discountValue: 25 })
    expect(ok.success).toBe(true)
    if (ok.success) expect(ok.data.code).toBe("EID25")

    const over100 = offerInputSchema.safeParse({ code: "BIG", title: "Too big", discountValue: 150 })
    expect(over100.success).toBe(false)

    const badCode = offerInputSchema.safeParse({ code: "no!", title: "Bad code", discountValue: 5 })
    expect(badCode.success).toBe(false)

    const backwards = offerInputSchema.safeParse({
      code: "DATES",
      title: "Dates",
      discountValue: 5,
      startsAt: "2026-12-10",
      endsAt: "2026-12-01",
    })
    expect(backwards.success).toBe(false)
  })
})

describe("delivery point input", () => {
  test("accepts a normal delivery point; delivery is free by default", () => {
    const r = deliveryZoneInputSchema.safeParse({ name: "Khagan", etaMinutes: "15-20" })
    expect(r.success).toBe(true)
    if (r.success) expect(r.data.feeBdt).toBe(0)
  })

  test("pausing a point changes only isActive", () => {
    expect(deliveryZoneUpdateSchema.parse({ isActive: false })).toEqual({ isActive: false })
  })

  test("rejects negative fees and odd time formats", () => {
    expect(deliveryZoneInputSchema.safeParse({ name: "X Zone", feeBdt: -5 }).success).toBe(false)
    expect(
      deliveryZoneInputSchema.safeParse({ name: "X Zone", feeBdt: 40, etaMinutes: "soon" }).success,
    ).toBe(false)
  })
})
