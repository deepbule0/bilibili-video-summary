import { getD1 } from "@/db";
import type { ChatGPTUser } from "@/app/chatgpt-auth";

export type PlanId = "trial" | "basic" | "premium" | "internal";

export type PlanConfig = {
  id: PlanId;
  name: string;
  priceCents: number;
  durationDays: number;
  weeklyLimitSeconds: number | null;
  priority: number;
  unlimited: boolean;
  active: boolean;
};

export type Entitlement = {
  plan: PlanConfig;
  subscriptionId: string | null;
  startsAt: string | null;
  endsAt: string | null;
  windowKey: string;
  limitSeconds: number | null;
  consumedSeconds: number;
  reservedSeconds: number;
  remainingSeconds: number | null;
};

const DEFAULT_PLANS: PlanConfig[] = [
  { id: "trial", name: "免费试用", priceCents: 0, durationDays: 0, weeklyLimitSeconds: 1800, priority: 5, unlimited: false, active: true },
  { id: "basic", name: "标准版", priceCents: 2000, durationDays: 30, weeklyLimitSeconds: 500 * 60, priority: 20, unlimited: false, active: true },
  { id: "premium", name: "高级版", priceCents: 5000, durationDays: 30, weeklyLimitSeconds: null, priority: 80, unlimited: true, active: true },
  { id: "internal", name: "内部账号", priceCents: 0, durationDays: 3650, weeklyLimitSeconds: null, priority: 100, unlimited: true, active: false },
];

function id(prefix: string) {
  return `${prefix}_${crypto.randomUUID().replaceAll("-", "")}`;
}

function iso(value = new Date()) {
  return value.toISOString();
}

export async function ensurePlanCatalog() {
  const db = getD1();
  await db.batch(DEFAULT_PLANS.map((plan) => db.prepare(
    `INSERT OR IGNORE INTO plan_configs
      (id, name, price_cents, duration_days, weekly_limit_seconds, priority, unlimited, active, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`,
  ).bind(plan.id, plan.name, plan.priceCents, plan.durationDays, plan.weeklyLimitSeconds, plan.priority, plan.unlimited ? 1 : 0, plan.active ? 1 : 0)));
}

export async function ensureUser(identity: ChatGPTUser) {
  const db = getD1();
  const ownerId = process.env.OWNER_USER_ID;
  const role = ownerId && identity.userId === ownerId ? "owner" : "user";
  await db.prepare(
    `INSERT INTO users (id, email, full_name, role, updated_at)
     VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
     ON CONFLICT(id) DO UPDATE SET email = excluded.email, full_name = excluded.full_name,
       role = CASE WHEN users.role = 'owner' THEN 'owner' ELSE excluded.role END, updated_at = CURRENT_TIMESTAMP`,
  ).bind(identity.userId, identity.email, identity.fullName, role).run();
  return getUser(identity.userId);
}

export async function getUser(userId: string) {
  return getD1().prepare(
    `SELECT id, email, full_name AS fullName, phone, phone_verified_at AS phoneVerifiedAt,
      role, trial_limit_seconds AS trialLimitSeconds, created_at AS createdAt
     FROM users WHERE id = ?`,
  ).bind(userId).first<Record<string, unknown>>();
}

export async function listPlans(includeInactive = false): Promise<PlanConfig[]> {
  await ensurePlanCatalog();
  const where = includeInactive ? "" : "WHERE active = 1 AND id IN ('basic', 'premium')";
  const result = await getD1().prepare(
    `SELECT id, name, price_cents AS priceCents, duration_days AS durationDays,
      weekly_limit_seconds AS weeklyLimitSeconds, priority, unlimited, active
     FROM plan_configs ${where} ORDER BY price_cents ASC`,
  ).all<Record<string, unknown>>();
  return result.results.map((row) => ({
    id: String(row.id) as PlanId,
    name: String(row.name),
    priceCents: Number(row.priceCents),
    durationDays: Number(row.durationDays),
    weeklyLimitSeconds: row.weeklyLimitSeconds === null ? null : Number(row.weeklyLimitSeconds),
    priority: Number(row.priority),
    unlimited: Boolean(row.unlimited),
    active: Boolean(row.active),
  }));
}

