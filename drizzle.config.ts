import { defineConfig } from "drizzle-kit"
import "dotenv/config"

const connectionString =
  process.env.DATABASE_URL_UNPOOLED || process.env.DATABASE_URL

if (!connectionString) {
  throw new Error("DATABASE_URL or DATABASE_URL_UNPOOLED is missing in .env")
}

export default defineConfig({
  schema: "./src/db/schema.ts",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: {
    url: connectionString,
  },
})
