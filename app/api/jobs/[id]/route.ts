import { env } from "cloudflare:workers";
import { NextRequest, NextResponse } from "next/server";
import { getUserJob, settleSummaryJob } from "@/lib/commerce";
import { apiError, requireApiUser } from "@/lib/request-user";

async function readEngineJob(engineJobId: string) {
  const headers = new Headers();
  if (process.env.GPU_ENGINE_TOKEN) headers.set("X-Engine-Token", process.env.GPU_ENGINE_TOKEN);
  const tunnel = (env as Cloudflare.Env & { CUSTOMER_HTTP_GPU?: Fetcher }).CUSTOMER_HTTP_GPU;
  if (tunnel) return tunnel.fetch(new Request(`http://gpu-engine/api/jobs/${engineJobId}`, { headers }));
  const base = process.env.GPU_ENGINE_URL?.replace(/\/$/, "");
  if (!base) throw new Error("GPU 工作节点尚未连接");
  return fetch(`${base}/api/jobs/${engineJobId}`, { headers });
}

export async function GET(_request: NextRequest, context: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireApiUser();
    const { id } = await context.params;
    const job = await getUserJob(user.userId, id);
    if (!job) return NextResponse.json({ ok: false, error: "任务不存在" }, { status: 404 });
    if (["complete", "failed"].includes(String(job.status))) return NextResponse.json({ ok: true, ...job });
    const engineJobId = String(job.engineJobId || "");
    if (!engineJobId) return NextResponse.json({ ok: true, ...job, status: "queued", stage: "queued", progress: 2 });
    const response = await readEngineJob(engineJobId);
    if (!response.ok) throw new Error("暂时无法读取 GPU 任务进度");
    const engine = await response.json() as Record<string, unknown>;
    if (engine.status === "complete") {
      const actualSeconds = Number((engine.video as { duration?: number } | undefined)?.duration || job.durationSeconds || 0);
      await settleSummaryJob(id, "complete", actualSeconds);
    } else if (engine.status === "failed") {
      await settleSummaryJob(id, "failed", 0, String(engine.error || "处理失败"));
    }
    return NextResponse.json({ ok: true, id, ...engine });
  } catch (error) {
    const failure = apiError(error);
    return NextResponse.json({ ok: false, error: failure.message }, { status: failure.status });
  }
}
