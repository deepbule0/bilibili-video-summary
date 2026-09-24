import { NextRequest, NextResponse } from "next/server";
import { requestPhoneCode } from "@/lib/phone-verification";
import { apiError, requireApiUser } from "@/lib/request-user";

export async function POST(request: NextRequest) {
  try {
    const user = await requireApiUser();
    const body = await request.json() as { phone?: string };
    const result = await requestPhoneCode(user.userId, String(body.phone || "").trim());
    return NextResponse.json({ ok: true, ...result });
  } catch (error) {
    const failure = apiError(error);
    return NextResponse.json({ ok: false, error: failure.message }, { status: failure.status });
  }
}
