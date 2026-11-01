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
    email: text("email").notNull().unique(),
    phone: text("phone").notNull().unique(),
    passwordHash: text("password_hash").notNull(),
    role: userRoleEnum("role").default("CUSTOMER").notNull(),
    defaultAddress: text("default_address"),
    isActive: boolean("is_active").default(true).notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => [
    index("users_email_idx").on(table.email),
    index("users_phone_idx").on(table.phone),
    index("users_role_idx").on(table.role),
  ],
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
  },
  (table) => [
    uniqueIndex("item_day_unique_idx").on(table.menuItemId, table.dayOfWeek),
    index("schedule_day_idx").on(table.dayOfWeek),
  ],
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
    deliveryFeeBdt: integer("delivery_fee_bdt").default(60).notNull(),
    totalBdt: integer("total_bdt").notNull(),
    status: orderStatusEnum("status").default("PENDING").notNull(),
    paymentTrxId: text("payment_trx_id"),
    isPaymentVerified: boolean("is_payment_verified").default(false).notNull(),
    notes: text("notes"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    index("orders_num_created_idx").on(table.orderNumber, table.createdAt),
    index("orders_user_id_idx").on(table.userId),
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
  (table) => [index("order_items_order_id_idx").on(table.orderId)],
)

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
