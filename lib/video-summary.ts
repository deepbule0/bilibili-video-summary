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
  "今天", "大家", "老师", "主播", "正常", "肯定", "来了", "看到", "好不好", "对吧",
  "the", "and", "that", "with", "from", "this", "have", "will", "about",
]);

const CHATTER_PATTERN = /能听到吗|声音(?:正不)?正常|麦克风|没戴眼镜|看不清楚|眼花|导盲犬|给我发点信号|周末愉快|感谢.*(?:礼物|关注)|点个赞|刷一波|欢迎.*(?:进入|来到)|谁来了|读.*名字|叫我读|帅哥|美女|小伙伴.*来了|直播间|弹幕|摄像头|网络.*卡|稍等一下/;
const FILLER_PATTERN = /^(?:嗯+|啊+|哦+|哎+|哎呀|对|是|好|好的|行|没错|然后|所以|就是|这个|那个|亲爱的|各位同学|各位朋友|大家好|sorry)$/i;
const INFORMATION_CUES = /原因|结论|重点|核心|意味着|影响|结果|方法|步骤|建议|风险|变化|趋势|数据|案例|例如|首先|其次|最后|问题|解决|需要|应该|必须|关键|本质|逻辑|判断|预测|观点|策略|机会|成本|增长|下降|提高|降低|发生|导致|由于|因此|但|如果|未来|过去|目前|\d/;

const WORD_SEGMENTER = new Intl.Segmenter("zh-CN", { granularity: "word" });

function clean(text: string) {
  return text.replace(/\s+/g, " ").replace(/([，。！？；：])\1+/g, "$1").trim();
}

function cleanSpokenText(text: string) {
  return clean(text)
    .replace(/(?:亲爱的|各位同学|各位朋友|各位观众)(?=[，。；、\s]|$)/g, "")
    .replace(/(?:大家(?:看一下|听一下)|我们(?:再|来|现在)?看一下|我(?:再|现在)?看一下)/g, "")
    .replace(/(?:对吧|好不好|懂的都懂|应该说|也就是说)(?=[，。；、\s]|$)/g, "")
    .replace(/(?:嗯+|啊+|哦+|哎呀)(?=[，。；、\s]|$)/g, "")
    .replace(/[，、]\s*[，、]+/g, "，")
    .replace(/^[，。；、\s]+|[，；、\s]+$/g, "")
    .trim();
}

function isObviousChatter(text: string) {
  const value = cleanSpokenText(text);
  return value.length < 80 && CHATTER_PATTERN.test(value) && !INFORMATION_CUES.test(value);
}

function isUsefulSegment(text: string) {
  const value = cleanSpokenText(text);
  if (!value || FILLER_PATTERN.test(value) || isObviousChatter(value)) return false;
  if (value.length <= 3 && !INFORMATION_CUES.test(value)) return false;
  return true;
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
    .filter(([word]) => word.length < 10 && !isObviousChatter(word))
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([word]) => word);
}

function scorePassage(text: string, frequencies: Map<string, number>) {
  const words = tokens(text);
  if (!words.length) return 0;
  const frequencyScore = words.reduce((sum, word) => sum + (frequencies.get(word) ?? 0), 0) / Math.sqrt(words.length);
  const informationBonus = (text.match(new RegExp(INFORMATION_CUES.source, "g")) ?? []).length * 5;
  const numericBonus = (text.match(/\d+(?:\.\d+)?%?/g) ?? []).length * 2;
  const lengthFactor = text.length < 35 ? 0.65 : text.length > 700 ? 0.82 : 1;
  return (frequencyScore + informationBonus + numericBonus) * lengthFactor;
}

function buildUsefulPassages(segments: TranscriptSegment[], windowSeconds = 70) {
  const passages: Array<{ text: string; time: number }> = [];
  let current: TranscriptSegment[] = [];

  const flush = () => {
    if (!current.length) return;
    const parts: string[] = [];
    for (const segment of current) {
      const value = cleanSpokenText(segment.text).replace(/[。！？!?]$/, "");
      if (!value || parts.at(-1) === value) continue;
      parts.push(value);
    }
    const text = clean(`${parts.join("，")}。`);
    if (text.length >= 18) passages.push({ time: current[0].start, text });
    current = [];
  };

  for (const segment of segments) {
    if (!isUsefulSegment(segment.text)) continue;
    const previous = current[current.length - 1];
    const characterCount = current.reduce((sum, item) => sum + item.text.length, 0);
    if (previous && (segment.start - current[0].start >= windowSeconds || segment.start - previous.end > 14 || characterCount >= 440)) flush();
    current.push(segment);
  }
  flush();
  return passages;
}

