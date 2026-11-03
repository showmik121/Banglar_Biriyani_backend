// Removes the demo order and the extra accounts (demo customer, kitchen staff)
// that an older version of `npm run db:seed` created. The admin account and
// real orders are not touched.
// Usage: npm run db:remove-demo
import { eq, inArray } from "drizzle-orm"
import { db, pool, orders, users } from "./index.js"

const DEMO_ORDER = "BB-20261028-001"
const EXTRA_ACCOUNTS = ["customer@banglarbiriyani.com", "kitchen@banglarbiriyani.com"]

async function main() {
  // Order items are removed with the order (ON DELETE CASCADE)
  const deletedOrders = await db
    .delete(orders)
    .where(eq(orders.orderNumber, DEMO_ORDER))
    .returning({ orderNumber: orders.orderNumber })

  // Sessions go with the user; any other orders keep their details but lose the link
  const deletedUsers = await db
    .delete(users)
    .where(inArray(users.email, EXTRA_ACCOUNTS))
    .returning({ email: users.email })

  console.log(
    deletedOrders.length ? `Removed demo order ${DEMO_ORDER}` : `Demo order ${DEMO_ORDER} was not there`,
  )
  for (const email of EXTRA_ACCOUNTS) {
    const removed = deletedUsers.some((u) => u.email === email)
    console.log(removed ? `Removed account ${email}` : `Account ${email} was not there`)
  }
}

main()
  .catch((err) => {
    console.error("Could not remove the demo data:", err instanceof Error ? err.message : err)
    process.exitCode = 1
  })
  .finally(() => pool.end())
