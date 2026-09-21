export type TranscriptSegment = {
  start: number;
  end: number;
  text: string;
};

export type VideoSummary = {
  headline: string;
  overview: string;
  keyPoints: Array<{ title: string; detail: string; time: number }>;
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
  "今天", "大家", "三哥", "眼镜", "名字", "正常", "肯定", "来了", "看到", "好不好", "对吧",
  "the", "and", "that", "with", "from", "this", "have", "will", "about",
]);

const WORD_SEGMENTER = new Intl.Segmenter("zh-CN", { granularity: "word" });

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
  return [...WORD_SEGMENTER.segment(text.toLowerCase())]
    .filter((item) => item.isWordLike)
    .map((item) => item.segment.trim())
    .filter((word) => (word.length >= 2 || /^\d+(?:\.\d+)?$/.test(word)) && !STOP_WORDS.has(word));
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
  const lengthPenalty = text.length > 900 ? 0.82 : text.length < 18 ? 0.65 : 1;
  const informationBonus = (text.match(/市场|指数|数据|原因|结论|方法|步骤|问题|结果|建议|风险|变化|影响|重点|利率|价格|增长|下降|上涨|下跌/g) ?? []).length * 8;
  return signal * lengthPenalty + informationBonus;
}

function joinSentences(items: Array<{ text: string; time: number }>, limit: number) {
  const result: string[] = [];
  let length = 0;
  for (const item of items) {
    const text = clean(item.text);
    if (!text || result.includes(text)) continue;
    if (result.length && length + text.length > limit) break;
    result.push(text);
    length += text.length;
  }
  return result.join(" ");
}

function buildPassages(segments: TranscriptSegment[], windowSeconds = 45) {
  const passages: Array<{ text: string; time: number }> = [];
  let current: TranscriptSegment[] = [];
  for (const segment of segments) {
    const shouldFlush = current.length > 0 && (
      segment.start - current[0].start >= windowSeconds ||
      current.reduce((sum, item) => sum + item.text.length, 0) >= 420
    );
    if (shouldFlush) {
      passages.push({
        time: current[0].start,
        text: current.map((item) => clean(item.text).replace(/[。！？!?]$/, "")).filter(Boolean).join("。") + "。",
      });
      current = [];
    }
    if (clean(segment.text)) current.push(segment);
  }
  if (current.length) {
    passages.push({
      time: current[0].start,
      text: current.map((item) => clean(item.text).replace(/[。！？!?]$/, "")).filter(Boolean).join("。") + "。",
    });
  }
  return passages;
}

function extractTitle(text: string, frequencies: Map<string, number>, limit = 32) {
  const candidates = text
    .split(/[。！？!?；;]+/)
    .map((item) => clean(item))
    .filter((item) => item.length >= 6)
    .map((item) => ({ text: item, score: scoreSentence(item, frequencies) }))
    .sort((a, b) => b.score - a.score);
  return (candidates[0]?.text || clean(text)).slice(0, limit);
}

export function summarizeLocally(
  title: string,
  segments: TranscriptSegment[],
  description = "",
): VideoSummary {
  const sentences = splitSentences(segments);
  const passages = buildPassages(segments);
  const sourceText = `${title}\n${description}\n${passages.map((item) => item.text).join("\n")}`;
  const frequencies = new Map<string, number>();
  for (const token of tokens(sourceText)) frequencies.set(token, (frequencies.get(token) ?? 0) + 1);
  const topicTokens = new Set(tokens(`${title} ${description}`));

  const ranked = passages
    .map((sentence) => ({
      ...sentence,
      score: scoreSentence(sentence.text, frequencies)
        + tokens(sentence.text).filter((token) => topicTokens.has(token)).length * 4,
    }))
    .sort((a, b) => b.score - a.score);
  const focused = ranked.filter((item) => (
    /市场|指数|数据|原因|结论|方法|步骤|问题|结果|建议|风险|变化|影响|重点|利率|价格|增长|下降|上涨|下跌|\d/.test(item.text)
    || tokens(item.text).some((token) => topicTokens.has(token))
  ));
  const pointCandidates = focused.length >= 4 ? focused : ranked;
  const keyPoints: typeof ranked = [];
  for (const candidate of pointCandidates) {
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
  const chapterCount = Math.max(3, Math.min(8, Math.ceil(duration / 240)));
  const chapterSize = Math.max(1, duration / chapterCount);
  const chapters = Array.from({ length: chapterCount }, (_, index) => {
    const start = index * chapterSize;
    const inChapter = passages.filter((sentence) => sentence.time >= start && sentence.time < start + chapterSize);
    const rankedChapter = inChapter
      .map((sentence) => ({ ...sentence, score: scoreSentence(sentence.text, frequencies) }))
      .sort((a, b) => b.score - a.score);
    const best = rankedChapter[0];
    const text = best?.text ?? `第 ${index + 1} 部分`;
    const details = rankedChapter.slice(0, 12).sort((a, b) => a.time - b.time);
    return {
      time: Math.round(start),
      title: extractTitle(text, frequencies, 28),
      summary: joinSentences(details, 900) || text,
    };
  });

  const headlineCandidate = keyPoints[0];
  const selected = [...keyPoints].sort((a, b) => a.time - b.time);
  const fallback = clean(description) || clean(title);
  return {
    headline: (!/^B站视频\s+BV/i.test(title) && title !== "未命名视频" ? title : headlineCandidate?.text.replace(/[。！？!?]$/, "").slice(0, 42)) || title,
    overview: chapters.slice(0, 3).map((item) => item.summary).filter(Boolean).join("\n\n") || fallback,
    keyPoints: selected.map((item) => {
      return {
        title: extractTitle(item.text, frequencies),
        detail: item.text.slice(0, 700),
        time: Math.round(item.time),
      };
    }),
    chapters,
    quotes: sentences
      .map((sentence) => ({ ...sentence, score: scoreSentence(sentence.text, frequencies) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, 3)
      .sort((a, b) => a.time - b.time)
      .map((item) => ({ time: Math.round(item.time), text: item.text })),
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
