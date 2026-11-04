// Changes the admin sign-in details on the live database. Keeps all other data.
// Put the new details in your .env first (never in chat or in git):
//   NEW_ADMIN_PASSWORD=...        (at least 10 characters)  required
//   ADMIN_EMAIL=...               the admin's current email (default admin@banglarbiriyani.com)
//   NEW_ADMIN_EMAIL=...           optional: change the admin's email
//   NEW_ADMIN_PHONE=01XXXXXXXXX   optional: change the admin's mobile number
// Then run: npm run db:set-admin   (or double-click change-admin.bat)
import { eq } from "drizzle-orm"
import { db, pool, users, sessions } from "./index.js"
import { hashPassword, normalizeBdPhone, BD_PHONE_REGEX } from "../../server/utils/auth.js"

async function main() {
  const password = process.env.NEW_ADMIN_PASSWORD || ""
  if (password.length < 10) {
    throw new Error("Set NEW_ADMIN_PASSWORD in .env first (at least 10 characters).")
  }
  const currentEmail = (process.env.ADMIN_EMAIL || "admin@banglarbiriyani.com").trim().toLowerCase()

  const [admin] = await db.select().from(users).where(eq(users.email, currentEmail))
  if (!admin || admin.role !== "ADMIN") {
    throw new Error(`No admin account found with the email ${currentEmail}. Check ADMIN_EMAIL in .env.`)
  }

  const changes: Partial<typeof users.$inferInsert> = {
    passwordHash: await hashPassword(password),
    updatedAt: new Date(),
  }
  const newEmail = (process.env.NEW_ADMIN_EMAIL || "").trim().toLowerCase()
  if (newEmail) changes.email = newEmail
  const newPhone = (process.env.NEW_ADMIN_PHONE || "").trim()
  if (newPhone) {
    if (!BD_PHONE_REGEX.test(newPhone)) throw new Error("NEW_ADMIN_PHONE is not a valid Bangladesh mobile number.")
    changes.phone = normalizeBdPhone(newPhone)
  }

  await db.update(users).set(changes).where(eq(users.id, admin.id))
  // Sign the admin out everywhere so only the new password works
  await db.delete(sessions).where(eq(sessions.userId, admin.id))
  console.log("Done: the admin password was changed" + (newEmail ? ", email updated" : "") + (newPhone ? ", phone updated" : "") + ".")
  console.log("Now remove NEW_ADMIN_PASSWORD from .env.")
}

main()
  .catch((err) => {
    console.error("Could not change the admin:", err instanceof Error ? err.message : err)
    process.exitCode = 1
  })
  .finally(() => pool.end())