async function getPlan(planId: PlanId) {
  const plans = await listPlans(true);
  const plan = plans.find((item) => item.id === planId);
  if (!plan) throw new Error("套餐配置不存在");
  return plan;
}

export async function getEntitlement(userId: string): Promise<Entitlement> {
  await ensurePlanCatalog();
  const db = getD1();
  const user = await db.prepare("SELECT role, trial_limit_seconds AS trialLimitSeconds FROM users WHERE id = ?")
    .bind(userId).first<{ role: string; trialLimitSeconds: number }>();
  if (!user) throw new Error("账号不存在");

  let plan: PlanConfig;
  let subscriptionId: string | null = null;
  let startsAt: string | null = null;
  let endsAt: string | null = null;
  if (user.role === "owner") {
    plan = await getPlan("internal");
  } else {
    const subscription = await db.prepare(
      `SELECT s.id, s.plan_id AS planId, s.starts_at AS startsAt, s.ends_at AS endsAt
       FROM subscriptions s
       WHERE s.user_id = ? AND s.status = 'active' AND s.starts_at <= ? AND s.ends_at > ?
       ORDER BY s.ends_at DESC LIMIT 1`,
    ).bind(userId, iso(), iso()).first<{ id: string; planId: PlanId; startsAt: string; endsAt: string }>();
    if (subscription) {
      plan = await getPlan(subscription.planId);
      subscriptionId = subscription.id;
      startsAt = subscription.startsAt;
      endsAt = subscription.endsAt;
    } else {
      plan = await getPlan("trial");
      plan.weeklyLimitSeconds = Number(user.trialLimitSeconds || 1800);
    }
  }

  let windowKey = `${plan.id}:lifetime`;
  if (plan.id === "basic" && startsAt && subscriptionId) {
    const week = Math.max(0, Math.floor((Date.now() - new Date(startsAt).getTime()) / (7 * 86400_000)));
    windowKey = `${subscriptionId}:week:${week}`;
  } else if (subscriptionId) {
    windowKey = `${subscriptionId}:term`;
  } else if (plan.id === "internal") {
    windowKey = "internal:lifetime";
  }

  const limitSeconds = plan.unlimited ? null : plan.weeklyLimitSeconds;
  await db.prepare(
    `INSERT OR IGNORE INTO quota_windows
      (user_id, window_key, plan_id, limit_seconds, consumed_seconds, reserved_seconds, updated_at)
     VALUES (?, ?, ?, ?, 0, 0, CURRENT_TIMESTAMP)`,
  ).bind(userId, windowKey, plan.id, limitSeconds).run();
  await db.prepare(
    `UPDATE quota_windows SET limit_seconds = ?, plan_id = ?, updated_at = CURRENT_TIMESTAMP
     WHERE user_id = ? AND window_key = ?`,
  ).bind(limitSeconds, plan.id, userId, windowKey).run();
  const quota = await db.prepare(
    `SELECT consumed_seconds AS consumedSeconds, reserved_seconds AS reservedSeconds
     FROM quota_windows WHERE user_id = ? AND window_key = ?`,
  ).bind(userId, windowKey).first<{ consumedSeconds: number; reservedSeconds: number }>();
  const consumedSeconds = Number(quota?.consumedSeconds || 0);
  const reservedSeconds = Number(quota?.reservedSeconds || 0);
  return {
    plan, subscriptionId, startsAt, endsAt, windowKey, limitSeconds,
    consumedSeconds, reservedSeconds,
    remainingSeconds: limitSeconds === null ? null : Math.max(0, limitSeconds - consumedSeconds - reservedSeconds),
  };
}

