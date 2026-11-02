// Runs the built Supabase bundle in Deno and checks a few routes that need no database.
// Usage (after `node edge/build.mjs`): deno run -A edge/smoke-test.mjs
const { default: app } = await import("../supabase/functions/api/app.bundle.js")

const checks = [
  ["/api/health", 200],
  ["/api/admin/orders", 401],
  ["/api/admin/offers", 401],
  ["/api/does-not-exist", 404],
]

let failed = 0
for (const [path, expected] of checks) {
  const res = await app.fetch(new Request(`https://edge.test${path}`))
  const ok = res.status === expected
  if (!ok) failed++
  console.log(`${ok ? "PASS" : "FAIL"}  ${path}  -> ${res.status} (expected ${expected})`)
}

if (failed) {
  console.error(`${failed} edge check(s) failed`)
  Deno.exit(1)
}
console.log("Supabase Edge bundle works in Deno.")
