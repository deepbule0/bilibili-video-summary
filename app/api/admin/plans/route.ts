import { NextRequest, NextResponse } from "next/server";
import { updatePlan } from "@/lib/commerce";
import { apiError, requireOwner } from "@/lib/request-user";

export async function PATCH(request: NextRequest) {
  try {
    const user = await requireOwner();
    const body = await request.json() as { planId?: string; priceYuan?: number; weeklyMinutes?: number | null; priority?: number };
    if (!['basic', 'premium'].includes(String(body.planId))) throw new Error("只能修改标准版或高级版");
    const priceCents = Math.round(Number(body.priceYuan) * 100);
    const priority = Math.round(Number(body.priority));
    const weeklyLimitSeconds = body.weeklyMinutes === null ? null : Math.round(Number(body.weeklyMinutes) * 60);
    if (!Number.isFinite(priceCents) || priceCents < 100 || priceCents > 100000) throw new Error("套餐价格不正确");
    if (!Number.isFinite(priority) || priority < 0 || priority > 100) throw new Error("优先级应在0到100之间");
    if (weeklyLimitSeconds !== null && (!Number.isFinite(weeklyLimitSeconds) || weeklyLimitSeconds < 60)) throw new Error("每周分钟数不正确");
    const plan = await updatePlan(user.userId, body.planId as "basic" | "premium", { priceCents, weeklyLimitSeconds, priority });
    return NextResponse.json({ ok: true, plan });
  } catch (error) {
    const failure = apiError(error);
    return NextResponse.json({ ok: false, error: failure.message }, { status: failure.status });
  }
}
