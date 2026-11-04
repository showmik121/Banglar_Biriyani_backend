import { describe, expect, test } from "vitest"
import { dhakaNow, isMealOpen, mealForHour, windowText } from "../../server/utils/mealWindows.js"

describe("meal hours", () => {
  test("lunch is 12 to 4 pm, dinner is 6 to 10 pm", () => {
    expect(isMealOpen("LUNCH", 11.99)).toBe(false)
    expect(isMealOpen("LUNCH", 12)).toBe(true)
    expect(isMealOpen("LUNCH", 15.99)).toBe(true)
    expect(isMealOpen("LUNCH", 16)).toBe(false)
    expect(isMealOpen("DINNER", 17.5)).toBe(false)
    expect(isMealOpen("DINNER", 18)).toBe(true)
    expect(isMealOpen("DINNER", 21.99)).toBe(true)
    expect(isMealOpen("DINNER", 22)).toBe(false)
  })

  test("uses Bangladesh time, which is 6 hours ahead of UTC", () => {
    // 20:30 UTC on Monday is 02:30 on Tuesday in Dhaka
    expect(dhakaNow(new Date("2026-11-02T20:30:00Z"))).toEqual({ day: "TUESDAY", hour: 2.5 })
    expect(dhakaNow(new Date("2026-11-02T06:00:00Z"))).toEqual({ day: "MONDAY", hour: 12 })
  })

  test("an old client that sends no meal gets the meal for the time of day", () => {
    expect(mealForHour(13)).toBe("LUNCH")
    expect(mealForHour(19)).toBe("DINNER")
  })

  test("describes the hours in plain words", () => {
    expect(windowText("LUNCH")).toBe("12:00 pm to 4:00 pm")
    expect(windowText("DINNER")).toBe("6:00 pm to 10:00 pm")
  })
})
