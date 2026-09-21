export type TranscriptSegment = {
  start: number;
  end: number;
  text: string;
};

export type VideoSummary = {
  headline: string;
  overview: string;
  keyPoints: string[];
  chapters: Array<{ time: number; title: string; summary: string }>;
  quotes: Array<{ time: number; text: string }>;
  keywords: string[];
  disclaimer: string;
  mode: "local" | "gpt";
};

const STOP_WORDS = new Set([
  "这个", "那个", "就是", "然后", "因为", "所以", "但是", "我们", "你们", "他们",
  "一个", "一些", "这种", "这里", "现在", "其实", "可能", "还是", "已经", "没有",
  "什么", "怎么", "可以", "觉得", "比较", "非常", "如果", "的话", "进行", "相关",
  "the", "and", "that", "with", "from", "this", "have", "will", "about",
]);

function clean(text: string) {
  return text.replace(/\s+/g, " ").replace(/([，。！？；：])\1+/g, "$1").trim();
}

function splitSentences(segments: TranscriptSegment[]) {
  const sentences: Array<{ text: string; time: number }> = [];
  for (const segment of segments) {
    const parts = clean(segment.text).split(/(?<=[。！？!?；;])|\n+/).filter(Boolean);
    for (const part of parts) {
      const text = clean(part);
      if (text.length >= 8) sentences.push({ text, time: segment.start });
    }
  }
  return sentences;
}

function tokens(text: string) {
  const chinese = text.match(/[\u4e00-\u9fff]{2,6}/g) ?? [];
  const latin = text.toLowerCase().match(/[a-z][a-z0-9-]{2,}/g) ?? [];
  return [...chinese, ...latin].filter((word) => !STOP_WORDS.has(word));
}

function topKeywords(text: string, limit = 8) {
  const counts = new Map<string, number>();
  for (const token of tokens(text)) counts.set(token, (counts.get(token) ?? 0) + 1);
  return [...counts.entries()]
    .filter(([word]) => word.length < 8)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([word]) => word);
}

function scoreSentence(text: string, frequencies: Map<string, number>) {
  const words = tokens(text);
  if (!words.length) return 0;
  const signal = words.reduce((sum, word) => sum + (frequencies.get(word) ?? 0), 0) / Math.sqrt(words.length);
  const lengthPenalty = text.length > 120 ? 0.78 : text.length < 18 ? 0.7 : 1;
  return signal * lengthPenalty;
}

export function summarizeLocally(
  title: string,
  segments: TranscriptSegment[],
  description = "",
): VideoSummary {
  const sentences = splitSentences(segments);
  const sourceText = `${title}\n${description}\n${sentences.map((item) => item.text).join("\n")}`;
  const frequencies = new Map<string, number>();
  for (const token of tokens(sourceText)) frequencies.set(token, (frequencies.get(token) ?? 0) + 1);

  const ranked = sentences
    .map((sentence) => ({ ...sentence, score: scoreSentence(sentence.text, frequencies) }))
    .sort((a, b) => b.score - a.score);
  const keyPoints: typeof ranked = [];
  for (const candidate of ranked) {
    const duplicate = keyPoints.some((picked) => {
      const a = new Set(tokens(candidate.text));
      const b = new Set(tokens(picked.text));
      const overlap = [...a].filter((token) => b.has(token)).length;
      return overlap / Math.max(1, Math.min(a.size, b.size)) > 0.55;
    });
    if (!duplicate) keyPoints.push(candidate);
    if (keyPoints.length === 6) break;
  }

  const duration = Math.max(...segments.map((item) => item.end), 0);
  const chapterCount = Math.max(1, Math.min(6, Math.ceil(duration / 600)));
  const chapterSize = Math.max(1, duration / chapterCount);
  const chapters = Array.from({ length: chapterCount }, (_, index) => {
    const start = index * chapterSize;
    const inChapter = sentences.filter((sentence) => sentence.time >= start && sentence.time < start + chapterSize);
    const best = inChapter
      .map((sentence) => ({ ...sentence, score: scoreSentence(sentence.text, frequencies) }))
      .sort((a, b) => b.score - a.score)[0];
    const text = best?.text ?? `第 ${index + 1} 部分`;
    return {
      time: Math.round(start),
      title: clean(text).replace(/[。！？!?]$/, "").slice(0, 22),
      summary: text.slice(0, 120),
    };
  });

  const selected = keyPoints.sort((a, b) => a.time - b.time);
  const fallback = clean(description) || clean(title);
  return {
    headline: selected[0]?.text.replace(/[。！？!?]$/, "").slice(0, 42) || title,
    overview: selected.slice(0, 3).map((item) => item.text).join(" ") || fallback,
    keyPoints: selected.map((item) => item.text),
    chapters,
    quotes: ranked.slice(0, 3).sort((a, b) => a.time - b.time).map((item) => ({ time: Math.round(item.time), text: item.text })),
    keywords: topKeywords(sourceText),
    disclaimer: "本摘要由本地规则模型从语音转写中提取，可能遗漏语境或识别错误，请结合原视频核对。",
    mode: "local",
  };
}

export function formatTimestamp(seconds: number) {
  const value = Math.max(0, Math.round(seconds));
  const hours = Math.floor(value / 3600);
  const minutes = Math.floor((value % 3600) / 60);
  const secs = value % 60;
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}`
    : `${minutes}:${String(secs).padStart(2, "0")}`;
}
