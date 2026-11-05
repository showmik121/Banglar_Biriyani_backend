import { describe, expect, test } from "vitest"
import { dhakaNow, isMealOpen, mealForHour, windowText } from "../../server/utils/mealWindows.js"
import { mealWindowsSchema } from "../../server/validators/settingsSchema.js"

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

  test("hours the owner set are used when given", () => {
    const custom = { LUNCH: { startHour: 11, endHour: 15 }, DINNER: { startHour: 19, endHour: 23 } }
    expect(isMealOpen("LUNCH", 11, custom)).toBe(true)
    expect(isMealOpen("LUNCH", 15, custom)).toBe(false)
    expect(isMealOpen("DINNER", 18.5, custom)).toBe(false)
    expect(windowText("DINNER", custom)).toBe("7:00 pm to 11:00 pm")
    // halfway between 3 pm and 7 pm is 5 pm
    expect(mealForHour(16.9, custom)).toBe("LUNCH")
    expect(mealForHour(17, custom)).toBe("DINNER")
  })

  test("the admin cannot save impossible hours", () => {
    const ok = { LUNCH: { startHour: 12, endHour: 16 }, DINNER: { startHour: 18, endHour: 24 } }
    expect(mealWindowsSchema.safeParse(ok).success).toBe(true)
    expect(mealWindowsSchema.safeParse({ ...ok, LUNCH: { startHour: 16, endHour: 12 } }).success).toBe(false)
    expect(mealWindowsSchema.safeParse({ ...ok, LUNCH: { startHour: 12, endHour: 12 } }).success).toBe(false)
    expect(mealWindowsSchema.safeParse({ ...ok, DINNER: { startHour: 18, endHour: 25 } }).success).toBe(false)
    expect(mealWindowsSchema.safeParse({ ...ok, DINNER: { startHour: 18.5, endHour: 22 } }).success).toBe(false)
    expect(mealWindowsSchema.safeParse({ LUNCH: ok.LUNCH }).success).toBe(false)
  })
})
