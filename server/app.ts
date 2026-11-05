import { Hono } from "hono"
import { bodyLimit } from "hono/body-limit"
import { cors } from "hono/cors"
import { logger } from "hono/logger"
import { secureHeaders } from "hono/secure-headers"
import { menuRouter } from "./routes/menu.js"
import { ordersRouter } from "./routes/orders.js"
import { authRouter } from "./routes/auth.js"
import { adminRouter } from "./routes/admin.js"
import { adminPromotionsRouter, publicPromotionsRouter } from "./routes/promotions.js"
import { adminSettingsRouter, publicSettingsRouter } from "./routes/settings.js"
import { isAllowedOrigin } from "./utils/cors.js"

// The API itself. Runs the same on Node (server/index.ts) and on Supabase
// Edge Functions (edge/entry.ts).
export const app = new Hono()

// Global Middlewares
app.use("*", logger())
app.use("*", secureHeaders())

// Which websites may call the API from a browser. The live site reaches the API through
// its own address (Netlify forwards /api), so it needs nothing here. The shop's SITE_URL is
// always allowed; add other sites to the ALLOWED_ORIGINS secret, separated by commas
// (for example https://www.client-domain.com). See server/utils/cors.ts.
app.use(
  "*",
  cors({
    origin: (origin) => (isAllowedOrigin(origin) ? origin : ""),
    allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowHeaders: ["Content-Type", "Authorization"],
    credentials: true,
  }),
)

// Every request body here is a small JSON document. Refuse anything bigger before it is
// read into memory, so a huge upload cannot slow the API down.
const MAX_REQUEST_BODY_BYTES = 256 * 1024
app.use(
  "/api/*",
  bodyLimit({
    maxSize: MAX_REQUEST_BODY_BYTES,
    onError: (c) =>
      c.json(
        {
          error: {
            code: "PAYLOAD_TOO_LARGE",
            message: "The request is too large",
            details: null,
          },
        },
        413,
      ),
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
app.route("/api/admin", adminPromotionsRouter)
app.route("/api/admin", adminSettingsRouter)
app.route("/api", publicPromotionsRouter)
app.route("/api", publicSettingsRouter)

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

export default app
