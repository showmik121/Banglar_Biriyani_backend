import { serve } from "@hono/node-server"
import { app } from "./app.js"

export { app }

// Start standalone server on port 3001 only when executed directly
const isDirectExecution =
  process.argv[1] &&
  (process.argv[1].endsWith("server/index.ts") ||
    process.argv[1].endsWith("server\\index.ts") ||
    process.argv[1].endsWith("server/index.js") ||
    process.argv[1].endsWith("server\\index.js"))

if (isDirectExecution && process.env.NODE_ENV !== "test") {
  const PORT = parseInt(process.env.API_PORT || "3001", 10)

  try {
    const server = serve(
      {
        fetch: app.fetch,
        port: PORT,
      },
      (info) => {
        console.log(`🚀 Banglar Biriyani API Server running at http://localhost:${info.port}`)
      },
    )

    server.on("error", (err: any) => {
      if (err.code === "EADDRINUSE") {
        console.warn(`⚠️ [API Server] Port ${PORT} already in use. Reusing active instance.`)
      } else {
        console.error("[API Server] Error:", err)
      }
    })
  } catch (err: any) {
    if (err?.code === "EADDRINUSE") {
      console.warn(`⚠️ [API Server] Port ${PORT} already occupied.`)
    } else {
      console.error("Failed to start API server:", err)
    }
  }
}

export default app
