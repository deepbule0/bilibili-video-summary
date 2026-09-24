import { NextRequest, NextResponse } from "next/server";
import { getD1 } from "@/db";
import { verifyAlipayNotification } from "@/lib/alipay";
import { markOrderPaid } from "@/lib/commerce";

function text(value: string, status = 200) {
  return new NextResponse(value, { status, headers: { "Content-Type": "text/plain; charset=utf-8" } });
}

export async function POST(request: NextRequest) {
  try {
    const raw = await request.text();
    const params = new URLSearchParams(raw);
    if (!(await verifyAlipayNotification(params))) return text("failure", 400);
    if (!['TRADE_SUCCESS', 'TRADE_FINISHED'].includes(params.get("trade_status") || "")) return text("success");
    if (params.get("app_id") !== process.env.ALIPAY_APP_ID) return text("failure", 400);
    const orderId = params.get("out_trade_no") || "";
    const tradeNo = params.get("trade_no") || "";
    const order = await getD1().prepare("SELECT amount_cents AS amountCents FROM orders WHERE id = ?")
      .bind(orderId).first<{ amountCents: number }>();
    if (!order || (Number(params.get("total_amount")) * 100) !== Number(order.amountCents)) return text("failure", 400);
    await markOrderPaid(orderId, tradeNo, raw.slice(0, 12000));
    return text("success");
  } catch (error) {
    console.error("[alipay-notify]", error);
    return text("failure", 500);
  }
}
