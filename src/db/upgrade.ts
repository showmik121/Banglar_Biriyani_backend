// Small, safe changes to the live database that keep existing data.
// Every statement can run more than once. Usage: npm run db:upgrade
import { sql } from "drizzle-orm"
import { db, pool } from "./index.js"

const steps: { name: string; run: () => Promise<unknown> }[] = [
  {
    // Customers now sign up with name, mobile number and password; email is optional
    name: "Email is optional for accounts",
    run: () => db.execute(sql`ALTER TABLE users ALTER COLUMN email DROP NOT NULL`),
  },
  {
    // Daily meals are split into breakfast, lunch and dinner.
    // The first time only: rice-and-curry meals become dinner, everything else stays lunch.
    name: "Breakfast, lunch and dinner for daily meals",
    run: async () => {
      const found = await db.execute(sql`
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'daily_menu_schedules' AND column_name = 'meal_time'
      `)
      if (found.length === 0) {
        await db.execute(sql`ALTER TABLE daily_menu_schedules ADD COLUMN meal_time text NOT NULL DEFAULT 'LUNCH'`)
        await db.execute(sql`
          UPDATE daily_menu_schedules s SET meal_time = 'DINNER'
          FROM menu_items m JOIN categories c ON c.id = m.category_id
          WHERE m.id = s.menu_item_id AND c.slug = 'home-style-meals' AND s.is_featured = false
        `)
      }
      await db.execute(sql`DROP INDEX IF EXISTS item_day_unique_idx`)
      await db.execute(sql`
        CREATE UNIQUE INDEX IF NOT EXISTS item_day_meal_unique_idx
        ON daily_menu_schedules (menu_item_id, day_of_week, meal_time)
      `)
    },
  },
  {
    // At most 12 dishes per meal (e.g. Monday lunch). Specials are kept first; dishes are not deleted.
    name: "At most 12 dishes per meal",
    run: () =>
      db.execute(sql`
        DELETE FROM daily_menu_schedules
        WHERE id IN (
          SELECT id FROM (
            SELECT id, ROW_NUMBER() OVER (
              PARTITION BY day_of_week, meal_time ORDER BY is_featured DESC, id ASC
            ) AS position
            FROM daily_menu_schedules
          ) ranked
          WHERE ranked.position > 12
        )
      `),
  },
  {
    // The admin order list filters by status and shows the newest first
    name: "Faster order list for the admin",
    run: () => db.execute(sql`CREATE INDEX IF NOT EXISTS orders_status_created_idx ON orders (status, created_at DESC)`),
  },
  {
    // Signed-out sessions that have already expired are not needed any more
    name: "Remove expired sign-in sessions",
    run: () => db.execute(sql`DELETE FROM sessions WHERE expires_at < NOW()`),
  },
]

async function main() {
  for (const step of steps) {
    await step.run()
    console.log(`Done: ${step.name}`)
  }
}

main()
  .catch((err) => {
    console.error("Database update failed:", err instanceof Error ? err.message : err)
    process.exitCode = 1
  })
  .finally(() => pool.end())
