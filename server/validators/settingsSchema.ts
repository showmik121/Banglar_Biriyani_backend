import { z } from "zod"

const hour = (label: string) =>
  z.number({ error: `${label} is required` }).int(`${label} must be a whole hour`)

const windowSchema = z
  .object({
    startHour: hour("Start time").min(0, "Start time must be between 12 am and 11 pm").max(23, "Start time must be between 12 am and 11 pm"),
    endHour: hour("End time").min(1, "End time must be between 1 am and 12 midnight").max(24, "End time must be between 1 am and 12 midnight"),
  })
  .refine((w) => w.endHour > w.startHour, { message: "The end time must be after the start time", path: ["endHour"] })

/** Hours (Bangladesh time) when same-day orders are taken for each meal */
export const mealWindowsSchema = z.object({
  LUNCH: windowSchema,
  DINNER: windowSchema,
})
