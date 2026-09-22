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
      minItems: 1,
      maxItems: 12,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["title", "detail", "time"],
        properties: {
          title: { type: "string", minLength: 4 },
          detail: { type: "string", minLength: 20 },
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
          summary: { type: "string", minLength: 40 },
        },
      },
      minItems: 1,
      maxItems: 12,
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

function getOutputText(data: unknown) {
  const response = data as {
    output_text?: unknown;
    output?: Array<{ content?: Array<{ type?: unknown; text?: unknown }> }>;
  };
  if (typeof response?.output_text === "string") return response.output_text;
  for (const item of response?.output ?? []) {
    for (const content of item.content ?? []) {
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
        instructions: "你是一名严谨的中文内容编辑。先判断视频的真实主题、内容类型和信息密度，不预设领域。只依据给定转写，不补充外部事实。过滤依据是信息价值，不是视频形式：只有明确不推进主题的直播点名、欢迎观众、感谢礼物、设备和声音调试、读弹幕、寒暄、广告套话、重复口头禅和无关闲聊才删除。口语化表达、铺垫、举例、重复解释或情绪表达只要承载分析依据、推理、案例、事实或结论，就必须保留其有效信息。对于持续输出信息的课程、访谈、演讲和长视频，要覆盖开头、中段、结尾的全部主要论点，不能只抽少数亮点。数字或专有名词不清楚时写明‘转写不清，需回看原片’，不要猜测。不得使用常识补写原文没有的例子、术语、字段、做法或结论；检查所有数量、分类、比例、因果链是否自洽。开场预告中只被列出而正文没有展开的主题，不能写成视频已经分析过；主播昵称和陌生专名不得联想成国家、机构或外部人物；语法破碎、孤立数字或疑似同音错字不得自行补全。overview 按内容自然写成一段或数段完整总结，讲清主题、重要信息、逻辑关系、结论和限制，不写时间轴流水账。keyPoints 和 chapters 的数量随内容密度调整；每项必须有具体说明，不能只有标题或时间。chapters 按主题、论证步骤或内容结构组织，不按固定时长机械切片。所有 time 必须取自最相关原文的时间标记，不能无理由统一填 0。quotes 必须是转写中的连续原话，不得改写、拼接或使用省略号。输出前核对正文中的主要论点、关键依据和最终结论是否都已覆盖。",
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
