import bcrypt from "bcryptjs"
import { sign, verify } from "hono/jwt"
import { setCookie, deleteCookie, getCookie } from "hono/cookie"
import type { Context } from "hono"

export const SESSION_COOKIE_NAME = "bb_session"
export const SESSION_MAX_AGE_SECONDS = 7 * 24 * 60 * 60 // 7 days in seconds

export interface JwtSessionPayload {
  sub: number
  role: "CUSTOMER" | "STAFF" | "ADMIN"
  jti: string // Session ID in Neon database
  exp: number
  iat?: number
}

const DEV_JWT_SECRET = "banglar-biriyani-dev-jwt-secret-key-must-be-changed-in-prod"
const MIN_PRODUCTION_JWT_SECRET_LENGTH = 32
// Values copied from documentation that must never sign real sessions.
const KNOWN_PLACEHOLDER_SECRETS = new Set([DEV_JWT_SECRET, "change-me-to-a-long-random-string"])

/** True only for local development and tests. Anything else is treated as the live site. */
export function isDevOrTestEnv(): boolean {
  const env = process.env.NODE_ENV
  return env === "development" || env === "test"
}

export function getJwtSecret(): string {
  const secret = process.env.JWT_SECRET
  if (!secret) {
    // The built-in key is only for local development and tests. Anywhere else
    // (production, or NODE_ENV forgotten) a missing secret stops the server instead.
    if (!isDevOrTestEnv()) {
      throw new Error("CRITICAL SECURITY ERROR: JWT_SECRET environment variable is missing!")
    }
    return DEV_JWT_SECRET
  }
  // On the live site a short or copied-from-the-docs secret is as bad as none.
  if (
    !isDevOrTestEnv() &&
    (secret.length < MIN_PRODUCTION_JWT_SECRET_LENGTH || KNOWN_PLACEHOLDER_SECRETS.has(secret))
  ) {
    throw new Error(
      `CRITICAL SECURITY ERROR: JWT_SECRET is too weak. Use at least ${MIN_PRODUCTION_JWT_SECRET_LENGTH} random characters (see .env.example).`,
    )
  }
  return secret
}

/**
 * Hash password with bcryptjs (cost factor 12)
 */
export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, 12)
}

/**
 * Verify plaintext password against bcrypt hash
 */
export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  return bcrypt.compare(password, hash)
}

/**
 * Sign a JWT session token containing { sub: user.id, role: user.role, jti: sessionId }
 */
export async function signSessionToken(payload: {
  sub: number
  role: "CUSTOMER" | "STAFF" | "ADMIN"
  jti: string
  maxAgeSeconds?: number
}): Promise<string> {
  const exp = Math.floor(Date.now() / 1000) + (payload.maxAgeSeconds ?? SESSION_MAX_AGE_SECONDS)
  const secret = getJwtSecret()

  return sign(
    {
      sub: payload.sub,
      role: payload.role,
      jti: payload.jti,
      exp,
      iat: Math.floor(Date.now() / 1000),
    },
    secret,
    "HS256",
  )
}

/**
 * Verify and decode JWT session token
 */
export async function verifySessionToken(token: string): Promise<JwtSessionPayload | null> {
  try {
    const secret = getJwtSecret()
    const payload = await verify(token, secret, "HS256")
    return payload as unknown as JwtSessionPayload
  } catch {
    return null
  }
}

/**
 * Cookie attributes for bb_session: HttpOnly, SameSite=Lax, Path=/.
 * On the live site the cookie is always Secure. The site is only served over HTTPS, and
 * guessing the scheme behind a proxy (Netlify -> Supabase) could silently drop the flag.
 */
export function sessionCookieOptions() {
  return {
    path: "/",
    httpOnly: true,
    // Fail closed: only local development and tests get a cookie without Secure
    secure: !isDevOrTestEnv(),
    sameSite: "Lax" as const,
  }
}

/**
 * Set the bb_session cookie on Hono context (7-day max-age)
 */
export function setSessionCookie(c: Context, token: string) {
  setCookie(c, SESSION_COOKIE_NAME, token, {
    ...sessionCookieOptions(),
    maxAge: SESSION_MAX_AGE_SECONDS,
  })
}

/**
 * Clear the bb_session cookie on Hono context
 */
export function clearSessionCookie(c: Context) {
  deleteCookie(c, SESSION_COOKIE_NAME, sessionCookieOptions())
}

/**
 * Extract the session token from bb_session cookie (or Authorization: Bearer header)
 */
export function extractSessionToken(c: Context): string | null {
  const cookieVal = getCookie(c, SESSION_COOKIE_NAME)
  if (cookieVal) return cookieVal

  const authHeader = c.req.header("authorization")
  if (authHeader && authHeader.toLowerCase().startsWith("bearer ")) {
    return authHeader.slice(7).trim()
  }

  return null
}

/**
 * Bangladesh phone validation regex and normalizer
 * Accepts 01XXXXXXXXX, +8801XXXXXXXXX, 8801XXXXXXXXX
 */
export const BD_PHONE_REGEX = /^(?:\+?88\s*?)?01[3-9]\d{8}$/

export function normalizeBdPhone(phone: string): string {
  // Strip whitespace, hyphens, parentheses, and dots
  const cleaned = phone.replace(/[\s\-\(\)\.]/g, "")
  if (cleaned.startsWith("+8801")) {
    return cleaned.slice(3) // removes '+88', leaves '01...'
  }
  if (cleaned.startsWith("+881")) {
    return "0" + cleaned.slice(3) // removes '+88', prepends '0' -> '01...'
  }
  if (cleaned.startsWith("8801")) {
    return cleaned.slice(2) // removes '88', leaves '01...'
  }
  if (cleaned.startsWith("881")) {
    return "0" + cleaned.slice(2) // removes '88', prepends '0' -> '01...'
  }
  return cleaned
}
