import { describe, expect, test } from "vitest"
import { createMenuItemSchema, updateMenuItemSchema } from "../../server/validators/adminSchema"

const base = { categoryId: 1, name: "Kacchi", description: "Mutton kacchi", basePriceBdt: 300 }

describe("dish photo reference", () => {
  test("accepts a web link or an uploaded photo", () => {
    expect(createMenuItemSchema.safeParse({ ...base, imageUrl: "https://x.test/a.jpg" }).success).toBe(true)
    expect(createMenuItemSchema.safeParse({ ...base, imageUrl: "/api/images/12" }).success).toBe(true)
    expect(updateMenuItemSchema.safeParse({ imageUrl: "/api/images/3" }).success).toBe(true)
  })
  test("rejects anything else", () => {
    for (const imageUrl of ["javascript:alert(1)", "/api/images/x", "/other/1", "", "//evil.test/a.jpg"]) {
      expect(createMenuItemSchema.safeParse({ ...base, imageUrl }).success).toBe(false)
    }
  })
})