export async function reserveSummaryJob(input: {
  userId: string; videoUrl: string; bvid?: string; title?: string; durationSeconds: number;
}) {
  const db = getD1();
  const entitlement = await getEntitlement(input.userId);
  const durationSeconds = Math.max(60, Math.ceil(input.durationSeconds));
  const update = await db.prepare(
    `UPDATE quota_windows SET reserved_seconds = reserved_seconds + ?, updated_at = CURRENT_TIMESTAMP
     WHERE user_id = ? AND window_key = ?
       AND (limit_seconds IS NULL OR consumed_seconds + reserved_seconds + ? <= limit_seconds)`,
  ).bind(durationSeconds, input.userId, entitlement.windowKey, durationSeconds).run();
  if (!update.meta.changes) throw new Error("本周期可用视频时长不足，请升级套餐或等待下一周期");

  const jobId = id("job");
  try {
    await db.prepare(
      `INSERT INTO summary_jobs
        (id, user_id, video_url, bvid, title, duration_seconds, reserved_seconds, window_key, plan_id, status, priority)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?)`,
    ).bind(jobId, input.userId, input.videoUrl, input.bvid || null, input.title || null, durationSeconds, durationSeconds,
      entitlement.windowKey, entitlement.plan.id, entitlement.plan.priority).run();
    await addJobEvent(jobId, "queued", `已预留 ${Math.ceil(durationSeconds / 60)} 分钟`);
    return { jobId, entitlement, durationSeconds, priority: entitlement.plan.priority };
  } catch (error) {
    await db.prepare(
      `UPDATE quota_windows SET reserved_seconds = MAX(0, reserved_seconds - ?), updated_at = CURRENT_TIMESTAMP
       WHERE user_id = ? AND window_key = ?`,
    ).bind(durationSeconds, input.userId, entitlement.windowKey).run();
    throw error;
  }
}

export async function attachEngineJob(jobId: string, engineJobId: string) {
  await getD1().prepare(
    `UPDATE summary_jobs SET engine_job_id = ?, status = 'processing', started_at = CURRENT_TIMESTAMP WHERE id = ?`,
  ).bind(engineJobId, jobId).run();
  await addJobEvent(jobId, "processing", "GPU 工作节点已接收任务");
}

export async function settleSummaryJob(jobId: string, status: "complete" | "failed", actualSeconds?: number, error?: string) {
  const db = getD1();
  const job = await db.prepare(
    `SELECT user_id AS userId, window_key AS windowKey, reserved_seconds AS reservedSeconds,
      duration_seconds AS durationSeconds, status FROM summary_jobs WHERE id = ?`,
  ).bind(jobId).first<{ userId: string; windowKey: string; reservedSeconds: number; durationSeconds: number; status: string }>();
  if (!job) throw new Error("任务不存在");
  if (["complete", "failed"].includes(job.status)) return;
  const charged = status === "complete" ? Math.max(60, Math.ceil(actualSeconds || job.durationSeconds)) : 0;
  await db.batch([
    db.prepare(
      `UPDATE quota_windows SET reserved_seconds = MAX(0, reserved_seconds - ?),
        consumed_seconds = consumed_seconds + ?, updated_at = CURRENT_TIMESTAMP
       WHERE user_id = ? AND window_key = ?`,
    ).bind(job.reservedSeconds, charged, job.userId, job.windowKey),
    db.prepare(
      `UPDATE summary_jobs SET status = ?, charged_seconds = ?, error = ?, completed_at = CURRENT_TIMESTAMP WHERE id = ?`,
    ).bind(status, charged, error || null, jobId),
    db.prepare(
      `INSERT INTO job_events (id, job_id, status, detail) VALUES (?, ?, ?, ?)`,
    ).bind(id("evt"), jobId, status, status === "complete" ? `实际计费 ${Math.ceil(charged / 60)} 分钟` : `额度已退回：${error || "任务失败"}`),
  ]);
}

export async function addJobEvent(jobId: string, status: string, detail: string) {
  await getD1().prepare("INSERT INTO job_events (id, job_id, status, detail) VALUES (?, ?, ?, ?)")
    .bind(id("evt"), jobId, status, detail).run();
}

