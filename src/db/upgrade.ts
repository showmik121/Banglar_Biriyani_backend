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
    // Each day now shows 3 special meals. Keep the day's specials first, everyday dishes
    // (borhani, kebab...) last, and remove the rest from that day only. Dishes are not deleted.
    name: "Keep 3 special meals per day",
    run: () =>
      db.execute(sql`
        DELETE FROM daily_menu_schedules
        WHERE id IN (
          SELECT id FROM (
            SELECT s.id,
                   ROW_NUMBER() OVER (
                     PARTITION BY s.day_of_week
                     ORDER BY s.is_featured DESC, m.is_everyday ASC, s.id ASC
                   ) AS position
            FROM daily_menu_schedules s
            JOIN menu_items m ON m.id = s.menu_item_id
          ) ranked
          WHERE ranked.position > 3
        )
      `),
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
