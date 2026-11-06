import {
  pgTable,
  serial,
  text,
  integer,
  boolean,
  timestamp,
  pgEnum,
  uniqueIndex,
  index,
} from "drizzle-orm/pg-core"
import { relations } from "drizzle-orm"

// ==========================================
// 1. Enums
// ==========================================
export const dayOfWeekEnum = pgEnum("day_of_week", [
  "SATURDAY",
  "SUNDAY",
  "MONDAY",
  "TUESDAY",
  "WEDNESDAY",
  "THURSDAY",
  "FRIDAY",
])

export const orderStatusEnum = pgEnum("order_status", [
  "PENDING",
  "CONFIRMED",
  "PREPARING",
  "OUT_FOR_DELIVERY",
  "DELIVERED",
  "CANCELLED",
])

export const paymentMethodEnum = pgEnum("payment_method", ["COD", "BKASH", "NAGAD"])

export const userRoleEnum = pgEnum("user_role", ["CUSTOMER", "STAFF", "ADMIN"])

// ==========================================
// 2. Authentication & RBAC Tables
// ==========================================

// Users Table
export const users = pgTable(
  "users",
  {
    id: serial("id").primaryKey(),
    fullName: text("full_name").notNull(),
    email: text("email").unique(), // optional: customers sign up with name, mobile and password
    phone: text("phone").unique(), // empty for people who signed in with Google (they give it at checkout)
    passwordHash: text("password_hash"), // empty for Google sign-ins: they have no password
    googleSub: text("google_sub"), // Google's permanent id for the person
    // Note: role stays CUSTOMER for Google sign-ins; staff and admins never use Google
    role: userRoleEnum("role").default("CUSTOMER").notNull(),
    defaultAddress: text("default_address"),
    isActive: boolean("is_active").default(true).notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  // email and phone are already indexed by their unique constraints
  (table) => [index("users_role_idx").on(table.role), uniqueIndex("users_google_sub_idx").on(table.googleSub)],
)

// Sessions Table
export const sessions = pgTable(
  "sessions",
  {
    id: text("id").primaryKey(), // Session token / UUID
    userId: integer("user_id")
      .references(() => users.id, { onDelete: "cascade" })
      .notNull(),
    userAgent: text("user_agent"),
    ipAddress: text("ip_address"),
    expiresAt: timestamp("expires_at").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [index("sessions_user_id_idx").on(table.userId)],
)

// Audit Logs Table
export const auditLogs = pgTable(
  "audit_logs",
  {
    id: serial("id").primaryKey(),
    actorId: integer("actor_id").references(() => users.id, {
      onDelete: "set null",
    }),
    action: text("action").notNull(), // e.g., "UPDATE_QUOTA", "CHANGE_ORDER_STATUS", "USER_LOGIN"
    entityType: text("entity_type").notNull(), // e.g., "DAILY_MENU_SCHEDULE", "ORDER", "USER"
    entityId: text("entity_id"),
    metadataJson: text("metadata_json"), // JSON stringified extra details
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    index("audit_logs_actor_id_idx").on(table.actorId),
    index("audit_logs_action_idx").on(table.action),
  ],
)

// ==========================================
// 3. Menu & Categories Tables
// ==========================================

// Categories Table
export const categories = pgTable("categories", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(), // e.g., "Signature Biriyani", "Kebabs & Sides", "Beverages & Desserts"
  slug: text("slug").notNull().unique(),
  sortOrder: integer("sort_order").default(0).notNull(),
})

// Menu Items Table
export const menuItems = pgTable(
  "menu_items",
  {
    id: serial("id").primaryKey(),
    categoryId: integer("category_id")
      .references(() => categories.id, { onDelete: "cascade" })
      .notNull(),
    name: text("name").notNull(),
    description: text("description").notNull(),
    basePriceBdt: integer("base_price_bdt").notNull(), // Stored in whole BDT (e.g., 380)
    imageUrl: text("image_url").notNull(),
    portionSize: text("portion_size").default("1:1 Regular").notNull(),
    spiceLevel: text("spice_level").default("Medium").notNull(),
    rating: text("rating").default("4.9").notNull(),
    isEveryday: boolean("is_everyday").default(false).notNull(), // True for Borhani, Firni, etc.
    isAvailable: boolean("is_available").default(true).notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [index("menu_items_cat_avail_idx").on(table.categoryId, table.isAvailable)],
)

// 7-Day Meal Schedule Mapping Table with Quota & Sold Tracking
export const dailyMenuSchedules = pgTable(
  "daily_menu_schedules",
  {
    id: serial("id").primaryKey(),
    menuItemId: integer("menu_item_id")
      .references(() => menuItems.id, { onDelete: "cascade" })
      .notNull(),
    dayOfWeek: dayOfWeekEnum("day_of_week").notNull(),
    specialPriceBdt: integer("special_price_bdt"), // Optional override price for that day
    dailyQuota: integer("daily_quota").default(100).notNull(),
    soldCount: integer("sold_count").default(0).notNull(),
    isFeatured: boolean("is_featured").default(false).notNull(),
    // BREAKFAST, LUNCH or DINNER: which part of the day this dish is served
    mealTime: text("meal_time").default("LUNCH").notNull(),
  },
  (table) => [
    uniqueIndex("item_day_meal_unique_idx").on(table.menuItemId, table.dayOfWeek, table.mealTime),
    index("schedule_day_idx").on(table.dayOfWeek),
  ],
)

// ==========================================
// 3b. Offers & Delivery Points
// ==========================================

export const discountTypeEnum = pgEnum("discount_type", ["PERCENT", "FLAT"])

// Promo offers managed from the admin panel (e.g. DIU20 = 20% off)
export const offers = pgTable(
  "offers",
  {
    id: serial("id").primaryKey(),
    code: text("code").notNull().unique(), // upper-case promo code customers type at checkout
    title: text("title").notNull(),
    description: text("description").default("").notNull(),
    discountType: discountTypeEnum("discount_type").default("PERCENT").notNull(),
    discountValue: integer("discount_value").notNull(), // percent (1-100) or whole BDT
    maxDiscountBdt: integer("max_discount_bdt"), // cap for percent offers
    minOrderBdt: integer("min_order_bdt").default(0).notNull(),
    startsAt: timestamp("starts_at"),
    endsAt: timestamp("ends_at"),
    isActive: boolean("is_active").default(true).notNull(),
    showOnHomepage: boolean("show_on_homepage").default(true).notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [index("offers_active_idx").on(table.isActive)],
)

// Delivery points / zones with their own fee and estimated time
export const deliveryZones = pgTable(
  "delivery_zones",
  {
    id: serial("id").primaryKey(),
    name: text("name").notNull(), // e.g. "Daffodil Smart City"
    area: text("area").default("").notNull(), // e.g. "Campus & hostels"
    feeBdt: integer("fee_bdt").default(0).notNull(), // delivery is free; column kept for old data
    etaMinutes: text("eta_minutes").default("20-30").notNull(),
    isActive: boolean("is_active").default(true).notNull(),
    sortOrder: integer("sort_order").default(0).notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [index("delivery_zones_active_idx").on(table.isActive, table.sortOrder)],
)

// ==========================================
// 4. Orders & Order Items Tables
// ==========================================

// Orders Table
export const orders = pgTable(
  "orders",
  {
    id: serial("id").primaryKey(),
    orderNumber: text("order_number").notNull().unique(), // e.g., BB-20261028-1042
    userId: integer("user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    customerName: text("customer_name").notNull(),
    customerPhone: text("customer_phone").notNull(),
    customerAddress: text("customer_address").notNull(),
    scheduledDay: dayOfWeekEnum("scheduled_day").notNull(),
    deliverySlot: text("delivery_slot").default("ASAP (45-60 mins)").notNull(),
    paymentMethod: paymentMethodEnum("payment_method").default("COD").notNull(),
    subtotalBdt: integer("subtotal_bdt").notNull(),
    deliveryFeeBdt: integer("delivery_fee_bdt").default(0).notNull(),
    deliveryZoneId: integer("delivery_zone_id").references(() => deliveryZones.id, {
      onDelete: "set null",
    }),
    offerCode: text("offer_code"),
    discountBdt: integer("discount_bdt").default(0).notNull(),
    totalBdt: integer("total_bdt").notNull(),
    status: orderStatusEnum("status").default("PENDING").notNull(),
    paymentTrxId: text("payment_trx_id"),
    isPaymentVerified: boolean("is_payment_verified").default(false).notNull(),
    notes: text("notes"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    index("orders_user_id_idx").on(table.userId),
    index("orders_delivery_zone_idx").on(table.deliveryZoneId),
    index("orders_status_created_idx").on(table.status, table.createdAt.desc()),
  ],
)

// Order Items Table
export const orderItems = pgTable(
  "order_items",
  {
    id: serial("id").primaryKey(),
    orderId: integer("order_id")
      .references(() => orders.id, { onDelete: "cascade" })
      .notNull(),
    menuItemId: integer("menu_item_id")
      .references(() => menuItems.id)
      .notNull(),
    scheduledDay: dayOfWeekEnum("scheduled_day").notNull(),
    itemNameSnapshot: text("item_name_snapshot").notNull(),
    quantity: integer("quantity").notNull(),
    unitPriceBdt: integer("unit_price_bdt").notNull(),
    lineTotalBdt: integer("line_total_bdt").notNull(),
  },
  (table) => [
    index("order_items_order_id_idx").on(table.orderId),
    index("order_items_menu_item_idx").on(table.menuItemId),
  ],
)

// Small settings the owner can change in the admin panel (e.g. lunch and dinner order hours)
export const appSettings = pgTable("app_settings", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
})

// Phones / browsers of the owner and staff that get a push when a new order arrives
export const pushSubscriptions = pgTable(
  "push_subscriptions",
  {
    id: serial("id").primaryKey(),
    userId: integer("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    endpoint: text("endpoint").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("push_subscriptions_endpoint_idx").on(table.endpoint),
    index("push_subscriptions_user_idx").on(table.userId),
  ],
)

// Photos uploaded by the owner (base64, already shrunk by the browser); served at /api/images/:id
export const uploadedImages = pgTable("uploaded_images", {
  id: serial("id").primaryKey(),
  mime: text("mime").notNull(),
  data: text("data").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
})

// Record of the one-time steps in src/db/upgrade.ts that already ran
export const schemaUpgrades = pgTable("schema_upgrades", {
  name: text("name").primaryKey(),
  appliedAt: timestamp("applied_at", { withTimezone: true }).defaultNow().notNull(),
})

// ==========================================
// 5. Relations
// ==========================================

export const usersRelations = relations(users, ({ many }) => ({
  orders: many(orders),
  sessions: many(sessions),
  auditLogs: many(auditLogs),
}))

export const sessionsRelations = relations(sessions, ({ one }) => ({
  user: one(users, {
    fields: [sessions.userId],
    references: [users.id],
  }),
}))

export const auditLogsRelations = relations(auditLogs, ({ one }) => ({
  actor: one(users, {
    fields: [auditLogs.actorId],
    references: [users.id],
  }),
}))

export const categoriesRelations = relations(categories, ({ many }) => ({
  menuItems: many(menuItems),
}))

export const menuItemsRelations = relations(menuItems, ({ one, many }) => ({
  category: one(categories, {
    fields: [menuItems.categoryId],
    references: [categories.id],
  }),
  schedules: many(dailyMenuSchedules),
  orderItems: many(orderItems),
}))

export const dailyMenuSchedulesRelations = relations(dailyMenuSchedules, ({ one }) => ({
  menuItem: one(menuItems, {
    fields: [dailyMenuSchedules.menuItemId],
    references: [menuItems.id],
  }),
}))

export const ordersRelations = relations(orders, ({ one, many }) => ({
  user: one(users, {
    fields: [orders.userId],
    references: [users.id],
  }),
  items: many(orderItems),
}))

export const orderItemsRelations = relations(orderItems, ({ one }) => ({
  order: one(orders, {
    fields: [orderItems.orderId],
    references: [orders.id],
  }),
  menuItem: one(menuItems, {
    fields: [orderItems.menuItemId],
    references: [menuItems.id],
  }),
}))

// ==========================================
// 6. Type Exports
// ==========================================

export type UserRole = (typeof userRoleEnum.enumValues)[number]
export type User = typeof users.$inferSelect
export type NewUser = typeof users.$inferInsert
export type Session = typeof sessions.$inferSelect
export type NewSession = typeof sessions.$inferInsert
export type AuditLog = typeof auditLogs.$inferSelect
export type NewAuditLog = typeof auditLogs.$inferInsert

export type Category = typeof categories.$inferSelect
export type NewCategory = typeof categories.$inferInsert
export type MenuItem = typeof menuItems.$inferSelect
export type NewMenuItem = typeof menuItems.$inferInsert
export type DailyMenuSchedule = typeof dailyMenuSchedules.$inferSelect
export type NewDailyMenuSchedule = typeof dailyMenuSchedules.$inferInsert
export type Order = typeof orders.$inferSelect
export type NewOrder = typeof orders.$inferInsert
export type OrderItem = typeof orderItems.$inferSelect
export type NewOrderItem = typeof orderItems.$inferInsert

export type Offer = typeof offers.$inferSelect
export type DeliveryZone = typeof deliveryZones.$inferSelect
