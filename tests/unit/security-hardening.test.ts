import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest"
import fs from "node:fs"
import path from "node:path"
import type { Hono } from "hono"
import { createFailureLimiter, MAX_TRACKED_KEYS } from "../../server/middleware/rateLimiter.js"
import { errorDetails } from "../../server/utils/errors.js"
import { getJwtSecret, sessionCookieOptions } from "../../server/utils/auth.js"
import { isAllowedOrigin, toOrigin } from "../../server/utils/cors.js"
import { loginSchema, signupSchema } from "../../server/validators/authSchema.js"

const root = path.resolve(import.meta.dirname, "../..")
const ENV_KEYS = ["NODE_ENV", "JWT_SECRET", "SITE_URL", "ALLOWED_ORIGINS"] as const

// Every test starts from, and returns to, the same environment.
let saved: Record<string, string | undefined> = {}
beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]))
})
afterEach(() => {
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key]
    else process.env[key] = saved[key]
  }
})

describe("JWT secret strength on the live site", () => {
  const strong = "a".repeat(8) + "b".repeat(8) + "c".repeat(8) + "d".repeat(8)

  test("production rejects a short secret", () => {
    process.env.NODE_ENV = "production"
    process.env.JWT_SECRET = "too-short"
    expect(() => getJwtSecret()).toThrow(/too weak/)
  })

  test("production rejects the placeholders from the documentation", () => {
    process.env.NODE_ENV = "production"
    for (const placeholder of [
      "change-me-to-a-long-random-string",
      "banglar-biriyani-dev-jwt-secret-key-must-be-changed-in-prod",
    ]) {
      process.env.JWT_SECRET = placeholder
      expect(() => getJwtSecret(), placeholder).toThrow(/too weak/)
    }
  })

  test("a forgotten NODE_ENV is treated as the live site", () => {
    delete process.env.NODE_ENV
    process.env.JWT_SECRET = "too-short"
    expect(() => getJwtSecret()).toThrow(/too weak/)
  })

  test("production accepts a long random secret", () => {
    process.env.NODE_ENV = "production"
    process.env.JWT_SECRET = strong
    expect(getJwtSecret()).toBe(strong)
  })

  test("development and tests may use a short secret", () => {
    process.env.JWT_SECRET = "short"
    for (const env of ["development", "test"]) {
      process.env.NODE_ENV = env
      expect(getJwtSecret()).toBe("short")
    }
  })
})

describe("session cookie flags", () => {
  test("always HttpOnly, SameSite=Lax and site-wide", () => {
    for (const env of ["development", "test", "production"]) {
      process.env.NODE_ENV = env
      expect(sessionCookieOptions()).toMatchObject({ httpOnly: true, sameSite: "Lax", path: "/" })
    }
  })

  test("Secure on the live site whatever the proxy says about the scheme", () => {
    process.env.NODE_ENV = "production"
    expect(sessionCookieOptions().secure).toBe(true)
    process.env.NODE_ENV = "development"
    expect(sessionCookieOptions().secure).toBe(false)
  })

  test("a forgotten NODE_ENV still gets the Secure flag", () => {
    delete process.env.NODE_ENV
    expect(sessionCookieOptions().secure).toBe(true)
    process.env.NODE_ENV = ""
    expect(sessionCookieOptions().secure).toBe(true)
  })
})

describe("error details fail closed", () => {
  test("hidden unless NODE_ENV is development or test", () => {
    const error = new Error("relation users does not exist")
    for (const env of ["production", "", "staging"]) {
      process.env.NODE_ENV = env
      expect(errorDetails(error), `NODE_ENV=${env}`).toBeNull()
    }
    delete process.env.NODE_ENV
    expect(errorDetails(error)).toBeNull()
    process.env.NODE_ENV = "test"
    expect(errorDetails(error)).toBe("relation users does not exist")
  })
})

describe("rate limiter memory", () => {
  test("never tracks more than the cap, even when every key is new", () => {
    const limiter = createFailureLimiter(5, 60_000)
    for (let i = 0; i < MAX_TRACKED_KEYS + 50; i++) limiter.recordFailure(`10.0.${i >> 8}.${i & 255}-${i}`)
    expect(limiter.size()).toBeLessThanOrEqual(MAX_TRACKED_KEYS)
    limiter.reset()
  })

  test("a successful login can forget the address", () => {
    const limiter = createFailureLimiter(2, 60_000)
    limiter.recordFailure("9.9.9.9")
    limiter.recordFailure("9.9.9.9")
    expect(limiter.retryAfterSeconds("9.9.9.9")).toBeGreaterThan(0)
    limiter.clear("9.9.9.9")
    expect(limiter.retryAfterSeconds("9.9.9.9")).toBe(0)
  })
})

