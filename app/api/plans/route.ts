import { NextResponse } from "next/server";
import { listPlans } from "@/lib/commerce";

export async function GET() {
  try {
    return NextResponse.json({ ok: true, plans: await listPlans(false) });
  } catch (error) {
    return NextResponse.json({ ok: false, error: error instanceof Error ? error.message : "套餐读取失败" }, { status: 503 });
  }
}
