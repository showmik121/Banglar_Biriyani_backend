// Removes the demo customer account and the demo order that an older version of
// `npm run db:seed` created. Real orders and accounts are not touched.
// Usage: npm run db:remove-demo
import { eq } from "drizzle-orm"
import { db, pool, orders, users } from "./index.js"

const DEMO_ORDER = "BB-20261028-001"
const DEMO_CUSTOMER = "customer@banglarbiriyani.com"

async function main() {
  // Order items are removed with the order (ON DELETE CASCADE)
  const deletedOrders = await db
    .delete(orders)
    .where(eq(orders.orderNumber, DEMO_ORDER))
    .returning({ orderNumber: orders.orderNumber })

  // Sessions go with the user; any other orders keep their details but lose the link
  const deletedUsers = await db
    .delete(users)
    .where(eq(users.email, DEMO_CUSTOMER))
    .returning({ email: users.email })

  console.log(
    deletedOrders.length ? `Removed demo order ${DEMO_ORDER}` : `Demo order ${DEMO_ORDER} was not there`,
  )
  console.log(
    deletedUsers.length ? `Removed demo account ${DEMO_CUSTOMER}` : `Demo account ${DEMO_CUSTOMER} was not there`,
  )
}

main()
  .catch((err) => {
    console.error("Could not remove the demo data:", err instanceof Error ? err.message : err)
    process.exitCode = 1
  })
  .finally(() => pool.end())
