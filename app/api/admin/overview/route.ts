import { NextResponse } from "next/server";
import { getAdminOverview } from "@/lib/commerce";
import { apiError, requireOwner } from "@/lib/request-user";

export async function GET() {
  try {
    await requireOwner();
    return NextResponse.json({ ok: true, dashboard: await getAdminOverview() });
  } catch (error) {
    const failure = apiError(error);
    return NextResponse.json({ ok: false, error: failure.message }, { status: failure.status });
  }
}
