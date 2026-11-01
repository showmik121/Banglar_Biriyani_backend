import { Hono } from "hono"
import { eq, or, and, ne, ilike } from "drizzle-orm"
import crypto from "crypto"
import { db, users, sessions, auditLogs } from "../../src/db/index.js"
import {
  hashPassword,
  verifyPassword,
  signSessionToken,
  setSessionCookie,
  clearSessionCookie,
  normalizeBdPhone,
  SESSION_MAX_AGE_SECONDS,
} from "../utils/auth.js"
import { signupSchema, loginSchema, updateProfileSchema } from "../validators/authSchema.js"
import { requireAuth, type SafeUser } from "../middleware/authMiddleware.js"
import { getClientIp } from "../middleware/rateLimiter.js"

export const authRouter = new Hono()

// Failed login attempt tracking store (per IP, 15 min window, max 5 failed attempts)
interface FailedLoginRecord {
  count: number
  firstFailedTime: number
  lastFailedTime: number
}

const failedLoginStore = new Map<string, FailedLoginRecord>()
const FAILED_LOGIN_WINDOW_MS = 15 * 60 * 1000 // 15 minutes
const MAX_FAILED_LOGIN_ATTEMPTS = 5

function checkLoginRateLimit(ip: string): { isBlocked: boolean; retryAfterSeconds: number } {
  const record = failedLoginStore.get(ip)
  if (!record) return { isBlocked: false, retryAfterSeconds: 0 }

  const now = Date.now()
  if (now - record.firstFailedTime > FAILED_LOGIN_WINDOW_MS) {
    failedLoginStore.delete(ip)
    return { isBlocked: false, retryAfterSeconds: 0 }
  }

  if (record.count >= MAX_FAILED_LOGIN_ATTEMPTS) {
    const retryAfterSeconds = Math.ceil(
      (record.firstFailedTime + FAILED_LOGIN_WINDOW_MS - now) / 1000,
    )
    return { isBlocked: true, retryAfterSeconds }
  }

  return { isBlocked: false, retryAfterSeconds: 0 }
}

function recordFailedLogin(ip: string) {
  const now = Date.now()
  const record = failedLoginStore.get(ip)

  if (!record || now - record.firstFailedTime > FAILED_LOGIN_WINDOW_MS) {
    failedLoginStore.set(ip, {
      count: 1,
      firstFailedTime: now,
      lastFailedTime: now,
    })
  } else {
    record.count += 1
    record.lastFailedTime = now
  }
}

function clearFailedLogins(ip: string) {
  failedLoginStore.delete(ip)
}

function toSafeUser(user: typeof users.$inferSelect): SafeUser {
  return {
    id: user.id,
    fullName: user.fullName,
    email: user.email,
    phone: user.phone,
    role: user.role,
    defaultAddress: user.defaultAddress,
    isActive: user.isActive,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
  }
}

/**
 * POST /api/auth/signup
 * Register a new customer account
 */
