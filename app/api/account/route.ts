import { NextResponse } from "next/server";
import { getAccountSnapshot } from "@/lib/commerce";
import { apiError, requireApiUser } from "@/lib/request-user";

export async function GET() {
  try {
    const user = await requireApiUser();
    return NextResponse.json({ ok: true, account: await getAccountSnapshot(user.userId) });
  } catch (error) {
    const failure = apiError(error);
    return NextResponse.json({ ok: false, error: failure.message }, { status: failure.status });
  }
}
