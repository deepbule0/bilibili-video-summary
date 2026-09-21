import { NextRequest, NextResponse } from "next/server";

const BVID_PATTERN = /BV[1-9A-HJ-NP-Za-km-z]{10}/;

function bilibiliHeaders() {
  return {
    "User-Agent": "Mozilla/5.0 (compatible; BiliSummary/1.0)",
    Referer: "https://www.bilibili.com/",
  };
}

async function fetchVideoData(bvid: string) {
  const apiResponse = await fetch(`https://api.bilibili.com/x/web-interface/view?bvid=${bvid}`, {
    headers: { ...bilibiliHeaders(), Accept: "application/json,text/plain,*/*" },
  });
  const apiText = await apiResponse.text();
  try {
    const apiJson = JSON.parse(apiText) as { code: number; message: string; data: any };
    if (apiJson.code === 0 && apiJson.data) return apiJson.data;
  } catch {
    // The Bilibili API sometimes serves a browser challenge to cloud IPs.
  }

  const pageResponse = await fetch(`https://www.bilibili.com/video/${bvid}/`, {
    headers: {
      ...bilibiliHeaders(),
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.7",
    },
  });
  const pageHtml = await pageResponse.text();
  const initialState = pageHtml.match(/__INITIAL_STATE__=(\{.*?\});\(function\(\)/s)?.[1];
  if (!initialState) {
    throw new Error(`B站暂时拒绝了云端读取（API ${apiResponse.status}，页面 ${pageResponse.status}）`);
  }
  const pageData = JSON.parse(initialState) as { videoData?: any; error?: { trueCode?: number } };
  if (!pageData.videoData) throw new Error("B站页面中没有可用的视频信息");
  return pageData.videoData;
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
  let resolvedBvid = "";
  try {
    const raw = request.nextUrl.searchParams.get("url")?.trim() ?? "";
    const bvid = await resolveBvid(raw);
    resolvedBvid = bvid;
    const videoData = await fetchVideoData(bvid);

    const pageParam = Number(request.nextUrl.searchParams.get("p") ?? "1");
    const pages = Array.isArray(videoData.pages) ? videoData.pages : [];
    const page = pages[Math.min(Math.max(pageParam - 1, 0), Math.max(0, pages.length - 1))] ?? {
      cid: videoData.cid,
      duration: videoData.duration,
      part: videoData.title,
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
      ok: true,
      video: {
        bvid,
        title: videoData.title,
        description: videoData.desc ?? "",
        cover: String(videoData.pic ?? "").replace(/^http:/, "https:"),
        owner: videoData.owner?.name ?? "",
        duration: Number(page.duration || videoData.duration || 0),
        part: page.part ?? videoData.title,
        partNumber: Number(page.page ?? 1),
        parts: pages.length || 1,
        url: `https://www.bilibili.com/video/${bvid}/?p=${page.page ?? 1}`,
      },
      transcript,
      transcriptSource: transcript.length ? subtitleLanguage : "local-required",
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "视频读取失败，请稍后重试";
    console.warn("[video-info]", message);
    // Sites may replace non-2xx API bodies with an HTML error page. Keep the
    // application-level failure in JSON so the client can fall back to the
    // local engine instead of attempting to parse platform HTML.
    return NextResponse.json({ ok: false, error: message, bvid: resolvedBvid });
  }
}
