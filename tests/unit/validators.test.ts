import { describe, test, expect } from "vitest"
import { signupSchema, loginSchema } from "../../server/validators/authSchema.js"
import { createOrderSchema, sanitizeString } from "../../server/validators/orderSchema.js"

const validOrder = {
  customerName: "Rahim Uddin",
  customerPhone: "01711000000",
  customerAddress: "DIU Hostel, Daffodil Smart City, Savar",
  scheduledDay: "saturday",
  items: [{ menuItemId: 1, quantity: 2 }],
}

describe("signupSchema", () => {
  test("accepts a valid signup and normalises email and phone", () => {
    const result = signupSchema.parse({
      fullName: "  Karim Ahmed ",
      email: "Karim@Example.COM",
      phone: "+8801811000000",
      password: "strongpass1",
    })
    expect(result.fullName).toBe("Karim Ahmed")
    expect(result.email).toBe("karim@example.com")
    expect(result.phone).toBe("01811000000")
  })

  test("email is needed for order updates", () => {
    const missing = signupSchema.safeParse({ fullName: "Karim", phone: "01811000000", password: "strongpass1" })
    expect(missing.success).toBe(false)
    const bad = signupSchema.safeParse({ fullName: "Karim", email: "karim", phone: "01811000000", password: "strongpass1" })
    expect(bad.success).toBe(false)
  })

  test("rejects a short password", () => {
    const r = signupSchema.safeParse({
      fullName: "Karim",
      email: "k@example.com",
      phone: "01811000000",
      password: "123",
    })
    expect(r.success).toBe(false)
  })

  test("rejects a non-Bangladesh phone number", () => {
    const r = signupSchema.safeParse({
      fullName: "Karim",
      email: "k@example.com",
      phone: "12345",
      password: "strongpass1",
    })
    expect(r.success).toBe(false)
  })
})

describe("loginSchema", () => {
  test("requires identifier and password", () => {
    expect(loginSchema.safeParse({ identifier: "01711000000", password: "x" }).success).toBe(true)
    expect(loginSchema.safeParse({ identifier: "", password: "x" }).success).toBe(false)
    expect(loginSchema.safeParse({ identifier: "01711000000" }).success).toBe(false)
  })
})

describe("sanitizeString", () => {
  test("strips scripts, tags and null bytes", () => {
    expect(sanitizeString("<script>alert(1)</script>Hello")).toBe("Hello")
    expect(sanitizeString("<b>Bold</b> text")).toBe("Bold text")
    expect(sanitizeString("a\0b")).toBe("ab")
    expect(sanitizeString(null)).toBe("")
  })
})

describe("createOrderSchema", () => {
  test("accepts a valid cash-on-delivery order and fills defaults", () => {
    const result = createOrderSchema.parse(validOrder)
    expect(result.scheduledDay).toBe("SATURDAY")
    expect(result.paymentMethod).toBe("COD")
    expect(result.deliverySlot).toBeTruthy()
  })

  test("rejects an empty cart", () => {
    expect(createOrderSchema.safeParse({ ...validOrder, items: [] }).success).toBe(false)
  })

  test("rejects quantity above 50 or below 1", () => {
    for (const quantity of [0, 51]) {
      const r = createOrderSchema.safeParse({ ...validOrder, items: [{ menuItemId: 1, quantity }] })
      expect(r.success).toBe(false)
    }
  })

  test("requires a transaction ID for bKash and Nagad", () => {
    expect(createOrderSchema.safeParse({ ...validOrder, paymentMethod: "BKASH" }).success).toBe(false)
    expect(
      createOrderSchema.safeParse({ ...validOrder, paymentMethod: "NAGAD", paymentTrxId: "8N7A6D5X" })
        .success,
    ).toBe(true)
  })

  test("removes HTML from the customer name", () => {
    const result = createOrderSchema.parse({
      ...validOrder,
      customerName: "<img src=x onerror=alert(1)>Rahim",
    })
    expect(result.customerName).toBe("Rahim")
  })
})
