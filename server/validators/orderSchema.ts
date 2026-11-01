import { z } from "zod"

/**
 * Bangladesh phone number validation regex:
 * Matches optional country code (+88 or 88) followed by 01[3-9] and 8 digits (total 11 digits without country code).
 * Examples: 01712345678, +8801812345678, 8801912345678
 */
export const BANGLADESH_PHONE_REGEX = /^(?:\+?88)?01[3-9]\d{8}$/

/**
 * Sanitizes user input string:
 * - Strips null bytes
 * - Strips <script>...</script> blocks
 * - Strips <style>...</style> blocks
 * - Strips any remaining HTML tags
 * - Trims whitespace
 */
export function sanitizeString(value: string | null | undefined): string {
  if (typeof value !== "string") return ""
  return value
    .replace(/\0/g, "")
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, "")
    .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, "")
    .replace(/<[^>]+>/g, "")
    .trim()
}

export const orderItemSchema = z.object({
  menuItemId: z
    .number({
      error: "menuItemId must be a number",
    })
    .int("menuItemId must be an integer")
    .positive("menuItemId must be greater than 0"),
  quantity: z
    .number({
      error: "quantity must be a number",
    })
    .int("quantity must be an integer")
    .min(1, "quantity must be at least 1")
    .max(50, "quantity cannot exceed 50 per item"),
})

export const createOrderSchema = z
  .object({
    customerName: z
      .string({
        error: "customerName is required",
      })
      .transform(sanitizeString)
      .pipe(
        z
          .string()
          .min(2, "Name must be at least 2 characters")
          .max(100, "Name cannot exceed 100 characters"),
      ),
    customerPhone: z
      .string({
        error: "customerPhone is required",
      })
      .trim()
      .regex(
        BANGLADESH_PHONE_REGEX,
        "Invalid Bangladesh phone number. Format: 01XXXXXXXXX (e.g., 01712345678)",
      ),
    customerAddress: z
      .string({
        error: "customerAddress is required",
      })
      .transform(sanitizeString)
      .pipe(
        z
          .string()
          .min(5, "Delivery address must be at least 5 characters")
          .max(300, "Delivery address cannot exceed 300 characters"),
      ),
    scheduledDay: z.preprocess(
      (val) => (typeof val === "string" ? val.trim().toUpperCase() : val),
      z.enum(["SATURDAY", "SUNDAY", "MONDAY", "TUESDAY", "WEDNESDAY", "THURSDAY", "FRIDAY"], {
        error: "scheduledDay must be a valid day (SATURDAY through FRIDAY)",
      }),
    ),
    deliverySlot: z
      .string()
      .trim()
      .min(1, "deliverySlot cannot be empty")
      .default("ASAP (45-60 mins)"),
    paymentMethod: z
      .enum(["COD", "BKASH", "NAGAD"], {
        error: "paymentMethod must be COD, BKASH, or NAGAD",
      })
      .default("COD"),
    paymentTrxId: z
      .union([z.string(), z.null(), z.undefined()])
      .transform((val) => {
        if (!val) return null
        const sanitized = sanitizeString(val)
        return sanitized.length > 0 ? sanitized.toUpperCase() : null
      })
      .pipe(z.string().max(50, "Transaction ID cannot exceed 50 characters").nullable())
      .optional(),
    notes: z
      .union([z.string(), z.null(), z.undefined()])
      .transform((val) => {
        if (!val) return null
        const sanitized = sanitizeString(val)
        return sanitized.length > 0 ? sanitized : null
      })
      .pipe(z.string().max(500, "Notes cannot exceed 500 characters").nullable())
      .optional(),
    items: z
      .array(orderItemSchema, {
        error: "items must be an array",
      })
      .min(1, "Order must contain at least 1 item")
      .max(30, "Order cannot exceed 30 distinct items"),
  })
  .superRefine((data, ctx) => {
    if (
      (data.paymentMethod === "BKASH" || data.paymentMethod === "NAGAD") &&
      (!data.paymentTrxId || data.paymentTrxId.trim().length < 4)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Valid Transaction ID (TrxID) is required for bKash and Nagad payments",
        path: ["paymentTrxId"],
      })
    }
  })

export type CreateOrderInput = z.infer<typeof createOrderSchema>
export type OrderItemInput = z.infer<typeof orderItemSchema>
