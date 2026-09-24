import { NextRequest, NextResponse } from "next/server";
import { alipayConfigured, createAlipayCheckout } from "@/lib/alipay";
import { createOrder } from "@/lib/commerce";
import { apiError, requireApiUser } from "@/lib/request-user";

export async function POST(request: NextRequest) {
  try {
    const user = await requireApiUser();
    const body = await request.json() as { planId?: string };
    if (!['basic', 'premium'].includes(String(body.planId))) throw new Error("请选择有效套餐");
    const order = await createOrder(user.userId, body.planId as "basic" | "premium");
    if (!alipayConfigured()) {
      return NextResponse.json({ ok: false, orderId: order.orderId, code: "ALIPAY_NOT_CONFIGURED", error: "支付宝商户参数尚未配置，订单已保留但不能付款" }, { status: 503 });
    }
    const paymentUrl = await createAlipayCheckout({ orderId: order.orderId, amountCents: order.plan.priceCents, subject: `听见·总结 ${order.plan.name} 30天` });
    return NextResponse.json({ ok: true, orderId: order.orderId, paymentUrl, expiresAt: order.expiresAt });
  } catch (error) {
    const failure = apiError(error);
    return NextResponse.json({ ok: false, error: failure.message }, { status: failure.status });
  }
}