export async function getUserJob(userId: string, jobId: string) {
  return getD1().prepare(
    `SELECT id, video_url AS videoUrl, bvid, title, duration_seconds AS durationSeconds,
      charged_seconds AS chargedSeconds, status, priority, engine_job_id AS engineJobId,
      summary_model AS summaryModel, error, created_at AS createdAt, completed_at AS completedAt
     FROM summary_jobs WHERE id = ? AND user_id = ?`,
  ).bind(jobId, userId).first<Record<string, unknown>>();
}

export async function createOrder(userId: string, planId: "basic" | "premium") {
  const plan = await getPlan(planId);
  if (!plan.active || plan.priceCents <= 0) throw new Error("该套餐暂不可购买");
  const orderId = `VS${Date.now()}${Math.floor(Math.random() * 9000 + 1000)}`;
  const expiresAt = iso(new Date(Date.now() + 30 * 60_000));
  await getD1().prepare(
    `INSERT INTO orders (id, user_id, plan_id, amount_cents, status, payment_provider, expires_at)
     VALUES (?, ?, ?, ?, 'pending', 'alipay', ?)`,
  ).bind(orderId, userId, planId, plan.priceCents, expiresAt).run();
  return { orderId, plan, expiresAt };
}

export async function markOrderPaid(orderId: string, providerTradeNo: string, rawPayload: string) {
  const db = getD1();
  const order = await db.prepare(
    `SELECT id, user_id AS userId, plan_id AS planId, amount_cents AS amountCents, status
     FROM orders WHERE id = ?`,
  ).bind(orderId).first<{ id: string; userId: string; planId: "basic" | "premium"; amountCents: number; status: string }>();
  if (!order) throw new Error("订单不存在");
  if (order.status === "paid") return { alreadyPaid: true };
  const plan = await getPlan(order.planId);
  const now = new Date();
  const active = await db.prepare(
    `SELECT id, plan_id AS planId, ends_at AS endsAt FROM subscriptions
     WHERE user_id = ? AND status = 'active' AND ends_at > ? ORDER BY ends_at DESC LIMIT 1`,
  ).bind(order.userId, iso(now)).first<{ id: string; planId: string; endsAt: string }>();
  const samePlan = active?.planId === order.planId;
  const startsAt = samePlan ? new Date(active.endsAt) : now;
  const endsAt = new Date(startsAt.getTime() + plan.durationDays * 86400_000);
  const subscriptionId = `sub_${orderId}`;
  const statements = [
    db.prepare("UPDATE orders SET status = 'paid', provider_trade_no = ?, paid_at = CURRENT_TIMESTAMP WHERE id = ? AND status = 'pending'")
      .bind(providerTradeNo, orderId),
    db.prepare("INSERT OR IGNORE INTO payment_events (id, order_id, provider_event_id, event_type, payload) VALUES (?, ?, ?, 'paid', ?)")
      .bind(id("payevt"), orderId, providerTradeNo, rawPayload),
  ];
  if (active && !samePlan) statements.push(db.prepare("UPDATE subscriptions SET status = 'replaced' WHERE id = ?").bind(active.id));
  statements.push(db.prepare(
    `INSERT OR IGNORE INTO subscriptions (id, user_id, plan_id, status, starts_at, ends_at, order_id)
     VALUES (?, ?, ?, 'active', ?, ?, ?)`,
  ).bind(subscriptionId, order.userId, order.planId, iso(startsAt), iso(endsAt), orderId));
  statements.push(db.prepare(
    "INSERT INTO audit_logs (id, actor_user_id, action, target_type, target_id, detail) VALUES (?, ?, 'order.paid', 'order', ?, ?)"
  ).bind(id("audit"), order.userId, orderId, JSON.stringify({ planId: order.planId, amountCents: order.amountCents })));
  await db.batch(statements);
  return { alreadyPaid: false, subscriptionId, startsAt: iso(startsAt), endsAt: iso(endsAt) };
}

