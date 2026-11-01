import { Pool, neonConfig } from "@neondatabase/serverless"
import { drizzle } from "drizzle-orm/neon-serverless"
import ws from "ws"
import "dotenv/config"
import * as schema from "./schema.js"

if (typeof (globalThis as { window?: unknown }).window !== "undefined") {
  throw new Error(
    "Security Violation: Neon database client cannot be bundled or executed in browser environments.",
  )
}

// Configure WebSockets for Node.js runtime environments (scripts, migrations, server)
if (!neonConfig.webSocketConstructor) {
  neonConfig.webSocketConstructor = ws
}

const connectionString = process.env.DATABASE_URL_UNPOOLED || process.env.DATABASE_URL

if (!connectionString) {
  throw new Error(
    "DATABASE_URL or DATABASE_URL_UNPOOLED must be provided in the environment (.env).",
  )
}

export const pool = new Pool({ connectionString })
export const db = drizzle(pool, { schema })

export * from "./schema.js"
