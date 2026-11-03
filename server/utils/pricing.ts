/**
 * Pure pricing helpers shared by checkout and order creation.
 * No database access here, so every rule can be unit tested.
 */

export interface OfferRule {
  code: string
  discountType: "PERCENT" | "FLAT"
  discountValue: number
  maxDiscountBdt: number | null
  minOrderBdt: number
  startsAt: Date | null
  endsAt: Date | null
  isActive: boolean
}

export type OfferCheck =
  | { ok: true; discountBdt: number }
  | { ok: false; reason: "INACTIVE" | "NOT_STARTED" | "EXPIRED" | "MIN_ORDER"; message: string }

/** Delivery is free for every order and every delivery point. */
export const DELIVERY_FEE_BDT = 0

export function normalizeOfferCode(code: string): string {
  return code.trim().toUpperCase().replace(/\s+/g, "")
}

/**
 * Work out the discount an offer gives on a subtotal.
 * The discount never exceeds the subtotal, and percent offers respect maxDiscountBdt.
 */
export function evaluateOffer(offer: OfferRule, subtotalBdt: number, now = new Date()): OfferCheck {
  if (!offer.isActive) {
    return { ok: false, reason: "INACTIVE", message: "This offer is not active" }
  }
  if (offer.startsAt && now < offer.startsAt) {
    return { ok: false, reason: "NOT_STARTED", message: "This offer has not started yet" }
  }
  if (offer.endsAt && now > offer.endsAt) {
    return { ok: false, reason: "EXPIRED", message: "This offer has expired" }
  }
  if (subtotalBdt < offer.minOrderBdt) {
    return {
      ok: false,
      reason: "MIN_ORDER",
      message: `Minimum order for this offer is ৳${offer.minOrderBdt}`,
    }
  }

  let discount =
    offer.discountType === "PERCENT"
      ? Math.floor((subtotalBdt * offer.discountValue) / 100)
      : offer.discountValue

  if (offer.discountType === "PERCENT" && offer.maxDiscountBdt != null) {
    discount = Math.min(discount, offer.maxDiscountBdt)
  }
  discount = Math.max(0, Math.min(discount, subtotalBdt))
  return { ok: true, discountBdt: discount }
}

export function computeTotal(subtotalBdt: number, discountBdt: number, deliveryFeeBdt: number) {
  return Math.max(0, subtotalBdt - discountBdt) + deliveryFeeBdt
}
