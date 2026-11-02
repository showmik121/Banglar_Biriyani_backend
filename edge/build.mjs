// Bundles the API into one file that Supabase Edge Functions (Deno) can run.
// Usage: node edge/build.mjs
import { builtinModules, createRequire } from "node:module"
import { fileURLToPath } from "node:url"
import path from "node:path"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const builtins = new Set(builtinModules)

// Deno needs the "node:" prefix on built-in modules ("crypto" -> "node:crypto").
const nodePrefix = {
  name: "node-prefix",
  setup(b) {
    b.onResolve({ filter: /^(node:)?[a-z_/]+$/ }, (args) => {
      const name = args.path.replace(/^node:/, "")
      if (!builtins.has(name)) return undefined
      return { path: `node:${name}`, external: true }
    })
  },
}

// In GitHub Actions, show build errors as annotations on the run page.
function report(message) {
  const text = String(message).replace(/%/g, "%25").replace(/\r?\n/g, "%0A")
  if (process.env.GITHUB_ACTIONS) console.log(`::error title=Edge build::${text}`)
  console.error(message)
}

// esbuild is already installed as part of tsx / drizzle-kit (no extra package needed).
function loadEsbuild() {
  const errors = []
  for (const host of [null, "tsx", "drizzle-kit"]) {
    const from = host ? path.join(root, "node_modules", host, "package.json") : path.join(root, "package.json")
    try {
      return createRequire(from)("esbuild")
    } catch (err) {
      errors.push(`${host || "project"}: ${err?.message?.split("\n")[0]}`)
    }
  }
  report(`Could not find esbuild. ${errors.join(" | ")}`)
  process.exit(1)
}
const { build } = loadEsbuild()

const result = await build({
  entryPoints: [path.join(root, "edge/entry.ts")],
  outfile: path.join(root, "supabase/functions/api/app.bundle.js"),
  bundle: true,
  format: "esm",
  platform: "node",
  target: "es2022",
  minify: true,
  legalComments: "none",
  alias: {
    ws: path.join(root, "edge/shims/ws.ts"),
    "dotenv/config": path.join(root, "edge/shims/empty.ts"),
  },
  plugins: [nodePrefix],
  // Some packages call require() or read process.env; give them Deno's Node versions.
  banner: {
    js: [
      'import { createRequire as __bbCreateRequire } from "node:module";',
      'import process from "node:process";',
      "const require = __bbCreateRequire(import.meta.url);",
    ].join(""),
  },
  logLevel: "info",
}).catch((err) => {
  const list = err?.errors?.length ? err.errors : [{ text: err?.message || String(err) }]
  for (const e of list.slice(0, 10)) {
    const where = e.location ? ` (${e.location.file}:${e.location.line})` : ""
    report(`${e.text}${where}`)
  }
  process.exit(1)
})
void result

console.log("Built supabase/functions/api/app.bundle.js")
