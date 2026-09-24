import { sql } from "drizzle-orm";
import { index, integer, primaryKey, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

export const users = sqliteTable("users", {
  id: text("id").primaryKey(), email: text("email").notNull(), fullName: text("full_name"),
  phone: text("phone"), phoneVerifiedAt: text("phone_verified_at"),
  role: text("role").notNull().default("user"), trialLimitSeconds: integer("trial_limit_seconds").notNull().default(1800),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`), updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [uniqueIndex("idx_users_phone").on(table.phone), index("idx_users_created_at").on(table.createdAt)]);

export const planConfigs = sqliteTable("plan_configs", {
  id: text("id").primaryKey(), name: text("name").notNull(), priceCents: integer("price_cents").notNull(),
  durationDays: integer("duration_days").notNull().default(30), weeklyLimitSeconds: integer("weekly_limit_seconds"),
  priority: integer("priority").notNull().default(10), unlimited: integer("unlimited", { mode: "boolean" }).notNull().default(false),
  active: integer("active", { mode: "boolean" }).notNull().default(true), updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

export const subscriptions = sqliteTable("subscriptions", {
  id: text("id").primaryKey(), userId: text("user_id").notNull().references(() => users.id),
  planId: text("plan_id").notNull().references(() => planConfigs.id), status: text("status").notNull().default("active"),
  startsAt: text("starts_at").notNull(), endsAt: text("ends_at").notNull(), orderId: text("order_id"),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [index("idx_subscriptions_user_status").on(table.userId, table.status), index("idx_subscriptions_ends_at").on(table.endsAt)]);

export const orders = sqliteTable("orders", {
  id: text("id").primaryKey(), userId: text("user_id").notNull().references(() => users.id),
  planId: text("plan_id").notNull().references(() => planConfigs.id), amountCents: integer("amount_cents").notNull(),
  status: text("status").notNull().default("pending"), paymentProvider: text("payment_provider").notNull().default("alipay"),
  providerTradeNo: text("provider_trade_no"), createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  paidAt: text("paid_at"), expiresAt: text("expires_at").notNull(),
}, (table) => [index("idx_orders_user_created").on(table.userId, table.createdAt), uniqueIndex("idx_orders_provider_trade").on(table.providerTradeNo)]);

export const paymentEvents = sqliteTable("payment_events", {
  id: text("id").primaryKey(), orderId: text("order_id").notNull().references(() => orders.id),
  providerEventId: text("provider_event_id").notNull(), eventType: text("event_type").notNull(), payload: text("payload").notNull(),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [uniqueIndex("idx_payment_events_provider_event").on(table.providerEventId), index("idx_payment_events_order").on(table.orderId)]);

export const quotaWindows = sqliteTable("quota_windows", {
  userId: text("user_id").notNull().references(() => users.id), windowKey: text("window_key").notNull(),
  planId: text("plan_id").notNull(), limitSeconds: integer("limit_seconds"),
  consumedSeconds: integer("consumed_seconds").notNull().default(0), reservedSeconds: integer("reserved_seconds").notNull().default(0),
  updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [primaryKey({ columns: [table.userId, table.windowKey] }), index("idx_quota_windows_updated").on(table.updatedAt)]);

export const summaryJobs = sqliteTable("summary_jobs", {
  id: text("id").primaryKey(), userId: text("user_id").notNull().references(() => users.id), videoUrl: text("video_url").notNull(),
  bvid: text("bvid"), title: text("title"), durationSeconds: integer("duration_seconds").notNull(),
  reservedSeconds: integer("reserved_seconds").notNull().default(0), chargedSeconds: integer("charged_seconds").notNull().default(0),
  windowKey: text("window_key").notNull(), planId: text("plan_id").notNull(), status: text("status").notNull().default("queued"),
  priority: integer("priority").notNull().default(10), engineJobId: text("engine_job_id"), summaryModel: text("summary_model"), error: text("error"),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`), startedAt: text("started_at"), completedAt: text("completed_at"),
}, (table) => [index("idx_summary_jobs_user_created").on(table.userId, table.createdAt), index("idx_summary_jobs_status_priority").on(table.status, table.priority), uniqueIndex("idx_summary_jobs_engine_job").on(table.engineJobId)]);

export const jobEvents = sqliteTable("job_events", {
  id: text("id").primaryKey(), jobId: text("job_id").notNull().references(() => summaryJobs.id),
  status: text("status").notNull(), detail: text("detail").notNull().default(""), createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [index("idx_job_events_job_created").on(table.jobId, table.createdAt)]);

export const phoneVerifications = sqliteTable("phone_verifications", {
  id: text("id").primaryKey(), userId: text("user_id").notNull().references(() => users.id), phone: text("phone").notNull(),
  codeHash: text("code_hash").notNull(), attempts: integer("attempts").notNull().default(0), expiresAt: text("expires_at").notNull(),
  consumedAt: text("consumed_at"), createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [index("idx_phone_verifications_user_created").on(table.userId, table.createdAt), index("idx_phone_verifications_phone_created").on(table.phone, table.createdAt)]);

export const auditLogs = sqliteTable("audit_logs", {
  id: text("id").primaryKey(), actorUserId: text("actor_user_id"), action: text("action").notNull(),
  targetType: text("target_type").notNull(), targetId: text("target_id").notNull(), detail: text("detail").notNull().default(""),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [index("idx_audit_logs_created").on(table.createdAt)]);
