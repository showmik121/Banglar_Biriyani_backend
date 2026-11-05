// Small, safe changes to the live database that keep existing data.
// Every statement can run more than once. Usage: npm run db:upgrade
import { sql } from "drizzle-orm"
import { db, pool } from "./index.js"

// once: true = changes or deletes data, so it runs a single time and is then recorded in
// the schema_upgrades table. The other steps are safe to repeat.
const steps: { name: string; once?: boolean; run: () => Promise<unknown> }[] = [
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
    once: true,
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
  {
    // Supabase also serves every table in the public schema over its own REST address, which
    // anyone holding the (public) anon key can call. Row level security with no policies shuts
    // that door. The API connects as the database owner, which is not affected by it.
    name: "Lock tables against direct public access (row level security)",
    run: async () => {
      const tables = [
        "users", "sessions", "audit_logs", "categories", "menu_items", "daily_menu_schedules",
        "offers", "delivery_zones", "orders", "order_items", "schema_upgrades",
      ]
      for (const t of tables) {
        await db.execute(sql.raw(`ALTER TABLE ${t} ENABLE ROW LEVEL SECURITY`))
      }
      // Supabase roles only exist on Supabase; skip quietly on a plain Postgres
      await db.execute(sql`
        DO $$
        BEGIN
          IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
            REVOKE ALL ON ALL TABLES IN SCHEMA public FROM anon;
            REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM anon;
          END IF;
          IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
            REVOKE ALL ON ALL TABLES IN SCHEMA public FROM authenticated;
            REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM authenticated;
          END IF;
        END $$
      `)
    },
  },
  {
    // Indexes on foreign keys that deleting a dish or a delivery point has to check,
    // and removal of copies of indexes the unique constraints already provide
    name: "Indexes on foreign keys, drop duplicate indexes",
    run: async () => {
      await db.execute(sql`CREATE INDEX IF NOT EXISTS order_items_menu_item_idx ON order_items (menu_item_id)`)
      await db.execute(sql`CREATE INDEX IF NOT EXISTS orders_delivery_zone_idx ON orders (delivery_zone_id)`)
      await db.execute(sql`DROP INDEX IF EXISTS users_email_idx`)
      await db.execute(sql`DROP INDEX IF EXISTS users_phone_idx`)
      await db.execute(sql`DROP INDEX IF EXISTS orders_num_created_idx`)
    },
  },
  {
    // Rejects impossible values (negative prices, zero quantity). NOT VALID checks new and
    // changed rows only, so old data can never make this step fail.
    name: "Sanity checks on quantities and prices",
    run: async () => {
      const checks: [string, string, string][] = [
        ["order_items", "order_items_quantity_positive", "quantity > 0"],
        ["order_items", "order_items_prices_nonnegative", "unit_price_bdt >= 0 AND line_total_bdt >= 0"],
        ["orders", "orders_amounts_nonnegative", "subtotal_bdt >= 0 AND total_bdt >= 0 AND discount_bdt >= 0 AND delivery_fee_bdt >= 0"],
        ["menu_items", "menu_items_price_nonnegative", "base_price_bdt >= 0"],
        ["daily_menu_schedules", "schedule_quota_nonnegative", "daily_quota >= 0 AND sold_count >= 0"],
      ]
      for (const [table, name, rule] of checks) {
        await db.execute(sql.raw(`ALTER TABLE ${table} DROP CONSTRAINT IF EXISTS ${name}`))
        await db.execute(sql.raw(`ALTER TABLE ${table} ADD CONSTRAINT ${name} CHECK (${rule}) NOT VALID`))
      }
    },
  },
  {
    // Owner-editable settings (lunch and dinner order hours). Locked like every other table.
    name: "Settings table for order hours",
    run: async () => {
      await db.execute(sql`
        CREATE TABLE IF NOT EXISTS app_settings (
          key text PRIMARY KEY,
          value text NOT NULL,
          updated_at timestamptz NOT NULL DEFAULT now()
        )
      `)
      await db.execute(sql`ALTER TABLE app_settings ENABLE ROW LEVEL SECURITY`)
      await db.execute(sql`
        DO $$
        BEGIN
          IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
            REVOKE ALL ON TABLE app_settings FROM anon;
          END IF;
          IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
            REVOKE ALL ON TABLE app_settings FROM authenticated;
          END IF;
        END $$
      `)
    },
  },
  {
    name: "Table for photos uploaded by the owner",
    run: async () => {
      await db.execute(sql`
        CREATE TABLE IF NOT EXISTS uploaded_images (
          id serial PRIMARY KEY,
          mime text NOT NULL,
          data text NOT NULL,
          created_at timestamptz NOT NULL DEFAULT now()
        )
      `)
      await db.execute(sql`ALTER TABLE uploaded_images ENABLE ROW LEVEL SECURITY`)
      await db.execute(sql`
        DO $$
        BEGIN
          IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
            REVOKE ALL ON TABLE uploaded_images FROM anon;
          END IF;
          IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
            REVOKE ALL ON TABLE uploaded_images FROM authenticated;
          END IF;
        END $$
      `)
    },
  },
]

async function main() {
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS schema_upgrades (
      name text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `)
  for (const step of steps) {
    if (step.once) {
      const done = await db.execute(sql`SELECT 1 FROM schema_upgrades WHERE name = ${step.name}`)
      if (done.length > 0) {
        console.log(`Skipped (already done): ${step.name}`)
        continue
      }
    }
    await step.run()
    if (step.once) await db.execute(sql`INSERT INTO schema_upgrades (name) VALUES (${step.name}) ON CONFLICT DO NOTHING`)
    console.log(`Done: ${step.name}`)
  }
}

main()
  .catch((err) => {
    console.error("Database update failed:", err instanceof Error ? err.message : err)
    process.exitCode = 1
  })
  .finally(() => pool.end())
