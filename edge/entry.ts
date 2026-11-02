// Entry point for the Supabase Edge Function build.
// edge/build.mjs bundles this file (and the whole API) into
// supabase/functions/api/app.bundle.js, which Supabase runs on Deno.
import { app } from "../server/app.js"

export default app
