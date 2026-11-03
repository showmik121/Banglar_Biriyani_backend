// Runs the built Supabase bundle in Deno and checks a few routes that need no database.
// Usage (after `node edge/build.mjs`): deno run -A edge/smoke-test.mjs
const inCI = Deno.env.get("GITHUB_ACTIONS")
const report = (msg) => {
  if (inCI) console.log(`::error title=Edge smoke test::${String(msg).replace(/\r?\n/g, "%0A")}`)
  console.error(msg)
}

// Supabase's runtime has none of Node's globals; remove them so this test
// catches code that relies on them (this is what broke the first deploy).
for (const name of ["Buffer", "global", "process", "setImmediate", "clearImmediate"]) {
  delete globalThis[name]
}
// ...and it does define window, like a browser would.
globalThis.window ??= globalThis

let app
try {
  app = (await import("../supabase/functions/api/app.bundle.js")).default
} catch (err) {
  report(`Bundle failed to load in Deno: ${err?.stack || err}`)
  Deno.exit(1)
}

const checks = [
  ["/api/health", 200],
  ["/api/admin/orders", 401],
  ["/api/admin/offers", 401],
  ["/api/does-not-exist", 404],
]

let failed = 0
for (const [path, expected] of checks) {
  let res
  try {
    res = await app.fetch(new Request(`https://edge.test${path}`))
  } catch (err) {
    report(`${path} threw: ${err?.stack || err}`)
    failed++
    continue
  }
  const ok = res.status === expected
  if (!ok) {
    failed++
    report(`${path} -> ${res.status}, expected ${expected}: ${(await res.text()).slice(0, 300)}`)
  }
  console.log(`${ok ? "PASS" : "FAIL"}  ${path}  -> ${res.status} (expected ${expected})`)
}

if (failed) {
  console.error(`${failed} edge check(s) failed`)
  Deno.exit(1)
}
console.log("Supabase Edge bundle works in Deno.")
