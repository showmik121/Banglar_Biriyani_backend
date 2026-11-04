import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import { sendOrderEmail, type OrderEmailData } from "../../server/utils/email.js"

const order: OrderEmailData = {
  orderNumber: "BB-20261105-1234567",
  customerName: "Rahim",
  customerAddress: "House 1, Road 2, Dhaka",
  totalBdt: 450,
  paymentMethod: "COD",
  items: [{ name: "Kacchi Biriyani", quantity: 1, lineTotalBdt: 450 }],
}

const ENV_KEYS = ["BREVO_API_KEY", "EMAIL_FROM", "EMAIL_FROM_NAME", "SITE_URL"] as const
let saved: Record<string, string | undefined> = {}

beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]))
})

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key]
    else process.env[key] = saved[key]
  }
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

// The first test must be the one that sees the missing settings: the warning is logged once per start.
describe("missing email settings", () => {
  test("skips the email, tells the logs once and names only the setting, never a value", async () => {
    delete process.env.BREVO_API_KEY
    delete process.env.EMAIL_FROM
    const fetchMock = vi.fn()
    vi.stubGlobal("fetch", fetchMock)
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})

    await expect(sendOrderEmail("a@example.com", "PLACED", order)).resolves.toBeUndefined()
    await expect(sendOrderEmail("a@example.com", "PLACED", order)).resolves.toBeUndefined()

    expect(fetchMock).not.toHaveBeenCalled()
    expect(warn).toHaveBeenCalledTimes(1)
    expect(String(warn.mock.calls[0][0])).toContain("BREVO_API_KEY")
  })
})

describe("email problems never reach the caller", () => {
  beforeEach(() => {
    process.env.BREVO_API_KEY = "test-key-not-real"
    process.env.EMAIL_FROM = "shop@example.com"
  })

  test("an email that cannot even be built does not throw", async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal("fetch", fetchMock)
    const error = vi.spyOn(console, "error").mockImplementation(() => {})
    const broken = { ...order, customerName: null as unknown as string }

    await expect(sendOrderEmail("a@example.com", "PLACED", broken)).resolves.toBeUndefined()

    expect(fetchMock).not.toHaveBeenCalled()
    expect(error).toHaveBeenCalled()
    expect(String(error.mock.calls[0][0])).toContain(order.orderNumber)
  })

  test("Brevo answering 500 is logged with the order number and kind, and does not throw", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("service unavailable", { status: 503 })))
    const error = vi.spyOn(console, "error").mockImplementation(() => {})

    await expect(sendOrderEmail("a@example.com", "CONFIRMED", order)).resolves.toBeUndefined()

    const line = String(error.mock.calls[0][0])
    expect(line).toContain("503")
    expect(line).toContain(order.orderNumber)
    expect(line).toContain("CONFIRMED")
  })

  test("a hanging or unreachable Brevo (timeout, DNS, network) does not throw", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new DOMException("timed out", "TimeoutError")))
    const error = vi.spyOn(console, "error").mockImplementation(() => {})

    await expect(sendOrderEmail("a@example.com", "DELIVERED", order)).resolves.toBeUndefined()

    expect(error).toHaveBeenCalled()
  })

  test("the API key is sent to Brevo but never written to the logs", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("bad key", { status: 401 })))
    const error = vi.spyOn(console, "error").mockImplementation(() => {})

    await sendOrderEmail("a@example.com", "PLACED", order)

    const logged = JSON.stringify(error.mock.calls)
    expect(logged).not.toContain("test-key-not-real")
  })

  test("guest orders without an email address are skipped quietly", async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal("fetch", fetchMock)

    await expect(sendOrderEmail(null, "PLACED", order)).resolves.toBeUndefined()
    await expect(sendOrderEmail(undefined, "PLACED", order)).resolves.toBeUndefined()

    expect(fetchMock).not.toHaveBeenCalled()
  })
})
