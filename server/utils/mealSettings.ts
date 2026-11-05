// Order hours for lunch and dinner, kept in the database so the owner can change them
// in the admin panel. Reading never fails: if the setting is missing (or the table is not
// created yet) the starting hours in mealWindows.ts are used.
import { eq } from "drizzle-orm"
import { appSettings, db } from "../../src/db/index.js"
import { mealWindowsSchema } from "../validators/settingsSchema.js"
import { MEAL_WINDOWS, type MealWindows } from "./mealWindows.js"

const KEY = "meal_windows"
const CACHE_MS = 15_000
let cache: { at: number; value: MealWindows } | null = null

export async function getMealWindows(): Promise<MealWindows> {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.value
  let value: MealWindows = MEAL_WINDOWS
  try {
    const [row] = await db.select().from(appSettings).where(eq(appSettings.key, KEY)).limit(1)
    if (row) {
      const parsed = mealWindowsSchema.safeParse(JSON.parse(row.value))
      if (parsed.success) value = parsed.data
    }
  } catch (err) {
    console.error("[settings] could not read meal hours, using the starting hours:", err)
  }
  cache = { at: Date.now(), value }
  return value
}

export async function saveMealWindows(value: MealWindows): Promise<void> {
  const text = JSON.stringify(value)
  await db
    .insert(appSettings)
    .values({ key: KEY, value: text })
    .onConflictDoUpdate({ target: appSettings.key, set: { value: text, updatedAt: new Date() } })
  cache = { at: Date.now(), value }
}
