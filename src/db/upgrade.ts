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
