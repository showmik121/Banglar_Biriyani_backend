import postgres from "postgres"
import { drizzle } from "drizzle-orm/postgres-js"
import "dotenv/config"
import * as schema from "./schema.js"

// A real browser has a document; Deno and Supabase Edge define window but not document.
if (typeof (globalThis as { document?: unknown }).document !== "undefined") {
  throw new Error(
    "Security Violation: the database client cannot be bundled or executed in browser environments.",
  )
}

// Supabase Postgres. DATABASE_URL is the "Transaction pooler" string (port 6543),
// which suits the API and Supabase Edge Functions. drizzle-kit uses
// DATABASE_URL_UNPOOLED (the "Session pooler", port 5432) - see drizzle.config.ts.
const connectionString = process.env.DATABASE_URL || process.env.DATABASE_URL_UNPOOLED

if (!connectionString) {
  throw new Error(
    "DATABASE_URL or DATABASE_URL_UNPOOLED must be provided in the environment (.env).",
  )
}

// prepare: false is required by Supabase's transaction pooler.
// The client connects lazily, on the first query.
export const pool = postgres(connectionString, { prepare: false, max: 5 })
export const db = drizzle(pool, { schema })

export * from "./schema.js"
