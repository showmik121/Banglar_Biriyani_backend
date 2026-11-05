import { Hono } from "hono"
import { eq } from "drizzle-orm"
import { db, auditLogs, uploadedImages } from "../../src/db/index.js"
import { requireAuth, requireRole } from "../middleware/authMiddleware.js"

/** Photos the owner uploads from a phone or computer. Kept small (the browser shrinks them first). */
export const MAX_DATA_URL_CHARS = 245_000 // stays under the 256 KB request limit
const DATA_URL = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/]+={0,2})$/

/** GET /api/images/:id: public, cached for a year (a photo never changes once uploaded) */
export const publicImagesRouter = new Hono()
publicImagesRouter.get("/images/:id", async (c) => {
  const id = Number(c.req.param("id"))
  if (!Number.isInteger(id) || id <= 0) return c.body(null, 404)
  const [row] = await db.select().from(uploadedImages).where(eq(uploadedImages.id, id)).limit(1)
  if (!row) return c.body(null, 404)
  const bytes = Uint8Array.from(atob(row.data), (ch) => ch.charCodeAt(0))
  return c.body(bytes, 200, {
    "Content-Type": row.mime,
    "Cache-Control": "public, max-age=31536000, immutable",
    "X-Content-Type-Options": "nosniff",
  })
})

export const adminImagesRouter = new Hono()
adminImagesRouter.use("*", requireAuth)

/** POST /api/admin/images { dataUrl } -> { data: { url: "/api/images/12" } } */
adminImagesRouter.post("/images", requireRole(["ADMIN"]), async (c) => {
  const body = (await c.req.json().catch(() => null)) as { dataUrl?: unknown } | null
  const text = typeof body?.dataUrl === "string" ? body.dataUrl : ""
  const m = text.length <= MAX_DATA_URL_CHARS ? DATA_URL.exec(text) : null
  if (!m) {
    return c.json(
      { error: { code: "VALIDATION_ERROR", message: "Please choose a JPG, PNG or WebP photo (it is shrunk automatically)", details: null } },
      422,
    )
  }
  const [row] = await db.insert(uploadedImages).values({ mime: m[1], data: m[2] }).returning({ id: uploadedImages.id })
  const user = c.get("user") as { id: number } | undefined
  await db.insert(auditLogs).values({
    actorId: user?.id ?? null,
    action: "UPLOAD_IMAGE",
    entityType: "IMAGE",
    entityId: String(row.id),
    metadataJson: JSON.stringify({ mime: m[1], chars: m[2].length }),
  })
  return c.json({ data: { url: `/api/images/${row.id}` } }, 201)
})
