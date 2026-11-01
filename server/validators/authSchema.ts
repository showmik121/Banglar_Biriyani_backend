import { z } from "zod"
import { BD_PHONE_REGEX, normalizeBdPhone } from "../utils/auth.js"

export const signupSchema = z.object({
  fullName: z
    .string({ error: "Full name is required" })
    .trim()
    .min(2, "Full name must be at least 2 characters")
    .max(100, "Full name cannot exceed 100 characters"),
  email: z
    .string({ error: "Email is required" })
    .trim()
    .toLowerCase()
    .email("Invalid email address"),
  phone: z
    .string({ error: "Phone number is required" })
    .trim()
    .transform((val) => normalizeBdPhone(val))
    .refine(
      (val) => /^01[3-9]\d{8}$/.test(val),
      "Invalid Bangladesh phone number. Expected 11 digits starting with 01 (e.g., 01711000000)",
    ),
  password: z
    .string({ error: "Password is required" })
    .min(8, "Password must be at least 8 characters"),
  defaultAddress: z.string().trim().max(300).optional().nullable(),
})

export const loginSchema = z.object({
  identifier: z
    .string({ error: "Email or phone number is required" })
    .trim()
    .min(3, "Identifier must be at least 3 characters"),
  password: z.string({ error: "Password is required" }).min(1, "Password is required"),
})

export const updateProfileSchema = z.object({
  fullName: z
    .string()
    .trim()
    .min(2, "Full name must be at least 2 characters")
    .max(100, "Full name cannot exceed 100 characters")
    .optional(),
  phone: z
    .string()
    .trim()
    .transform((val) => normalizeBdPhone(val))
    .refine(
      (val) => /^01[3-9]\d{8}$/.test(val),
      "Invalid Bangladesh phone number. Expected 11 digits starting with 01 (e.g., 01711000000)",
    )
    .optional(),
  defaultAddress: z.string().trim().max(300).optional().nullable(),
})

export type SignupInput = z.infer<typeof signupSchema>
export type LoginInput = z.infer<typeof loginSchema>
export type UpdateProfileInput = z.infer<typeof updateProfileSchema>
