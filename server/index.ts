import { Hono } from "hono"
import { serve } from "@hono/node-server"
import { cors } from "hono/cors"
import { logger } from "hono/logger"
import { menuRouter } from "./routes/menu.js"
import { ordersRouter } from "./routes/orders.js"
import { authRouter } from "./routes/auth.js"
import { adminRouter } from "./routes/admin.js"

export const app = new Hono()

// Global Middlewares
app.use("*", logger())
app.use(
  "*",
  cors({
    origin: (origin) => origin || "*",
    allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowHeaders: ["Content-Type", "Authorization"],
    credentials: true,
  }),
)

// Standardized Health Check
app.get("/api/health", (c) => {
  return c.json({
    data: {
      status: "ok",
      service: "Banglar Biriyani API",
      timestamp: new Date().toISOString(),
    },
  })
})

// Mount modular sub-routers
app.route("/api/auth", authRouter)
app.route("/api/menu", menuRouter)
app.route("/api/orders", ordersRouter)
app.route("/api/admin", adminRouter)

// Standardized 404 Handler following api-design standards
app.notFound((c) => {
  return c.json(
    {
      error: {
        code: "NOT_FOUND",
        message: `Endpoint ${c.req.method} ${c.req.path} not found`,
        details: null,
      },
    },
    404,
  )
})

// Standardized Global Error Handler following api-design standards
app.onError((err, c) => {
  console.error("[API Server Error]:", err)
  return c.json(
    {
      error: {
        code: "INTERNAL_SERVER_ERROR",
        message: "An unexpected internal server error occurred",
        details: process.env.NODE_ENV === "development" ? err.message : null,
      },
    },
    500,
  )
})

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
