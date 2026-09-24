import { getD1 } from "@/db";

const PHONE_PATTERN = /^1[3-9]\d{9}$/;
const encoder = new TextEncoder();

function newId() {
  return `otp_${crypto.randomUUID().replaceAll("-", "")}`;
}

async function hashCode(phone: string, code: string) {
  const secret = process.env.PHONE_CODE_SECRET;
  if (!secret) throw new Error("验证码安全密钥尚未配置");
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const digest = new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(`${phone}:${code}`)));
  return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function requestPhoneCode(userId: string, phone: string) {
  if (!PHONE_PATTERN.test(phone)) throw new Error("请输入有效的中国大陆手机号");
  const smsUrl = process.env.SMS_WEBHOOK_URL;
  const testMode = process.env.SMS_TEST_MODE === "true";
  if (!smsUrl && !testMode) throw new Error("短信服务尚未配置，管理员账号仍可继续测试其他功能");
  const db = getD1();
  const recent = await db.prepare(
    `SELECT created_at AS createdAt FROM phone_verifications WHERE user_id = ? ORDER BY created_at DESC LIMIT 1`,
  ).bind(userId).first<{ createdAt: string }>();
  if (recent && Date.now() - new Date(`${recent.createdAt}Z`).getTime() < 60_000) throw new Error("请等待60秒后再重新发送");
  const hourly = await db.prepare(
    `SELECT COUNT(*) AS value FROM phone_verifications WHERE user_id = ? AND created_at > datetime('now', '-1 hour')`,
  ).bind(userId).first<{ value: number }>();
  if (Number(hourly?.value || 0) >= 5) throw new Error("验证码发送过于频繁，请一小时后再试");

  const code = String(Math.floor(100000 + Math.random() * 900000));
  const codeHash = await hashCode(phone, code);
  const expiresAt = new Date(Date.now() + 10 * 60_000).toISOString();
  const verificationId = newId();
  await db.prepare(
    `INSERT INTO phone_verifications (id, user_id, phone, code_hash, expires_at) VALUES (?, ?, ?, ?, ?)`,
  ).bind(verificationId, userId, phone, codeHash, expiresAt).run();

  if (smsUrl) {
    const response = await fetch(smsUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(process.env.SMS_WEBHOOK_TOKEN ? { Authorization: `Bearer ${process.env.SMS_WEBHOOK_TOKEN}` } : {}) },
      body: JSON.stringify({ phone, code, purpose: "bind_phone", expiresMinutes: 10 }),
    });
    if (!response.ok) {
      await db.prepare("DELETE FROM phone_verifications WHERE id = ?").bind(verificationId).run();
      throw new Error("短信服务暂时不可用，请稍后重试");
    }
  }
  return { expiresAt, ...(testMode ? { testCode: code } : {}) };
}

export async function verifyPhoneCode(userId: string, phone: string, code: string) {
  if (!PHONE_PATTERN.test(phone) || !/^\d{6}$/.test(code)) throw new Error("手机号或验证码格式不正确");
  const db = getD1();
  const row = await db.prepare(
    `SELECT id, code_hash AS codeHash, attempts, expires_at AS expiresAt
     FROM phone_verifications WHERE user_id = ? AND phone = ? AND consumed_at IS NULL
     ORDER BY created_at DESC LIMIT 1`,
  ).bind(userId, phone).first<{ id: string; codeHash: string; attempts: number; expiresAt: string }>();
  if (!row || new Date(row.expiresAt).getTime() < Date.now()) throw new Error("验证码已失效，请重新发送");
  if (row.attempts >= 5) throw new Error("验证码错误次数过多，请重新发送");
  const expected = await hashCode(phone, code);
  if (expected !== row.codeHash) {
    await db.prepare("UPDATE phone_verifications SET attempts = attempts + 1 WHERE id = ?").bind(row.id).run();
    throw new Error("验证码不正确");
  }
  try {
    await db.batch([
      db.prepare("UPDATE phone_verifications SET consumed_at = CURRENT_TIMESTAMP WHERE id = ?").bind(row.id),
      db.prepare("UPDATE users SET phone = ?, phone_verified_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ?").bind(phone, userId),
    ]);
  } catch {
    throw new Error("该手机号已绑定其他账号");
  }
  return { phone };
}