export async function getAccountSnapshot(userId: string) {
  const db = getD1();
  const entitlement = await getEntitlement(userId);
  const user = await getUser(userId);
  const ordersResult = await db.prepare(
    `SELECT id, plan_id AS planId, amount_cents AS amountCents, status, created_at AS createdAt, paid_at AS paidAt
     FROM orders WHERE user_id = ? ORDER BY created_at DESC LIMIT 20`,
  ).bind(userId).all<Record<string, unknown>>();
  const jobsResult = await db.prepare(
    `SELECT id, title, bvid, duration_seconds AS durationSeconds, charged_seconds AS chargedSeconds,
      status, priority, created_at AS createdAt, error
     FROM summary_jobs WHERE user_id = ? ORDER BY created_at DESC LIMIT 30`,
  ).bind(userId).all<Record<string, unknown>>();
  return { user, entitlement, orders: ordersResult.results, jobs: jobsResult.results };
}

export async function isOwner(userId: string) {
  const row = await getD1().prepare("SELECT role FROM users WHERE id = ?").bind(userId).first<{ role: string }>();
  return row?.role === "owner";
}

export async function getAdminOverview() {
  const db = getD1();
  const [users, paying, revenue, jobs, failures, minutes, recentOrders, recentJobs] = await Promise.all([
    db.prepare("SELECT COUNT(*) AS value FROM users").first<{ value: number }>(),
    db.prepare("SELECT COUNT(DISTINCT user_id) AS value FROM subscriptions WHERE status = 'active' AND ends_at > CURRENT_TIMESTAMP").first<{ value: number }>(),
    db.prepare("SELECT COALESCE(SUM(amount_cents), 0) AS value FROM orders WHERE status = 'paid'").first<{ value: number }>(),
    db.prepare("SELECT COUNT(*) AS value FROM summary_jobs").first<{ value: number }>(),
    db.prepare("SELECT COUNT(*) AS value FROM summary_jobs WHERE status = 'failed'").first<{ value: number }>(),
    db.prepare("SELECT COALESCE(SUM(charged_seconds), 0) AS value FROM summary_jobs WHERE status = 'complete'").first<{ value: number }>(),
    db.prepare(`SELECT o.id, o.plan_id AS planId, o.amount_cents AS amountCents, o.status, o.created_at AS createdAt,
      u.email FROM orders o JOIN users u ON u.id = o.user_id ORDER BY o.created_at DESC LIMIT 20`).all<Record<string, unknown>>(),
    db.prepare(`SELECT j.id, j.title, j.status, j.duration_seconds AS durationSeconds, j.priority, j.created_at AS createdAt,
      u.email FROM summary_jobs j JOIN users u ON u.id = j.user_id ORDER BY j.created_at DESC LIMIT 30`).all<Record<string, unknown>>(),
  ]);
  return {
    metrics: { users: Number(users?.value || 0), payingUsers: Number(paying?.value || 0), revenueCents: Number(revenue?.value || 0),
      jobs: Number(jobs?.value || 0), failedJobs: Number(failures?.value || 0), processedMinutes: Math.ceil(Number(minutes?.value || 0) / 60) },
    recentOrders: recentOrders.results, recentJobs: recentJobs.results, plans: await listPlans(true),
  };
}

export async function updatePlan(actorUserId: string, planId: "basic" | "premium", input: { priceCents: number; weeklyLimitSeconds: number | null; priority: number }) {
  const db = getD1();
  await db.batch([
    db.prepare(`UPDATE plan_configs SET price_cents = ?, weekly_limit_seconds = ?, priority = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
      .bind(input.priceCents, input.weeklyLimitSeconds, input.priority, planId),
    db.prepare("INSERT INTO audit_logs (id, actor_user_id, action, target_type, target_id, detail) VALUES (?, ?, 'plan.updated', 'plan', ?, ?)")
      .bind(id("audit"), actorUserId, planId, JSON.stringify(input)),
  ]);
  return getPlan(planId);
}
