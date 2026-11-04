// Hours (Bangladesh time) when each meal can be ordered for the same day.
// Lunch: 12:00 pm to 4:00 pm. Dinner: 6:00 pm to 10:00 pm.
// Orders for another day (pre-orders) are not limited by these hours.
// Change the hours here AND in the website (frontend src/i18n/mealTimes.ts).
export type MealName = "LUNCH" | "DINNER"
export const MEAL_WINDOWS: Record<MealName, { startHour: number; endHour: number }> = {
  LUNCH: { startHour: 12, endHour: 16 },
  DINNER: { startHour: 18, endHour: 22 },
}

const DAYS = ["SUNDAY", "MONDAY", "TUESDAY", "WEDNESDAY", "THURSDAY", "FRIDAY", "SATURDAY"] as const
export type DayName = (typeof DAYS)[number]

/** Bangladesh is UTC+6 all year (no daylight saving) */
export function dhakaNow(now: Date = new Date()): { day: DayName; hour: number } {
  const local = new Date(now.getTime() + 6 * 60 * 60 * 1000)
  return { day: DAYS[local.getUTCDay()], hour: local.getUTCHours() + local.getUTCMinutes() / 60 }
}

export function isMealOpen(meal: MealName, hour: number): boolean {
  const w = MEAL_WINDOWS[meal]
  return hour >= w.startHour && hour < w.endHour
}

/** The meal that fits the time of day, used only when an older client did not say which */
export function mealForHour(hour: number): MealName {
  return hour < 17 ? "LUNCH" : "DINNER"
}

const clock = (h: number) => `${h % 12 === 0 ? 12 : h % 12}:00 ${h < 12 ? "am" : "pm"}`
export const windowText = (meal: MealName) =>
  `${clock(MEAL_WINDOWS[meal].startHour)} to ${clock(MEAL_WINDOWS[meal].endHour)}`

/** Tests and emergencies: MEAL_WINDOWS=off lets orders through at any hour */
export const mealWindowsEnabled = () => process.env.MEAL_WINDOWS !== "off"
