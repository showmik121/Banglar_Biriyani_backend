import { describe, test, expect } from "vitest"
import { phoneKey, samePhone } from "../../server/utils/phone.js"

describe("phone matching for order tracking", () => {
  test("ignores spaces, dashes and the +880 country code", () => {
    expect(phoneKey("+880 1711-000001")).toBe("1711000001")
    expect(samePhone("01711000001", "+8801711000001")).toBe(true)
    expect(samePhone("01711 000 001", "01711-000001")).toBe(true)
  })

  test("different or too-short numbers never match", () => {
    expect(samePhone("01711000001", "01711000002")).toBe(false)
    expect(samePhone("", "")).toBe(false)
    expect(samePhone("123", "123")).toBe(false)
  })
})
