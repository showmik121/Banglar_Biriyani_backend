import type { Context, MiddlewareHandler } from "hono"
import { eq, and, gt } from "drizzle-orm"
import { db, users, sessions, type User, type Session } from "../../src/db/index.js"
import { extractSessionToken, verifySessionToken } from "../utils/auth.js"

export type SafeUser = Omit<User, "passwordHash">

declare module "hono" {
  interface ContextVariableMap {
    user?: SafeUser
    session?: Session
  }
}

/**
 * Helper to validate session from request and fetch associated active user
 */
async function authenticateRequest(
  c: Context,
): Promise<{ user: SafeUser; session: Session } | null> {
  const token = extractSessionToken(c)
  if (!token) return null

  const payload = await verifySessionToken(token)
  if (!payload || !payload.jti) return null

  try {
    const now = new Date()
    const rows = await db
      .select({
        sessionId: sessions.id,
        sessionUserId: sessions.userId,
        sessionUserAgent: sessions.userAgent,
        sessionIpAddress: sessions.ipAddress,
        sessionExpiresAt: sessions.expiresAt,
        sessionCreatedAt: sessions.createdAt,
        userId: users.id,
        userFullName: users.fullName,
        userEmail: users.email,
        userPhone: users.phone,
        userRole: users.role,
        userDefaultAddress: users.defaultAddress,
        userIsActive: users.isActive,
        userCreatedAt: users.createdAt,
        userUpdatedAt: users.updatedAt,
      })
      .from(sessions)
      .innerJoin(users, eq(sessions.userId, users.id))
      .where(and(eq(sessions.id, payload.jti), gt(sessions.expiresAt, now)))
      .limit(1)

    if (rows.length === 0) return null

    const row = rows[0]
    if (!row.userIsActive) return null

    const session: Session = {
      id: row.sessionId,
      userId: row.sessionUserId,
      userAgent: row.sessionUserAgent,
      ipAddress: row.sessionIpAddress,
      expiresAt: row.sessionExpiresAt,
      createdAt: row.sessionCreatedAt,
    }

    const user: SafeUser = {
      id: row.userId,
      fullName: row.userFullName,
      email: row.userEmail,
      phone: row.userPhone,
      role: row.userRole,
      defaultAddress: row.userDefaultAddress,
      isActive: row.userIsActive,
      createdAt: row.userCreatedAt,
      updatedAt: row.userUpdatedAt,
    }

    return { user, session }
  } catch (err) {
    console.error("[authMiddleware] Database session verification error:", err)
    return null
  }
}

/**
 * optionalAuth Middleware
 * Parses session cookie/header if present and attaches user to context.
 * Does NOT fail or return 401 if missing or invalid (used for endpoints like POST /api/orders).
 */
export const optionalAuth: MiddlewareHandler = async (c, next) => {
  const auth = await authenticateRequest(c)
  if (auth) {
    c.set("user", auth.user)
    c.set("session", auth.session)
  }
  await next()
}

/**
 * requireAuth Middleware
 * Verifies session and Neon database record. Returns 401 Unauthorized if absent or expired.
 */
export const requireAuth: MiddlewareHandler = async (c, next) => {
  const auth = await authenticateRequest(c)

  if (!auth) {
    return c.json(
      {
        error: {
          code: "UNAUTHORIZED",
          message: "Authentication required. Please sign in.",
          details: null,
        },
      },
      401,
    )
  }

  c.set("user", auth.user)
  c.set("session", auth.session)
  await next()
}

/**
 * requireRole Middleware (Higher-order middleware)
 * Runs requireAuth and verifies allowedRoles.includes(user.role).
 * Returns 403 Forbidden with structured JSON if role is unauthorized.
 */
export function requireRole(allowedRoles: ("CUSTOMER" | "STAFF" | "ADMIN")[]): MiddlewareHandler {
  return async (c, next) => {
    // If not authenticated yet, run authentication check
    let user = c.get("user")
    if (!user) {
      const auth = await authenticateRequest(c)
      if (!auth) {
        return c.json(
          {
            error: {
              code: "UNAUTHORIZED",
              message: "Authentication required. Please sign in.",
              details: null,
            },
          },
          401,
        )
      }
      user = auth.user
      c.set("user", auth.user)
      c.set("session", auth.session)
    }

    if (!allowedRoles.includes(user.role)) {
      return c.json(
        {
          error: {
            code: "FORBIDDEN",
            message: "Insufficient permissions",
            details: {
              userRole: user.role,
              requiredRoles: allowedRoles,
            },
          },
        },
        403,
      )
    }

    await next()
  }
}