authRouter.post("/signup", async (c) => {
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

    const parseResult = signupSchema.safeParse(rawBody)
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
    const normalizedPhone = normalizeBdPhone(data.phone)
    const normalizedEmail = data.email.trim().toLowerCase()

    // Check for duplicate email (case-insensitive) or phone number
    const existingUsers = await db
      .select({ id: users.id, email: users.email, phone: users.phone })
      .from(users)
      .where(or(ilike(users.email, normalizedEmail), eq(users.phone, normalizedPhone)))
      .limit(1)

    if (existingUsers.length > 0) {
      const match = existingUsers[0]
      const field = match.email.toLowerCase() === normalizedEmail ? "email address" : "phone number"
      return c.json(
        {
          error: {
            code: "CONFLICT",
            message: `A user with this ${field} already exists`,
            details: null,
          },
        },
        409,
      )
    }

    // Hash password with bcrypt cost 12
    const passwordHash = await hashPassword(data.password)

    // Insert user with role 'CUSTOMER'
    const [newUser] = await db
      .insert(users)
      .values({
        fullName: data.fullName,
        email: normalizedEmail,
        phone: normalizedPhone,
        passwordHash,
        role: "CUSTOMER",
        defaultAddress: data.defaultAddress || null,
        isActive: true,
      })
      .returning()

    // Create session in Neon
    const sessionId = crypto.randomUUID()
    const ipAddress = getClientIp(c)
    const userAgent = c.req.header("user-agent") || null
    const expiresAt = new Date(Date.now() + SESSION_MAX_AGE_SECONDS * 1000)

    await db.insert(sessions).values({
      id: sessionId,
      userId: newUser.id,
      userAgent,
      ipAddress,
      expiresAt,
    })

    // Sign JWT and set bb_session cookie
    const token = await signSessionToken({
      sub: newUser.id,
      role: newUser.role,
      jti: sessionId,
    })

    setSessionCookie(c, token)

    // Record audit log entry
    await db.insert(auditLogs).values({
      actorId: newUser.id,
      action: "USER_SIGNUP",
      entityType: "USER",
      entityId: String(newUser.id),
      metadataJson: JSON.stringify({
        email: newUser.email,
        phone: newUser.phone,
        ipAddress,
      }),
    })

    return c.json(
      {
        data: {
          user: toSafeUser(newUser),
        },
      },
      201,
    )
  } catch (error) {
    console.error("Signup error:", error)
    return c.json(
      {
        error: {
          code: "SIGNUP_FAILED",
          message: "Failed to create account",
          details: error instanceof Error ? error.message : String(error),
        },
      },
      500,
    )
  }
})

/**
 * POST /api/auth/login
 * Authenticate with email/phone and password
 * Rate-limited: max 5 failed attempts per 15 minutes per IP
 */
authRouter.post("/login", async (c) => {
  const ip = getClientIp(c)

  // 1. Check rate limit on failed attempts
  const { isBlocked, retryAfterSeconds } = checkLoginRateLimit(ip)
  if (isBlocked) {
    c.header("Retry-After", String(retryAfterSeconds))
    return c.json(
      {
        error: {
          code: "RATE_LIMIT_EXCEEDED",
          message: "Too many failed login attempts. Please try again after 15 minutes.",
          details: {
            retryAfterSeconds,
            limit: MAX_FAILED_LOGIN_ATTEMPTS,
            windowMinutes: 15,
          },
        },
      },
      429,
    )
  }

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

    const parseResult = loginSchema.safeParse(rawBody)
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

    const { identifier, password } = parseResult.data
    const normalizedIdentifier = identifier.trim()
    const normalizedPhone = normalizeBdPhone(normalizedIdentifier)
    const normalizedEmail = normalizedIdentifier.toLowerCase()

    // Find user by either email (case-insensitive) or phone (normalized or raw)
    const matchedUsers = await db
      .select()
      .from(users)
      .where(
        or(
          ilike(users.email, normalizedEmail),
          eq(users.phone, normalizedPhone),
          eq(users.phone, normalizedIdentifier),
        ),
      )
      .limit(1)

    if (matchedUsers.length === 0) {
      recordFailedLogin(ip)
      return c.json(
        {
          error: {
            code: "INVALID_CREDENTIALS",
            message: "Invalid email/phone or password",
            details: null,
          },
        },
        401,
      )
    }

    const user = matchedUsers[0]

    // Verify account active
    if (!user.isActive) {
      return c.json(
        {
          error: {
            code: "ACCOUNT_DISABLED",
            message: "This account has been deactivated. Please contact support.",
            details: null,
          },
        },
        403,
      )
    }

    // Verify password hash
    const isPasswordValid = await verifyPassword(password, user.passwordHash)
    if (!isPasswordValid) {
      recordFailedLogin(ip)
      return c.json(
        {
          error: {
            code: "INVALID_CREDENTIALS",
            message: "Invalid email/phone or password",
            details: null,
          },
        },
        401,
      )
    }

    // Login succeeded - clear failed attempts
    clearFailedLogins(ip)

    // Create session in Neon
    const sessionId = crypto.randomUUID()
    const userAgent = c.req.header("user-agent") || null
    const expiresAt = new Date(Date.now() + SESSION_MAX_AGE_SECONDS * 1000)

    await db.insert(sessions).values({
      id: sessionId,
      userId: user.id,
      userAgent,
      ipAddress: ip,
      expiresAt,
    })

    // Sign JWT and set bb_session cookie
    const token = await signSessionToken({
      sub: user.id,
      role: user.role,
      jti: sessionId,
    })

    setSessionCookie(c, token)

    // Record login audit log
    await db.insert(auditLogs).values({
      actorId: user.id,
      action: "USER_LOGIN",
      entityType: "USER",
      entityId: String(user.id),
      metadataJson: JSON.stringify({
        ipAddress: ip,
        userAgent,
      }),
    })

    return c.json(
      {
        data: {
          user: toSafeUser(user),
        },
      },
      200,
    )
  } catch (error) {
    console.error("Login error:", error)
    return c.json(
      {
        error: {
          code: "LOGIN_FAILED",
          message: "Failed to authenticate",
          details: error instanceof Error ? error.message : String(error),
        },
      },
      500,
    )
  }
})

