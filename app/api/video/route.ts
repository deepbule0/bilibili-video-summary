import { NextRequest, NextResponse } from "next/server";

const BVID_PATTERN = /BV[1-9A-HJ-NP-Za-km-z]{10}/;

function bilibiliHeaders() {
  return {
    "User-Agent": "Mozilla/5.0 (compatible; BiliSummary/1.0)",
    Referer: "https://www.bilibili.com/",
  };
}

async function resolveBvid(raw: string) {
  const direct = raw.match(BVID_PATTERN)?.[0];
  if (direct) return direct;
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error("请输入有效的 B 站视频链接或 BV 号");
  }
  if (!["b23.tv", "www.b23.tv"].includes(parsed.hostname)) {
    throw new Error("目前仅支持 bilibili.com 与 b23.tv 链接");
  }
  const response = await fetch(parsed.toString(), { redirect: "follow", headers: bilibiliHeaders() });
  const bvid = response.url.match(BVID_PATTERN)?.[0];
  if (!bvid) throw new Error("无法从短链接中识别 BV 号");
  return bvid;
}

export async function GET(request: NextRequest) {
  try {
    const raw = request.nextUrl.searchParams.get("url")?.trim() ?? "";
    const bvid = await resolveBvid(raw);
    const infoResponse = await fetch(`https://api.bilibili.com/x/web-interface/view?bvid=${bvid}`, {
      headers: bilibiliHeaders(),
    });
    const infoJson = await infoResponse.json() as { code: number; message: string; data: any };
    if (infoJson.code !== 0 || !infoJson.data) throw new Error(infoJson.message || "视频信息读取失败");

    const pageParam = Number(request.nextUrl.searchParams.get("p") ?? "1");
    const pages = Array.isArray(infoJson.data.pages) ? infoJson.data.pages : [];
    const page = pages[Math.min(Math.max(pageParam - 1, 0), Math.max(0, pages.length - 1))] ?? {
      cid: infoJson.data.cid,
      duration: infoJson.data.duration,
      part: infoJson.data.title,
    };

    let transcript: Array<{ start: number; end: number; text: string }> = [];
    let subtitleLanguage = "";
    try {
      const playerResponse = await fetch(
        `https://api.bilibili.com/x/player/v2?bvid=${bvid}&cid=${page.cid}`,
        { headers: bilibiliHeaders() },
      );
      const playerJson = await playerResponse.json() as any;
      const subtitles = playerJson?.data?.subtitle?.subtitles ?? [];
      const preferred = subtitles.find((item: any) => /zh|ai-zh/i.test(item.lan)) ?? subtitles[0];
      if (preferred?.subtitle_url) {
        const subtitleUrl = String(preferred.subtitle_url).replace(/^http:/, "https:").replace(/^\/\//, "https://");
        const subtitleResponse = await fetch(subtitleUrl, { headers: bilibiliHeaders() });
        const subtitleJson = await subtitleResponse.json() as any;
        transcript = (subtitleJson.body ?? []).map((item: any) => ({
          start: Number(item.from) || 0,
          end: Number(item.to) || 0,
          text: String(item.content ?? "").trim(),
        })).filter((item: any) => item.text);
        subtitleLanguage = preferred.lan_doc || preferred.lan || "中文字幕";
      }
    } catch {
      transcript = [];
    }

    return NextResponse.json({
      video: {
        bvid,
        title: infoJson.data.title,
        description: infoJson.data.desc ?? "",
        cover: String(infoJson.data.pic ?? "").replace(/^http:/, "https:"),
        owner: infoJson.data.owner?.name ?? "",
        duration: Number(page.duration || infoJson.data.duration || 0),
        part: page.part ?? infoJson.data.title,
        partNumber: Number(page.page ?? 1),
        parts: pages.length || 1,
        url: `https://www.bilibili.com/video/${bvid}/?p=${page.page ?? 1}`,
      },
      transcript,
      transcriptSource: transcript.length ? subtitleLanguage : "local-required",
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "视频读取失败，请稍后重试";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
