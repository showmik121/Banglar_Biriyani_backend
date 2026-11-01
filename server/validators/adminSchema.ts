import { z } from "zod"

export const dayOfWeekEnumSchema = z.enum([
  "SATURDAY",
  "SUNDAY",
  "MONDAY",
  "TUESDAY",
  "WEDNESDAY",
  "THURSDAY",
  "FRIDAY",
])

export const orderStatusEnumSchema = z.enum([
  "PENDING",
  "CONFIRMED",
  "PREPARING",
  "OUT_FOR_DELIVERY",
  "DELIVERED",
  "CANCELLED",
])

export const paymentMethodEnumSchema = z.enum(["COD", "BKASH", "NAGAD"])

export const updateOrderStatusSchema = z.object({
  status: orderStatusEnumSchema,
  notes: z.string().trim().max(500).optional(),
})

export const scheduleItemInputSchema = z.object({
  menuItemId: z.number().int().positive("menuItemId must be a positive integer"),
  specialPriceBdt: z.number().int().min(0).nullable().optional(),
  dailyQuota: z.number().int().min(0).default(100),
  isFeatured: z.boolean().default(false),
})

export const syncScheduleSchema = z.union([
  z.object({
    assignments: z.array(scheduleItemInputSchema),
  }),
  z
    .object({
      items: z.array(scheduleItemInputSchema),
    })
    .transform((val) => ({ assignments: val.items })),
  z.array(scheduleItemInputSchema).transform((val) => ({ assignments: val })),
])

export const createMenuItemSchema = z.object({
  categoryId: z.number().int().positive().optional(),
  categoryName: z.string().trim().min(2).optional(),
  name: z.string().trim().min(2, "Dish name must be at least 2 characters"),
  description: z.string().trim().min(5, "Description must be at least 5 characters"),
  basePriceBdt: z.number().int().positive("Price must be a positive number in BDT"),
  imageUrl: z.string().trim().url("Valid image URL required"),
  portionSize: z.string().trim().default("1:1 Regular"),
  spiceLevel: z.string().trim().default("Medium"),
  rating: z.string().trim().default("4.9"),
  isEveryday: z.boolean().default(false),
  isAvailable: z.boolean().default(true),
  initialDays: z.array(dayOfWeekEnumSchema).optional(),
})

export const updateMenuItemSchema = z.object({
  name: z.string().trim().min(2).optional(),
  description: z.string().trim().min(5).optional(),
  basePriceBdt: z.number().int().positive().optional(),
  imageUrl: z.string().trim().url().optional(),
  portionSize: z.string().trim().optional(),
  spiceLevel: z.string().trim().optional(),
  rating: z.string().trim().optional(),
  isEveryday: z.boolean().optional(),
  isAvailable: z.boolean().optional(),
  categoryId: z.number().int().positive().optional(),
})

export const updateUserRoleSchema = z.object({
  role: z.enum(["CUSTOMER", "STAFF", "ADMIN"]).optional(),
  isActive: z.boolean().optional(),
})

export type UpdateOrderStatusInput = z.infer<typeof updateOrderStatusSchema>
export type SyncScheduleInput = z.infer<typeof syncScheduleSchema>
export type CreateMenuItemInput = z.infer<typeof createMenuItemSchema>
export type UpdateMenuItemInput = z.infer<typeof updateMenuItemSchema>
export type UpdateUserRoleInput = z.infer<typeof updateUserRoleSchema>
