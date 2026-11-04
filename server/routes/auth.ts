import { Hono } from "hono"
import { eq, or, and, ne, sql } from "drizzle-orm"
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
import { getClientIp, createFailureLimiter, createRequestLimiter } from "../middleware/rateLimiter.js"
import { errorDetails } from "../utils/errors.js"

export const authRouter = new Hono()

// Failed login attempts per IP: max 5 in a 15 minute window (the store is size-capped).
const FAILED_LOGIN_WINDOW_MS = 15 * 60 * 1000 // 15 minutes
const MAX_FAILED_LOGIN_ATTEMPTS = 5
const ipFailures = createFailureLimiter(MAX_FAILED_LOGIN_ATTEMPTS, FAILED_LOGIN_WINDOW_MS)
// Also count wrong passwords per account, so guessing one account's password stays slow
// even when the visitor changes address between tries.
const accountFailures = createFailureLimiter(10, FAILED_LOGIN_WINDOW_MS)

// Exact, case-insensitive email match. ilike would treat "%" and "_" typed by a visitor as
// wildcards (so "%@gmail.com" matched somebody else's account and "_" matched any character).
const emailEquals = (lowerCaseEmail: string) => sql`lower(${users.email}) = ${lowerCaseEmail}`

// An unknown account still costs one bcrypt check, so the response time does not reveal
// whether an email or phone number is registered.
let dummyHashPromise: Promise<string> | null = null
const getDummyHash = () => (dummyHashPromise ??= hashPassword("timing-equaliser-not-a-real-password"))

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
// Limits sign-ups from one address (a campus or office can share one address, so this is generous)
const signupLimiter = createRequestLimiter(
  20,
  15 * 60 * 1000,
  "Too many sign-up attempts. Please wait a few minutes and try again.",
)
authRouter.post("/signup", signupLimiter, async (c) => {
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
    const normalizedEmail = data.email ? data.email.trim().toLowerCase() : null

    // Check for a duplicate phone number, or email (case-insensitive) when one was given
    const existingUsers = await db
      .select({ id: users.id, email: users.email, phone: users.phone })
      .from(users)
      .where(
        normalizedEmail
          ? or(emailEquals(normalizedEmail), eq(users.phone, normalizedPhone))
          : eq(users.phone, normalizedPhone),
      )
      .limit(1)

    if (existingUsers.length > 0) {
      const match = existingUsers[0]
      const field = match.phone === normalizedPhone ? "mobile number" : "email address"
      return c.json(
        {
          error: {
            code: "CONFLICT",
            message: `An account with this ${field} already exists. Please sign in instead.`,
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
          details: errorDetails(error),
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
  const retryAfterSeconds = ipFailures.retryAfterSeconds(ip)
  if (retryAfterSeconds > 0) {
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
    const accountKey = `acct:${normalizedPhone || normalizedEmail}`
    const accountWait = accountFailures.retryAfterSeconds(accountKey)
    if (accountWait > 0) {
      c.header("Retry-After", String(accountWait))
      return c.json(
        {
          error: {
            code: "RATE_LIMIT_EXCEEDED",
            message: "Too many failed login attempts. Please try again after 15 minutes.",
            details: { retryAfterSeconds: accountWait },
          },
        },
        429,
      )
    }

    // Find user by either email (case-insensitive) or phone (normalized or raw)
    const matchedUsers = await db
      .select()
      .from(users)
      .where(
        or(
          emailEquals(normalizedEmail),
          eq(users.phone, normalizedPhone),
          eq(users.phone, normalizedIdentifier),
        ),
      )
      .limit(1)

    if (matchedUsers.length === 0) {
      await verifyPassword(password, await getDummyHash())
      ipFailures.recordFailure(ip)
      accountFailures.recordFailure(accountKey)
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

    // Verify password hash first, so a deactivated account is only revealed to someone
    // who knows its password (otherwise anyone could probe which accounts exist and are off).
    const isPasswordValid = await verifyPassword(password, user.passwordHash)
    if (!isPasswordValid) {
      ipFailures.recordFailure(ip)
      accountFailures.recordFailure(accountKey)
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

    // Correct password but the account was switched off by the shop
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

    // Login succeeded - clear failed attempts
    ipFailures.clear(ip)

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
          details: errorDetails(error),
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
          details: errorDetails(error),
        },
      },
      500,
    )
  }
})
