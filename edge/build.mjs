// Bundles the API into one file that Supabase Edge Functions (Deno) can run.
// Usage: node edge/build.mjs
import { build } from "esbuild"
import { builtinModules } from "node:module"
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

await build({
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
})

console.log("Built supabase/functions/api/app.bundle.js")
