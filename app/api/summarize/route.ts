import { NextRequest, NextResponse } from "next/server";

import { summarizeLocally, type TranscriptSegment, type VideoSummary } from "@/lib/video-summary";

const schema = {
  type: "object",
  additionalProperties: false,
  required: ["headline", "overview", "keyPoints", "chapters", "quotes", "keywords", "disclaimer"],
  properties: {
    headline: { type: "string" },
    overview: { type: "string" },
    keyPoints: {
      type: "array",
      minItems: 4,
      maxItems: 8,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["title", "detail", "time"],
        properties: {
          title: { type: "string", minLength: 4 },
          detail: { type: "string", minLength: 80 },
          time: { type: "number" },
        },
      },
    },
    chapters: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["time", "title", "summary"],
        properties: {
          time: { type: "number" },
          title: { type: "string" },
          summary: { type: "string", minLength: 100 },
        },
      },
      minItems: 3,
      maxItems: 10,
    },
    quotes: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["time", "text"],
        properties: { time: { type: "number" }, text: { type: "string" } },
      },
    },
    keywords: { type: "array", items: { type: "string" }, minItems: 3, maxItems: 10 },
    disclaimer: { type: "string" },
  },
};

function getOutputText(data: any) {
  if (typeof data?.output_text === "string") return data.output_text;
  for (const item of data?.output ?? []) {
    for (const content of item?.content ?? []) {
      if (content?.type === "output_text" && typeof content.text === "string") return content.text;
    }
  }
  return "";
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json() as {
      title?: string;
      description?: string;
      transcript?: TranscriptSegment[];
      mode?: "local" | "gpt";
    };
    const title = String(body.title ?? "未命名视频").slice(0, 300);
    const description = String(body.description ?? "").slice(0, 4000);
    const transcript = Array.isArray(body.transcript) ? body.transcript.slice(0, 12000) : [];
    if (!transcript.length) throw new Error("没有可用于总结的转写文本");

    if (body.mode !== "gpt") {
      return NextResponse.json({ ok: true, summary: summarizeLocally(title, transcript, description) });
    }

    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      return NextResponse.json({
        ok: false,
        error: "当前站点尚未配置 OpenAI API Key，请使用零费用模式或在部署环境中添加 OPENAI_API_KEY。",
        code: "OPENAI_NOT_CONFIGURED",
      });
    }
    const model = process.env.OPENAI_SUMMARY_MODEL || "gpt-5-mini";
    const transcriptText = transcript
      .map((item) => `[${Math.round(item.start)}s] ${item.text}`)
      .join("\n")
      .slice(0, 140000);
    const response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        store: false,
        instructions: "你是一名严谨的中文内容编辑。只根据给定转写总结，不补充外部事实；保留不确定性，并用时间秒数关联原视频。overview 要写成 2 至 4 个连贯段落。每个 keyPoint 必须包含简明标题，以及 2 至 4 句具体说明，优先保留人物、数字、判断依据和例子。chapters 要覆盖完整视频，每段写成不少于 100 字的内容段落，不能只列标题。",
        input: `视频标题：${title}\n视频简介：${description}\n\n转写：\n${transcriptText}`,
        text: { format: { type: "json_schema", name: "video_summary", strict: true, schema } },
      }),
    });
    if (!response.ok) {
      const detail = await response.text();
      throw new Error(`GPT 总结失败（${response.status}）：${detail.slice(0, 180)}`);
    }
    const data = await response.json();
    const text = getOutputText(data);
    if (!text) throw new Error("GPT 未返回可解析的总结");
    const summary = JSON.parse(text) as Omit<VideoSummary, "mode">;
    return NextResponse.json({ ok: true, summary: { ...summary, mode: "gpt" } });
  } catch (error) {
    const message = error instanceof Error ? error.message : "总结生成失败";
    console.warn("[summarize]", message);
    return NextResponse.json({ ok: false, error: message });
  }
}
