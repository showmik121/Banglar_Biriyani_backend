import { z } from "zod"
import { BD_PHONE_REGEX, normalizeBdPhone } from "../utils/auth.js"

// Sign-up: name, mobile number, email (for order updates) and password.
export const signupSchema = z.object({
  fullName: z
    .string({ error: "Enter your name" })
    .trim()
    .min(2, "Enter your name")
    .max(100, "Name is too long"),
  email: z
    .string({ error: "Enter your email" })
    .trim()
    .toLowerCase()
    .email("Enter a valid email address"),
  phone: z
    .string({ error: "Phone number is required" })
    .trim()
    .transform((val) => normalizeBdPhone(val))
    .refine((val) => /^01[3-9]\d{8}$/.test(val), "Enter an 11-digit mobile number starting with 01"),
  password: z
    .string({ error: "Choose a password" })
    .min(8, "Use at least 8 characters for your password")
    // bcrypt only reads the first 72 characters, so a longer password would be silently cut short
    .max(72, "Use at most 72 characters for your password"),
  defaultAddress: z.string().trim().max(300).optional().nullable(),
})

export const loginSchema = z.object({
  identifier: z
    .string({ error: "Email or phone number is required" })
    .trim()
    .min(3, "Identifier must be at least 3 characters"),
  password: z
    .string({ error: "Password is required" })
    .min(1, "Password is required")
    // Generous cap (older passwords may be long) that still keeps huge values away from bcrypt
    .max(200, "Password is too long"),
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