describe("login brute-force lock", () => {
  test("the login route is configured for 5 failures per 15 minutes", () => {
    const source = fs.readFileSync(path.join(root, "server/routes/auth.ts"), "utf-8")
    expect(source).toMatch(/MAX_FAILED_LOGIN_ATTEMPTS\s*=\s*5\b/)
    expect(source).toMatch(/FAILED_LOGIN_WINDOW_MS\s*=\s*15\s*\*\s*60\s*\*\s*1000/)
    expect(source).toMatch(/createFailureLimiter\(MAX_FAILED_LOGIN_ATTEMPTS,\s*FAILED_LOGIN_WINDOW_MS\)/)
  })

  test("the 5th wrong try locks that address for the rest of 15 minutes, others stay free", () => {
    const limiter = createFailureLimiter(5, 15 * 60 * 1000)
    for (let i = 0; i < 4; i++) limiter.recordFailure("203.0.113.7")
    expect(limiter.retryAfterSeconds("203.0.113.7")).toBe(0)
    limiter.recordFailure("203.0.113.7")
    const wait = limiter.retryAfterSeconds("203.0.113.7")
    expect(wait).toBeGreaterThan(14 * 60)
    expect(wait).toBeLessThanOrEqual(15 * 60)
    expect(limiter.retryAfterSeconds("203.0.113.8")).toBe(0)
  })

  test("the lock ends once the 15 minutes are over", () => {
    vi.useFakeTimers()
    try {
      const limiter = createFailureLimiter(5, 15 * 60 * 1000)
      for (let i = 0; i < 5; i++) limiter.recordFailure("203.0.113.9")
      expect(limiter.retryAfterSeconds("203.0.113.9")).toBeGreaterThan(0)
      vi.advanceTimersByTime(15 * 60 * 1000 + 1000)
      expect(limiter.retryAfterSeconds("203.0.113.9")).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe("password length limits", () => {
  const signup = (password: string) =>
    signupSchema.safeParse({
      fullName: "Test User",
      email: "test@example.com",
      phone: "01711000000",
      password,
    })

  test("sign-up accepts 8 to 72 characters (bcrypt reads at most 72)", () => {
    expect(signup("a".repeat(8)).success).toBe(true)
    expect(signup("a".repeat(72)).success).toBe(true)
    expect(signup("a".repeat(7)).success).toBe(false)
    expect(signup("a".repeat(73)).success).toBe(false)
  })

  test("login refuses absurdly long passwords but keeps room for old ones", () => {
    expect(loginSchema.safeParse({ identifier: "01711000000", password: "a".repeat(200) }).success).toBe(true)
    expect(loginSchema.safeParse({ identifier: "01711000000", password: "a".repeat(201) }).success).toBe(false)
  })
})

describe("CORS origin rules", () => {
  test("toOrigin normalises case and trailing slashes and drops wildcards", () => {
    expect(toOrigin("https://Shop.Example.com/")).toBe("https://shop.example.com")
    expect(toOrigin("  https://shop.example.com/menu?x=1 ")).toBe("https://shop.example.com")
    expect(toOrigin("*")).toBeNull()
    expect(toOrigin("javascript:alert(1)")).toBeNull()
    expect(toOrigin("")).toBeNull()
  })

  test("the live Netlify site is always allowed, other sites are not", () => {
    process.env.NODE_ENV = "production"
    delete process.env.SITE_URL
    delete process.env.ALLOWED_ORIGINS
    expect(isAllowedOrigin("https://banglarbiriyani.netlify.app")).toBe(true)
    expect(isAllowedOrigin("https://evil.netlify.app")).toBe(false)
    expect(isAllowedOrigin("https://banglarbiriyani.netlify.app.evil.example")).toBe(false)
    expect(isAllowedOrigin(undefined)).toBe(false)
  })

  test("SITE_URL replaces the default and ALLOWED_ORIGINS entries are forgiving", () => {
    process.env.NODE_ENV = "production"
    process.env.SITE_URL = "https://www.client-domain.com/"
    process.env.ALLOWED_ORIGINS = " https://Client-Domain.com/ , https://preview--shop.netlify.app "
    expect(isAllowedOrigin("https://www.client-domain.com")).toBe(true)
    expect(isAllowedOrigin("https://client-domain.com")).toBe(true)
    expect(isAllowedOrigin("https://preview--shop.netlify.app")).toBe(true)
    expect(isAllowedOrigin("https://banglarbiriyani.netlify.app")).toBe(false)
  })

  test("a wildcard in ALLOWED_ORIGINS does not open the API to everyone", () => {
    process.env.NODE_ENV = "production"
    process.env.ALLOWED_ORIGINS = "*"
    expect(isAllowedOrigin("https://evil.example")).toBe(false)
  })

  test("localhost is trusted only while developing or testing", () => {
    process.env.NODE_ENV = "development"
    expect(isAllowedOrigin("http://localhost:5173")).toBe(true)
    process.env.NODE_ENV = "production"
    expect(isAllowedOrigin("http://localhost:5173")).toBe(false)
    expect(isAllowedOrigin("http://127.0.0.1:3001")).toBe(false)
    delete process.env.NODE_ENV
    expect(isAllowedOrigin("http://localhost:5173")).toBe(false)
  })
})

describe("email lookups", () => {
  test("login and sign-up never use ilike, which treats % and _ typed by a visitor as wildcards", () => {
    const source = fs.readFileSync(path.join(root, "server/routes/auth.ts"), "utf-8")
    expect(source).not.toMatch(/\bilike\(/)
    expect(source).toContain("lower(${users.email})")
  })
})

describe("API middleware", () => {
  let app: Hono

  beforeAll(async () => {
    process.env.DATABASE_URL ||= "postgresql://ci:ci@localhost:5432/ci"
    process.env.NODE_ENV = "test"
    app = (await import("../../server/index.js")).app
  })

  test("the live Netlify site gets credentialed CORS access in production", async () => {
    process.env.NODE_ENV = "production"
    const res = await app.request("/api/health", {
      headers: { Origin: "https://banglarbiriyani.netlify.app" },
    })
    expect(res.headers.get("access-control-allow-origin")).toBe("https://banglarbiriyani.netlify.app")
    expect(res.headers.get("access-control-allow-credentials")).toBe("true")
  })

  test("localhost gets no CORS access in production", async () => {
    process.env.NODE_ENV = "production"
    const res = await app.request("/api/health", { headers: { Origin: "http://localhost:5173" } })
    expect(res.headers.get("access-control-allow-origin")).toBeFalsy()
  })

  test("an oversized request body is refused with 413", async () => {
    process.env.NODE_ENV = "test"
    const body = JSON.stringify({ identifier: "x".repeat(300 * 1024), password: "y" })
    const res = await app.request("/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json", "content-length": String(Buffer.byteLength(body)) },
      body,
    })
    expect(res.status).toBe(413)
    const json = (await res.json()) as { error: { code: string } }
    expect(json.error.code).toBe("PAYLOAD_TOO_LARGE")
  })
})

describe("seed script safety", () => {
  const seed = fs.readFileSync(path.join(root, "src/db/seed.ts"), "utf-8")

  test("refuses a missing admin password before anything is erased", () => {
    const passwordCheck = seed.indexOf("STOP: set SEED_ADMIN_PASSWORD")
    const firstErase = seed.indexOf("TRUNCATE TABLE")
    expect(passwordCheck).toBeGreaterThan(-1)
    expect(firstErase).toBeGreaterThan(-1)
    expect(passwordCheck).toBeLessThan(firstErase)
  })

  test("the built-in demo password is only reachable in test-data mode", () => {
    const uses = [...seed.matchAll(/"Admin@1234"/g)]
    expect(uses).toHaveLength(1)
    expect(seed).toMatch(/process\.env\.SEED_ADMIN_PASSWORD \|\| \(withDemo \? "Admin@1234" : ""\)/)
  })
})

describe(".env.example completeness", () => {
  function sourceFiles(dir: string): string[] {
    return fs
      .readdirSync(path.join(root, dir), { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(".ts"))
      .map((entry) => path.join(entry.parentPath, entry.name))
  }

  test("documents every environment variable the code reads", () => {
    const example = fs.readFileSync(path.join(root, ".env.example"), "utf-8")
    const used = new Set<string>()
    for (const file of [...sourceFiles("server"), ...sourceFiles("src")]) {
      for (const match of fs.readFileSync(file, "utf-8").matchAll(/process\.env\.([A-Z][A-Z0-9_]*)/g)) {
        used.add(match[1])
      }
    }
    expect(used.size).toBeGreaterThan(5)
    for (const name of used) {
      // Optional or one-off settings are listed as commented lines ("# NAME=...").
      expect(example, name).toMatch(new RegExp(`^#?\\s*${name}=`, "m"))
    }
  })

  test("ships only placeholders for secrets", () => {
    const example = fs.readFileSync(path.join(root, ".env.example"), "utf-8")
    expect(example).toMatch(/^JWT_SECRET=change-me-to-a-long-random-string$/m)
    expect(example).toMatch(/^BREVO_API_KEY=$/m)
    expect(example).toMatch(/^SEED_ADMIN_PASSWORD=$/m)
    expect(example).not.toMatch(/xkeysib-/)
  })
})
