import { env } from "cloudflare:workers";
import { NextRequest, NextResponse } from "next/server";
import { attachEngineJob, reserveSummaryJob, settleSummaryJob } from "@/lib/commerce";
import { apiError, requireApiUser } from "@/lib/request-user";

const BVID_PATTERN = /BV[1-9A-HJ-NP-Za-km-z]{10}/;

async function engineFetch(path: string, init?: RequestInit) {
  const token = process.env.GPU_ENGINE_TOKEN;
  const headers = new Headers(init?.headers);
  if (token) headers.set("X-Engine-Token", token);
  headers.set("Content-Type", "application/json");
  const tunnel = (env as Cloudflare.Env & { CUSTOMER_HTTP_GPU?: Fetcher }).CUSTOMER_HTTP_GPU;
  if (tunnel) return tunnel.fetch(new Request(`http://gpu-engine${path}`, { ...init, headers }));
  const base = process.env.GPU_ENGINE_URL?.replace(/\/$/, "");
  if (!base) throw new Error("GPU_ENGINE_NOT_CONFIGURED");
  return fetch(`${base}${path}`, { ...init, headers });
}

async function readVideo(url: string) {
  let bvid = url.match(BVID_PATTERN)?.[0];
  if (!bvid && /b23\.tv/i.test(url)) {
    const response = await fetch(url, { redirect: "follow" });
    bvid = response.url.match(BVID_PATTERN)?.[0];
  }
  if (!bvid) throw new Error("无法从链接中识别 BV 号");
  const response = await fetch(`https://api.bilibili.com/x/web-interface/view?bvid=${bvid}`, {
    headers: { "User-Agent": "Mozilla/5.0 (compatible; BiliSummary/2.0)", Referer: "https://www.bilibili.com/" },
  });
  const data = await response.json() as { code?: number; data?: { title?: string; duration?: number } };
  if (data.code !== 0 || !data.data?.duration) throw new Error("暂时无法读取视频时长，请稍后重试");
  return { bvid, title: String(data.data.title || bvid), durationSeconds: Number(data.data.duration) };
}

export async function POST(request: NextRequest) {
  let jobId = "";
  try {
    const user = await requireApiUser();
    const body = await request.json() as { url?: string; mode?: "local" | "gpt" };
    const url = String(body.url || "").trim();
    if (!url || url.length > 1200) throw new Error("请输入有效的 B 站视频链接");
    try {
      const health = await engineFetch("/api/health", { method: "GET" });
      if (!health.ok) throw new Error("GPU_SERVICE_UNAVAILABLE");
    } catch (error) {
      if (error instanceof Error && error.message === "GPU_ENGINE_NOT_CONFIGURED") {
        return NextResponse.json({ ok: false, code: "GPU_ENGINE_NOT_CONFIGURED", error: "公网 GPU 工作节点尚未连接；管理员仍可使用本机引擎" }, { status: 503 });
      }
      throw new Error("GPU 服务暂时离线，请稍后重试");
    }
    const video = await readVideo(url);
    const reservation = await reserveSummaryJob({ userId: user.userId, videoUrl: url, ...video });
    jobId = reservation.jobId;
    const engineResponse = await engineFetch("/api/jobs", {
      method: "POST",
      body: JSON.stringify({ url, summary_mode: body.mode === "gpt" ? "gpt" : "local", priority: reservation.priority, external_job_id: jobId }),
    });
    if (!engineResponse.ok) throw new Error(`GPU 工作节点拒绝了任务（${engineResponse.status}）`);
    const engineJob = await engineResponse.json() as { id?: string };
    if (!engineJob.id) throw new Error("GPU 工作节点未返回任务编号");
    await attachEngineJob(jobId, engineJob.id);
    return NextResponse.json({ ok: true, id: jobId, status: "queued", plan: reservation.entitlement.plan.id, priority: reservation.priority }, { status: 202 });
  } catch (error) {
    if (jobId) await settleSummaryJob(jobId, "failed", 0, error instanceof Error ? error.message : "派发失败").catch(() => undefined);
    const failure = apiError(error);
    const status = failure.message.includes("可用视频时长不足") ? 402 : failure.status;
    return NextResponse.json({ ok: false, error: failure.message }, { status });
  }
}
