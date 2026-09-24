type CheckoutOrder = { orderId: string; amountCents: number; subject: string };

const encoder = new TextEncoder();

function stripPem(value: string) {
  return value.replace(/-----BEGIN [^-]+-----|-----END [^-]+-----|\s/g, "");
}

function base64ToBytes(value: string) {
  const binary = atob(stripPem(value));
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

function bytesToBase64(value: ArrayBuffer) {
  const bytes = new Uint8Array(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function canonical(params: URLSearchParams, excludeSign = true) {
  return [...params.entries()]
    .filter(([key, value]) => value && (!excludeSign || !["sign", "sign_type"].includes(key)))
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${value}`)
    .join("&");
}

async function sign(content: string, privateKey: string) {
  const key = await crypto.subtle.importKey(
    "pkcs8", base64ToBytes(privateKey), { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"],
  );
  return bytesToBase64(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, encoder.encode(content)));
}

export function alipayConfigured() {
  return Boolean(process.env.ALIPAY_APP_ID && process.env.ALIPAY_PRIVATE_KEY && process.env.ALIPAY_PUBLIC_KEY && process.env.PUBLIC_APP_URL);
}

export async function createAlipayCheckout(order: CheckoutOrder) {
  const appId = process.env.ALIPAY_APP_ID;
  const privateKey = process.env.ALIPAY_PRIVATE_KEY;
  const publicUrl = process.env.PUBLIC_APP_URL?.replace(/\/$/, "");
  if (!appId || !privateKey || !publicUrl) throw new Error("支付宝商户参数尚未配置");
  const params = new URLSearchParams({
    app_id: appId,
    method: "alipay.trade.page.pay",
    format: "JSON",
    charset: "utf-8",
    sign_type: "RSA2",
    timestamp: new Date().toLocaleString("sv-SE", { timeZone: "Asia/Shanghai" }),
    version: "1.0",
    notify_url: `${publicUrl}/api/billing/alipay/notify`,
    return_url: `${publicUrl}/payment/return?order=${encodeURIComponent(order.orderId)}`,
    biz_content: JSON.stringify({
      out_trade_no: order.orderId,
      product_code: "FAST_INSTANT_TRADE_PAY",
      total_amount: (order.amountCents / 100).toFixed(2),
      subject: order.subject,
      timeout_express: "30m",
    }),
  });
  params.set("sign", await sign(canonical(params), privateKey));
  return `${process.env.ALIPAY_GATEWAY || "https://openapi.alipay.com/gateway.do"}?${params.toString()}`;
}

export async function verifyAlipayNotification(params: URLSearchParams) {
  const publicKey = process.env.ALIPAY_PUBLIC_KEY;
  const signature = params.get("sign");
  if (!publicKey || !signature) return false;
  const key = await crypto.subtle.importKey(
    "spki", base64ToBytes(publicKey), { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"],
  );
  return crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, base64ToBytes(signature), encoder.encode(canonical(params)));
}