/**
 * POST /api/auth/logout
 * Terminate session in database and clear cookie
 */
authRouter.post("/logout", requireAuth, async (c) => {
  try {
    const session = c.get("session")
    const user = c.get("user")

    if (session) {
      await db.delete(sessions).where(eq(sessions.id, session.id))
    }

    clearSessionCookie(c)

    if (user) {
      await db.insert(auditLogs).values({
        actorId: user.id,
        action: "USER_LOGOUT",
        entityType: "USER",
        entityId: String(user.id),
        metadataJson: JSON.stringify({
          sessionId: session?.id,
        }),
      })
    }

    return c.json(
      {
        data: {
          message: "Successfully logged out",
        },
      },
      200,
    )
  } catch (error) {
    console.error("Logout error:", error)
    clearSessionCookie(c)
    return c.json(
      {
        data: {
          message: "Logged out successfully",
        },
      },
      200,
    )
  }
})

/**
 * GET /api/auth/me
 * Returns current authenticated user profile
 */
authRouter.get("/me", requireAuth, async (c) => {
  const user = c.get("user")
  return c.json(
    {
      data: {
        user,
      },
    },
    200,
  )
})

/**
 * PATCH /api/auth/profile
 * Update current user's profile information
 */
authRouter.patch("/profile", requireAuth, async (c) => {
  try {
    const user = c.get("user")!
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

    const parseResult = updateProfileSchema.safeParse(rawBody)
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

    // If updating phone, verify it's not taken by another user
    let normalizedPhone: string | undefined
    if (data.phone) {
      normalizedPhone = normalizeBdPhone(data.phone)
      const existing = await db
        .select({ id: users.id })
        .from(users)
        .where(and(eq(users.phone, normalizedPhone), ne(users.id, user.id)))
        .limit(1)

      if (existing.length > 0) {
        return c.json(
          {
            error: {
              code: "CONFLICT",
              message: "Phone number is already associated with another account",
              details: null,
            },
          },
          409,
        )
      }
    }

    const [updatedUser] = await db
      .update(users)
      .set({
        ...(data.fullName ? { fullName: data.fullName } : {}),
        ...(normalizedPhone ? { phone: normalizedPhone } : {}),
        ...(data.defaultAddress !== undefined ? { defaultAddress: data.defaultAddress } : {}),
        updatedAt: new Date(),
      })
      .where(eq(users.id, user.id))
      .returning()

    return c.json(
      {
        data: {
          user: toSafeUser(updatedUser),
        },
      },
      200,
    )
  } catch (error) {
    console.error("Update profile error:", error)
    return c.json(
      {
        error: {
          code: "UPDATE_PROFILE_FAILED",
          message: "Failed to update profile",
          details: error instanceof Error ? error.message : String(error),
        },
      },
      500,
    )
  }
})
