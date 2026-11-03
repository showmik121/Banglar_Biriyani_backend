import { z } from "zod"
import { normalizeOfferCode } from "../utils/pricing.js"

const optionalDate = z
  .string()
  .nullish()
  .transform((v, ctx) => {
    if (!v) return null
    const d = new Date(v)
    if (Number.isNaN(d.getTime())) {
      ctx.addIssue({ code: "custom", message: "Invalid date" })
      return z.NEVER
    }
    return d
  })

const offerCodeSchema = z
  .string({ error: "Promo code is required" })
  .transform(normalizeOfferCode)
  .pipe(
    z
      .string()
      .min(3, "Promo code must be at least 3 characters")
      .max(20, "Promo code cannot exceed 20 characters")
      .regex(/^[A-Z0-9_-]+$/, "Use only letters, numbers, - and _"),
  )

export const offerInputSchema = z
  .object({
    code: offerCodeSchema,
    title: z.string().trim().min(2, "Title is required").max(80),
    description: z.string().trim().max(300).default(""),
    discountType: z.enum(["PERCENT", "FLAT"]).default("PERCENT"),
    discountValue: z.number().int().positive("Discount must be greater than 0"),
    maxDiscountBdt: z.number().int().positive().nullable().optional(),
    minOrderBdt: z.number().int().min(0).default(0),
    startsAt: optionalDate,
    endsAt: optionalDate,
    isActive: z.boolean().default(true),
    showOnHomepage: z.boolean().default(true),
  })
  .superRefine((o, ctx) => {
    if (o.discountType === "PERCENT" && o.discountValue > 100) {
      ctx.addIssue({ code: "custom", path: ["discountValue"], message: "Percent cannot exceed 100" })
    }
    if (o.startsAt && o.endsAt && o.endsAt <= o.startsAt) {
      ctx.addIssue({ code: "custom", path: ["endsAt"], message: "End date must be after start date" })
    }
  })

// All fields optional for PATCH; the same rules apply to what is sent.
export const offerUpdateSchema = z
  .object({
    code: offerCodeSchema.optional(),
    title: z.string().trim().min(2).max(80).optional(),
    description: z.string().trim().max(300).optional(),
    discountType: z.enum(["PERCENT", "FLAT"]).optional(),
    discountValue: z.number().int().positive().optional(),
    maxDiscountBdt: z.number().int().positive().nullable().optional(),
    minOrderBdt: z.number().int().min(0).optional(),
    startsAt: optionalDate.optional(),
    endsAt: optionalDate.optional(),
    isActive: z.boolean().optional(),
    showOnHomepage: z.boolean().optional(),
  })
  .refine((o) => Object.keys(o).length > 0, "Nothing to update")

export const deliveryZoneInputSchema = z.object({
  name: z.string().trim().min(2, "Name is required").max(80),
  area: z.string().trim().max(120).default(""),
  // Delivery is free; kept so old data stays valid.
  feeBdt: z.number().int().min(0, "Fee cannot be negative").max(1000).default(0),
  etaMinutes: z
    .string()
    .trim()
    .regex(/^\d{1,3}(-\d{1,3})?$/, "Use minutes like 20 or 20-30")
    .default("20-30"),
  isActive: z.boolean().default(true),
  sortOrder: z.number().int().min(0).default(0),
})

// PATCH: no defaults here, so fields that are not sent are left unchanged
// (with .partial() Zod would fill in defaults and wipe them).
export const deliveryZoneUpdateSchema = z
  .object({
    name: z.string().trim().min(2, "Name is required").max(80).optional(),
    area: z.string().trim().max(120).optional(),
    etaMinutes: z
      .string()
      .trim()
      .regex(/^\d{1,3}(-\d{1,3})?$/, "Use minutes like 20 or 20-30")
      .optional(),
    isActive: z.boolean().optional(),
    sortOrder: z.number().int().min(0).optional(),
  })
  .refine((o) => Object.keys(o).length > 0, "Nothing to update")

export const validateOfferSchema = z.object({
  code: z.string().min(1).transform(normalizeOfferCode),
  subtotalBdt: z.number().int().min(0),
})

export type OfferInput = z.infer<typeof offerInputSchema>
export type DeliveryZoneInput = z.infer<typeof deliveryZoneInputSchema>