function splitClaims(text: string) {
  return cleanSpokenText(text)
    .split(/[。！？!?；;]+/)
    .map((item) => cleanSpokenText(item))
    .filter((item) => item.length >= 8 && !isObviousChatter(item));
}

function extractTitle(text: string, frequencies: Map<string, number>, limit = 32) {
  const candidates = splitClaims(text)
    .map((item) => ({ text: item, score: scorePassage(item, frequencies) }))
    .sort((a, b) => b.score - a.score);
  const candidate = candidates[0]?.text || cleanSpokenText(text);
  return candidate.replace(/^(?:然后|所以|但是|因为|这个|那个|就是)+/, "").slice(0, limit);
}

function selectDistinct<T extends { text: string }>(items: T[], limit: number) {
  const selected: T[] = [];
  for (const candidate of items) {
    const candidateTokens = new Set(tokens(candidate.text));
    const duplicate = selected.some((picked) => {
      const pickedTokens = new Set(tokens(picked.text));
      const overlap = [...candidateTokens].filter((token) => pickedTokens.has(token)).length;
      return overlap / Math.max(1, Math.min(candidateTokens.size, pickedTokens.size)) > 0.58;
    });
    if (!duplicate) selected.push(candidate);
    if (selected.length === limit) break;
  }
  return selected;
}

export function summarizeLocally(
  title: string,
  segments: TranscriptSegment[],
  description = "",
): VideoSummary {
  const passages = buildUsefulPassages(segments);
  const fallback = clean(description) || clean(title);
  if (!passages.length) {
    return {
      headline: title,
      overview: fallback,
      keyPoints: [],
      chapters: [],
      quotes: [],
      keywords: [],
      disclaimer: "没有识别到足够清晰的有效内容，请查看原始转写或更换音质更清楚的视频。",
      mode: "local",
    };
  }

  const sourceText = `${title}\n${description}\n${passages.map((item) => item.text).join("\n")}`;
  const frequencies = new Map<string, number>();
  for (const token of tokens(sourceText)) frequencies.set(token, (frequencies.get(token) ?? 0) + 1);
  const topicTokens = new Set(tokens(`${title} ${description}`));
  const ranked = passages
    .map((passage) => ({
      ...passage,
      score: scorePassage(passage.text, frequencies) + tokens(passage.text).filter((token) => topicTokens.has(token)).length * 4,
    }))
    .sort((a, b) => b.score - a.score);
  const keyPassages = selectDistinct(ranked, Math.min(10, Math.max(3, Math.ceil(passages.length / 3))));
  const overviewPassages = [...keyPassages].sort((a, b) => a.time - b.time).slice(0, 8);
  const overview = overviewPassages.map((item) => item.text).join(" ") || fallback;
  const keyPoints = keyPassages
    .map((item) => ({ title: extractTitle(item.text, frequencies), detail: item.text.slice(0, 750), time: Math.round(item.time) }))
    .sort((a, b) => a.time - b.time);

  return {
    headline: (!/^B站视频\s+BV/i.test(title) && title !== "未命名视频" ? title : keyPoints[0]?.title) || title,
    overview,
    keyPoints,
    chapters: keyPoints.map((point) => ({ time: point.time, title: point.title, summary: point.detail })),
    quotes: ranked.slice(0, 3).sort((a, b) => a.time - b.time).map((item) => ({ time: Math.round(item.time), text: item.text.slice(0, 360) })),
    keywords: topKeywords(sourceText),
    disclaimer: "已自动过滤明显的直播互动、设备调试、重复口头禅和低信息片段。本地规则总结仅作备用，优先使用 Qwen3.5 本地模型生成的结果。",
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
