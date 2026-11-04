import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    globals: true,
    testTimeout: 35000,
    hookTimeout: 35000,
    fileParallelism: false,
    // Tests place orders at any hour; the meal-hours rule has its own test
    env: { MEAL_WINDOWS: "off" },
  },
})

