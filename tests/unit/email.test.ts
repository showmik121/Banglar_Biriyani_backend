import { afterEach, describe, expect, it, vi } from "vitest"
import { EMAIL_STATUSES, buildOrderEmail, sendOrderEmail } from "../../server/utils/email"

const order = {
  orderNumber: "BB-20261104-1234",
  customerName: "Rahim <b>",
  customerAddress: "House 5, Road 2",
  totalBdt: 1250,
  paymentMethod: "COD",
  items: [{ name: "Kacchi Biriyani", quantity: 2, lineTotalBdt: 1250 }],
}

afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

describe("order emails", () => {
  it("builds a subject, escaped html and plain text", () => {
    const m = buildOrderEmail("OUT_FOR_DELIVERY", order, "https://example.com")
    expect(m.subject).toBe("Your order is on the way · BB-20261104-1234")
    expect(m.html).toContain("Rahim &lt;b&gt;")
    expect(m.html).not.toContain("Rahim <b>")
    expect(m.html).toContain("৳1,250")
    expect(m.text).toContain("2 x Kacchi Biriyani")
    expect(m.text).toContain("https://example.com")
  })

  it("emails only on the main status changes", () => {
    expect([...EMAIL_STATUSES].sort()).toEqual(["CANCELLED", "CONFIRMED", "DELIVERED", "OUT_FOR_DELIVERY"])
  })

  it("does nothing without an API key or address", async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal("fetch", fetchMock)
    vi.stubEnv("BREVO_API_KEY", "")
    vi.stubEnv("EMAIL_FROM", "shop@example.com")
    await sendOrderEmail("a@example.com", "PLACED", order)
    vi.stubEnv("BREVO_API_KEY", "test-key")
    await sendOrderEmail(null, "PLACED", order)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("posts to Brevo and never throws when it fails", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("bad", { status: 401 }))
    vi.stubGlobal("fetch", fetchMock)
    vi.stubEnv("BREVO_API_KEY", "test-key")
    vi.stubEnv("EMAIL_FROM", "shop@example.com")
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {})
    await expect(sendOrderEmail("a@example.com", "PLACED", order)).resolves.toBeUndefined()
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe("https://api.brevo.com/v3/smtp/email")
    const body = JSON.parse(init.body)
    expect(body.to[0].email).toBe("a@example.com")
    expect(body.sender.email).toBe("shop@example.com")
    expect(init.headers["api-key"]).toBe("test-key")
    fetchMock.mockRejectedValueOnce(new Error("network down"))
    await expect(sendOrderEmail("a@example.com", "DELIVERED", order)).resolves.toBeUndefined()
    errSpy.mockRestore()
  })
})
