import { describe, test, expect, beforeEach, afterEach } from "vitest"
import {
  BD_PHONE_REGEX,
  getJwtSecret,
  hashPassword,
  normalizeBdPhone,
  signSessionToken,
  verifyPassword,
  verifySessionToken,
} from "../../server/utils/auth.js"

describe("normalizeBdPhone", () => {
  test.each([
    ["01711000000", "01711000000"],
    ["+8801711000000", "01711000000"],
    ["8801711000000", "01711000000"],
    ["017-1100-0000", "01711000000"],
    ["(017) 1100 0000", "01711000000"],
  ])("%s -> %s", (input, expected) => {
    expect(normalizeBdPhone(input)).toBe(expected)
  })
})

describe("BD_PHONE_REGEX", () => {
  test("accepts valid Bangladesh mobile numbers", () => {
    for (const n of ["01311111111", "01911111111", "+8801711000000", "8801811000000"]) {
      expect(BD_PHONE_REGEX.test(n)).toBe(true)
    }
  })

  test("rejects invalid numbers", () => {
    for (const n of ["01211111111", "0171100000", "017110000000", "abcdefghijk", ""]) {
      expect(BD_PHONE_REGEX.test(n)).toBe(false)
    }
  })
})

describe("password hashing", () => {
  test("hash is not the plain password and verifies correctly", async () => {
    const hash = await hashPassword("biriyani-123")
    expect(hash).not.toBe("biriyani-123")
    expect(await verifyPassword("biriyani-123", hash)).toBe(true)
    expect(await verifyPassword("wrong-password", hash)).toBe(false)
  })
})

describe("JWT session tokens", () => {
  const originalEnv = { ...process.env }

  beforeEach(() => {
    process.env.JWT_SECRET = "unit-test-secret"
    process.env.NODE_ENV = "test"
  })

  afterEach(() => {
    process.env = { ...originalEnv }
  })

  test("a signed token verifies and keeps its payload", async () => {
    const token = await signSessionToken({ sub: 42, role: "CUSTOMER", jti: "session-1" })
    const payload = await verifySessionToken(token)
    expect(payload?.sub).toBe(42)
    expect(payload?.role).toBe("CUSTOMER")
    expect(payload?.jti).toBe("session-1")
  })

  test("a tampered token is rejected", async () => {
    const token = await signSessionToken({ sub: 1, role: "ADMIN", jti: "s" })
    const tampered = token.slice(0, -2) + (token.endsWith("aa") ? "bb" : "aa")
    expect(await verifySessionToken(tampered)).toBeNull()
  })

  test("a token signed with another secret is rejected", async () => {
    const token = await signSessionToken({ sub: 1, role: "STAFF", jti: "s" })
    process.env.JWT_SECRET = "a-different-secret"
    expect(await verifySessionToken(token)).toBeNull()
  })

  test("an expired token is rejected", async () => {
    const token = await signSessionToken({ sub: 1, role: "CUSTOMER", jti: "s", maxAgeSeconds: -10 })
    expect(await verifySessionToken(token)).toBeNull()
  })

  test("production refuses to start without JWT_SECRET", () => {
    delete process.env.JWT_SECRET
    process.env.NODE_ENV = "production"
    expect(() => getJwtSecret()).toThrow(/JWT_SECRET/)
  })
})
