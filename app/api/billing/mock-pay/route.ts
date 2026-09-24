import { NextRequest, NextResponse } from "next/server";
import { markOrderPaid } from "@/lib/commerce";
import { apiError, requireOwner } from "@/lib/request-user";

export async function POST(request: NextRequest) {
  try {
    await requireOwner();
    if (process.env.PAYMENT_TEST_MODE !== "true") throw new Error("支付测试模式未开启");
    const body = await request.json() as { orderId?: string };
    if (!body.orderId) throw new Error("缺少订单号");
    const result = await markOrderPaid(body.orderId, `MOCK_${Date.now()}`, JSON.stringify({ test: true }));
    return NextResponse.json({ ok: true, result });
  } catch (error) {
    const failure = apiError(error);
    return NextResponse.json({ ok: false, error: failure.message }, { status: failure.status });
  }
}
