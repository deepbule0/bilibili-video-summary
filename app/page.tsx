"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertCircle,
  ArrowRight,
  AudioLines,
  Check,
  CheckCircle2,
  Clock3,
  Copy,
  Download,
  ExternalLink,
  FileText,
  Link2,
  LoaderCircle,
  Play,
  RotateCcw,
  Share2,
  Sparkles,
  WandSparkles,
  Zap,
} from "lucide-react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Progress } from "@/components/ui/progress";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Toaster } from "@/components/ui/sonner";
import { formatTimestamp, type TranscriptSegment, type VideoSummary } from "@/lib/video-summary";

const exampleUrl = "https://www.bilibili.com/video/BV1Sve26eEGE/";
const localEngine = "http://127.0.0.1:8765";

type VideoInfo = {
  bvid: string;
  title: string;
  description: string;
  cover: string;
  owner: string;
  duration: number;
  part: string;
  partNumber: number;
  parts: number;
  url: string;
};

type Phase = "idle" | "reading" | "transcribing" | "summarizing" | "done" | "needs-engine" | "error";

const phaseCopy: Record<Phase, { label: string; detail: string; progress: number }> = {
  idle: { label: "等待链接", detail: "粘贴后即可开始", progress: 0 },
  reading: { label: "读取视频", detail: "正在获取标题、分 P 与字幕信息", progress: 18 },
  transcribing: { label: "语音转写", detail: "本地 Whisper 正在识别音频", progress: 58 },
  summarizing: { label: "整理重点", detail: "正在生成摘要、观点和时间线", progress: 84 },
  done: { label: "总结完成", detail: "结果已在本页生成", progress: 100 },
  "needs-engine": { label: "需要本地引擎", detail: "该视频没有可直接读取的字幕", progress: 28 },
  error: { label: "处理失败", detail: "请检查链接后重试", progress: 0 },
};

function toMarkdown(video: VideoInfo, summary: VideoSummary) {
  return [
    `# ${video.title}`,
    "",
    `> ${summary.overview}`,
    "",
    "## 核心观点",
    ...summary.keyPoints.map((point) => `- ${point}`),
    "",
    "## 时间线",
    ...summary.chapters.map((chapter) => `- **${formatTimestamp(chapter.time)} · ${chapter.title}** — ${chapter.summary}`),
    "",
    `关键词：${summary.keywords.join("、")}`,
    "",
    summary.disclaimer,
    "",
    `[查看原视频](${video.url})`,
  ].join("\n");
}

function downloadText(filename: string, content: string) {
  const blob = new Blob([content], { type: "text/markdown;charset=utf-8" });
  const href = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = href;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(href);
}

export default function Home() {
  const [url, setUrl] = useState(exampleUrl);
  const [useGpt, setUseGpt] = useState(false);
  const [phase, setPhase] = useState<Phase>("idle");
  const [progress, setProgress] = useState(0);
  const [video, setVideo] = useState<VideoInfo | null>(null);
  const [transcript, setTranscript] = useState<TranscriptSegment[]>([]);
  const [summary, setSummary] = useState<VideoSummary | null>(null);
  const [error, setError] = useState("");
  const [engineHint, setEngineHint] = useState(false);
  const autoStarted = useRef(false);
  const busy = ["reading", "transcribing", "summarizing"].includes(phase);
  const shownProgress = progress || phaseCopy[phase].progress;

  const analyze = useCallback(async (inputUrl: string, mode: "local" | "gpt" = useGpt ? "gpt" : "local") => {
    const trimmed = inputUrl.trim();
    if (!trimmed) throw new Error("请先粘贴 B 站视频链接");
    setUrl(trimmed);
    setVideo(null);
    setTranscript([]);
    setSummary(null);
    setError("");
    setEngineHint(false);
    setProgress(10);
    setPhase("reading");

    try {
      const infoResponse = await fetch(`/api/video?url=${encodeURIComponent(trimmed)}`);
      const info = await infoResponse.json();
      if (!infoResponse.ok) throw new Error(info.error || "视频读取失败");
      setVideo(info.video);
      setProgress(28);

      let activeTranscript = (info.transcript ?? []) as TranscriptSegment[];
      if (!activeTranscript.length) {
        setPhase("transcribing");
        setProgress(35);
        let engineConnected = false;
        try {
          const jobResponse = await fetch(`${localEngine}/api/jobs`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ url: trimmed, summary_mode: mode }),
          });
          if (!jobResponse.ok) throw new Error("本地引擎未就绪");
          engineConnected = true;
          const job = await jobResponse.json();
          for (let attempt = 0; attempt < 1800; attempt += 1) {
            await new Promise((resolve) => setTimeout(resolve, 1800));
            const statusResponse = await fetch(`${localEngine}/api/jobs/${job.id}`);
            if (!statusResponse.ok) throw new Error("无法读取本地转写进度");
            const status = await statusResponse.json();
            setProgress(Math.max(35, Math.min(82, Number(status.progress ?? 0))));
            if (status.status === "failed") throw new Error(status.error || "本地转写失败");
            if (status.status === "complete") {
              activeTranscript = status.transcript ?? [];
              setTranscript(activeTranscript);
              if (status.summary) {
                setSummary(status.summary);
                setVideo((current) => status.video ?? current);
                setProgress(100);
                setPhase("done");
                return status.summary as VideoSummary;
              }
              break;
            }
          }
        } catch (engineError) {
          if (engineConnected) throw engineError;
          setPhase("needs-engine");
          setEngineHint(true);
          setProgress(28);
          throw Object.assign(new Error("该视频没有公开字幕。启动一次本地引擎后，网页就能自动下载音频并免费转写。"), { handled: true });
        }
      }

      setTranscript(activeTranscript);
      setPhase("summarizing");
      setProgress(86);
      const summaryResponse = await fetch("/api/summarize", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: info.video.title,
          description: info.video.description,
          transcript: activeTranscript,
          mode,
        }),
      });
      const summaryData = await summaryResponse.json();
      if (!summaryResponse.ok) throw new Error(summaryData.error || "总结生成失败");
      setSummary(summaryData.summary);
      setProgress(100);
      setPhase("done");
      return summaryData.summary as VideoSummary;
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : "处理失败，请稍后重试";
      const handled = Boolean((caught as Error & { handled?: boolean })?.handled);
      setError(message);
      if (!handled) setPhase("error");
      throw caught;
    }
  }, [useGpt]);

  useEffect(() => {
    if (autoStarted.current) return;
    const params = new URLSearchParams(window.location.search);
    const sharedUrl = params.get("url");
    if (sharedUrl) {
      autoStarted.current = true;
      setUrl(sharedUrl);
      void analyze(sharedUrl, params.get("mode") === "gpt" ? "gpt" : "local").catch(() => undefined);
    }
  }, [analyze]);

  useEffect(() => {
    const context = (document as Document & { modelContext?: any }).modelContext;
    if (!context?.registerTool) return;
    const lifecycle = new AbortController();
    try {
      void Promise.resolve(context.registerTool({
        name: "summarize_bilibili_video",
        title: "总结 B 站视频",
        description: "读取一个 B 站视频链接，完成转写并在当前页面生成结构化中文总结。",
        inputSchema: {
          type: "object",
          properties: {
            url: { type: "string", description: "B 站视频链接或 BV 号" },
            mode: { type: "string", enum: ["local", "gpt"], description: "local 为零费用模式，gpt 为增强模式" },
          },
          required: ["url"],
          additionalProperties: false,
        },
        annotations: { readOnlyHint: false, untrustedContentHint: true },
        execute: async (input: { url: string; mode?: "local" | "gpt" }) => {
          const result = await analyze(input.url, input.mode ?? "local");
          return { headline: result.headline, overview: result.overview, keyPoints: result.keyPoints };
        },
      }, { signal: lifecycle.signal })).catch(() => undefined);
    } catch {
      // WebMCP is progressive enhancement; unsupported browsers keep the visible flow.
    }
    return () => lifecycle.abort();
  }, [analyze]);

  const markdown = useMemo(() => video && summary ? toMarkdown(video, summary) : "", [video, summary]);

  function submit(event: React.FormEvent) {
    event.preventDefault();
    void analyze(url).catch(() => undefined);
  }

  async function copySummary() {
    if (!markdown) return;
    await navigator.clipboard.writeText(markdown);
    toast.success("总结已复制");
  }

  async function copyDirectLink() {
    const direct = new URL(window.location.origin);
    direct.searchParams.set("url", url);
    direct.searchParams.set("mode", useGpt ? "gpt" : "local");
    await navigator.clipboard.writeText(direct.toString());
    toast.success("直达链接已复制");
  }

  return (
    <main className="min-h-screen overflow-hidden bg-background text-foreground">
      <div className="mesh" aria-hidden="true" />
      <header className="relative z-10 mx-auto flex w-full max-w-6xl items-center justify-between px-5 py-5 sm:px-8">
        <button className="flex items-center gap-3 text-left" onClick={() => { setPhase("idle"); setSummary(null); setVideo(null); }}>
          <span className="grid size-9 place-items-center rounded-xl bg-primary text-primary-foreground shadow-[0_0_30px_rgba(54,211,153,.22)]">
            <AudioLines className="size-5" strokeWidth={2.2} />
          </span>
          <span>
            <span className="block text-[15px] font-semibold leading-none tracking-tight">听见 · 总结</span>
            <span className="mt-1 block text-xs text-muted-foreground">B 站视频内容提炼</span>
          </span>
        </button>
        <span className="inline-flex items-center gap-2 rounded-full border border-border bg-card/60 px-3 py-1.5 text-xs text-muted-foreground backdrop-blur">
          <span className="size-1.5 rounded-full bg-emerald-400 shadow-[0_0_8px_rgba(52,211,153,.7)]" />
          本地转写 · 内容不上传
        </span>
      </header>

      <section className={`relative z-10 mx-auto w-full max-w-6xl px-5 sm:px-8 ${summary ? "pb-20 pt-8" : "pb-16 pt-[7vh] lg:pt-[11vh]"}`}>
        {!summary ? (
          <div className="grid gap-10 lg:grid-cols-[1.12fr_.88fr] lg:items-start lg:gap-16">
            <div className="max-w-2xl">
              <div className="mb-6 inline-flex items-center gap-2 rounded-full border border-primary/25 bg-primary/10 px-3 py-1.5 text-xs font-medium text-primary">
                <Sparkles className="size-3.5" />
                从 1 小时视频到 3 分钟要点
              </div>
              <h1 className="text-balance text-[clamp(2.65rem,6.8vw,5.6rem)] font-semibold leading-[.98] tracking-[-.055em]">
                链接放这里，
                <span className="text-primary">重点留下来。</span>
              </h1>
              <p className="mt-6 max-w-xl text-pretty text-base leading-7 text-muted-foreground sm:text-lg sm:leading-8">
                自动提取音频、识别中文语音，并整理成摘要、观点与时间线。优先使用免费本地模型，也可切换 GPT 获得更细致的结构化总结。
              </p>

              <form className="mt-9 rounded-2xl border border-border bg-card/70 p-2 shadow-[0_28px_90px_rgba(0,0,0,.28)] backdrop-blur-xl" onSubmit={submit}>
                <label htmlFor="video-url" className="sr-only">B 站视频链接</label>
                <div className="flex flex-col gap-2 sm:flex-row">
                  <div className="relative flex-1">
                    <Link2 className="pointer-events-none absolute left-3.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                    <Input id="video-url" value={url} onChange={(event) => setUrl(event.target.value)} disabled={busy} placeholder="粘贴 B 站视频链接或 BV 号" className="h-12 border-0 bg-transparent pl-10 text-[15px] shadow-none focus-visible:ring-0" />
                  </div>
                  <Button type="submit" size="lg" disabled={busy} className="h-12 rounded-xl px-5 font-semibold">
                    {busy ? <LoaderCircle className="size-4 animate-spin" /> : <ArrowRight className="size-4" />}
                    {busy ? "处理中" : "一键总结"}
                  </Button>
                </div>
              </form>

              <div className="mt-4 flex flex-wrap items-center justify-between gap-4 rounded-xl border border-border/70 bg-card/35 px-4 py-3">
                <div className="flex items-center gap-2.5">
                  <Switch id="gpt-mode" checked={useGpt} onCheckedChange={setUseGpt} disabled={busy} />
                  <label htmlFor="gpt-mode" className="cursor-pointer text-sm">
                    <span className="font-medium">GPT 增强总结</span>
                    <span className="ml-2 text-xs text-muted-foreground">关闭时全程零模型费用</span>
                  </label>
                </div>
                <Badge variant="outline" className={useGpt ? "border-primary/35 text-primary" : "text-muted-foreground"}>
                  {useGpt ? "更强语义整理" : "零费用模式"}
                </Badge>
              </div>

              <div className="mt-5 flex flex-wrap gap-x-5 gap-y-2 text-xs text-muted-foreground">
                {["音频自动提取", "离线 Whisper 转写", "结果可复制分享"].map((item) => (
                  <span key={item} className="inline-flex items-center gap-1.5"><Check className="size-3.5 text-primary" />{item}</span>
                ))}
              </div>
            </div>

            <aside className="relative lg:pt-3" aria-label="处理状态">
              <div className="absolute -inset-8 -z-10 rounded-full bg-primary/8 blur-3xl" />
              <div className="overflow-hidden rounded-[1.6rem] border border-border bg-card/80 shadow-[0_30px_100px_rgba(0,0,0,.35)] backdrop-blur-xl">
                {phase === "idle" ? (
                  <>
                    <div className="flex items-center justify-between border-b border-border px-5 py-4">
                      <div><p className="text-xs font-medium text-primary">输出结构</p><p className="mt-0.5 text-sm font-semibold">一份能直接阅读的内容笔记</p></div>
                      <span className="rounded-full bg-secondary px-2.5 py-1 text-[11px] text-muted-foreground">约 3 分钟读完</span>
                    </div>
                    <div className="space-y-5 p-5 sm:p-6">
                      <div><p className="mb-2 text-xs font-medium uppercase tracking-[.12em] text-muted-foreground">一句话结论</p><p className="text-base font-medium leading-7">把冗长口述压缩成可验证的观点，同时保留原视频的时间位置。</p></div>
                      <div className="grid gap-2.5">
                        {["核心观点与支撑理由", "按主题整理的关键事实", "可跳转的章节与时间线"].map((item, index) => (
                          <div key={item} className="flex items-center gap-3 rounded-xl border border-border/80 bg-background/45 px-3.5 py-3">
                            <span className="grid size-6 shrink-0 place-items-center rounded-lg bg-primary/12 text-xs font-semibold text-primary">{index + 1}</span><span className="text-sm text-foreground/90">{item}</span>
                          </div>
                        ))}
                      </div>
                      <div className="rounded-xl border border-dashed border-primary/30 bg-primary/[.06] px-4 py-3 text-xs leading-5 text-muted-foreground">默认模式不收取模型费用；启用 GPT 时才会按你的 API 用量计费。</div>
                    </div>
                  </>
                ) : (
                  <div className="p-5 sm:p-6">
                    <div className="flex items-start justify-between gap-4">
                      <div>
                        <p className={`text-xs font-medium ${phase === "error" ? "text-red-400" : "text-primary"}`}>{phaseCopy[phase].label}</p>
                        <h2 className="mt-1 text-lg font-semibold">{video?.title ?? "正在解析视频链接"}</h2>
                        {video && <p className="mt-1 text-xs text-muted-foreground">{video.owner} · {formatTimestamp(video.duration)}{video.parts > 1 ? ` · 共 ${video.parts} P` : ""}</p>}
                      </div>
                      {busy ? <LoaderCircle className="size-5 animate-spin text-primary" /> : phase === "error" ? <AlertCircle className="size-5 text-red-400" /> : <AudioLines className="size-5 text-primary" />}
                    </div>
                    <Progress value={shownProgress} className="mt-5" />
                    <div className="mt-5 grid grid-cols-3 gap-2 text-center text-[11px] text-muted-foreground">
                      {[{ label: "读取视频", at: 18 }, { label: "语音转写", at: 58 }, { label: "整理重点", at: 84 }].map((step) => (
                        <div key={step.label} className={shownProgress >= step.at ? "text-primary" : ""}>
                          <span className={`mx-auto mb-1.5 grid size-6 place-items-center rounded-full ${shownProgress >= step.at ? "bg-primary/15" : "bg-secondary"}`}>{shownProgress > step.at ? <Check className="size-3.5" /> : <span className="size-1.5 rounded-full bg-current" />}</span>
                          {step.label}
                        </div>
                      ))}
                    </div>
                    <p className="mt-5 text-center text-sm text-muted-foreground">{error || phaseCopy[phase].detail}</p>
                    {engineHint && (
                      <div className="mt-5 rounded-xl border border-primary/25 bg-primary/[.06] p-4">
                        <div className="flex gap-3"><Zap className="mt-0.5 size-4 shrink-0 text-primary" /><div><p className="text-sm font-medium">首次使用只需启动一次</p><p className="mt-1 text-xs leading-5 text-muted-foreground">在下载的项目目录双击「start-local.bat」，浏览器会自动打开完整本地版。模型只在首次使用时下载。</p></div></div>
                        <Button variant="outline" size="sm" className="mt-3 w-full" onClick={() => window.location.reload()}><RotateCcw className="size-3.5" />启动后重新检测</Button>
                      </div>
                    )}
                  </div>
                )}
              </div>
            </aside>
          </div>
        ) : video && (
          <div className="animate-in fade-in slide-in-from-bottom-2 duration-500">
            <div className="mb-7 flex flex-col gap-5 rounded-[1.5rem] border border-border bg-card/70 p-5 backdrop-blur-xl sm:flex-row sm:items-center sm:justify-between sm:p-6">
              <div className="flex min-w-0 items-center gap-4">
                <div className="grid size-12 shrink-0 place-items-center rounded-2xl bg-primary/12 text-primary"><CheckCircle2 className="size-6" /></div>
                <div className="min-w-0"><p className="text-xs font-medium text-primary">总结完成 · {summary.mode === "gpt" ? "GPT 增强" : "零费用模式"}</p><h1 className="mt-1 truncate text-lg font-semibold sm:text-xl">{video.title}</h1><p className="mt-1 text-xs text-muted-foreground">{video.owner} · {formatTimestamp(video.duration)} · {transcript.length} 段转写</p></div>
              </div>
              <div className="flex flex-wrap gap-2">
                <Button variant="outline" size="sm" onClick={() => { setSummary(null); setPhase("idle"); }}><RotateCcw className="size-3.5" />新建</Button>
                <Button variant="outline" size="sm" onClick={copyDirectLink}><Share2 className="size-3.5" />直达链接</Button>
                <Button size="sm" onClick={copySummary}><Copy className="size-3.5" />复制总结</Button>
              </div>
            </div>

            <div className="grid gap-7 lg:grid-cols-[minmax(0,1fr)_300px]">
              <article className="rounded-[1.5rem] border border-border bg-card/78 p-5 shadow-[0_24px_80px_rgba(0,0,0,.2)] backdrop-blur-xl sm:p-8">
                <div className="border-b border-border pb-7"><p className="text-xs font-medium uppercase tracking-[.13em] text-primary">一句话结论</p><h2 className="mt-3 text-pretty text-2xl font-semibold leading-[1.35] tracking-tight sm:text-3xl">{summary.headline}</h2><p className="mt-4 text-[15px] leading-7 text-muted-foreground">{summary.overview}</p></div>
                <Tabs defaultValue="points" className="mt-6">
                  <TabsList><TabsTrigger value="points"><Sparkles />要点</TabsTrigger><TabsTrigger value="timeline"><Clock3 />时间线</TabsTrigger><TabsTrigger value="transcript"><FileText />转写</TabsTrigger></TabsList>
                  <TabsContent value="points" className="mt-5 space-y-3">
                    {summary.keyPoints.map((point, index) => <div key={`${point}-${index}`} className="flex gap-3 rounded-xl border border-border/80 bg-background/30 p-4"><span className="grid size-7 shrink-0 place-items-center rounded-lg bg-primary/12 text-xs font-semibold text-primary">{index + 1}</span><p className="text-[15px] leading-7 text-foreground/90">{point}</p></div>)}
                  </TabsContent>
                  <TabsContent value="timeline" className="mt-5 space-y-1">
                    {summary.chapters.map((chapter, index) => <a key={`${chapter.time}-${index}`} href={`${video.url}&t=${Math.round(chapter.time)}`} target="_blank" rel="noreferrer" className="group grid grid-cols-[58px_1fr] gap-3 rounded-xl p-3 transition-colors hover:bg-primary/[.07]"><span className="font-mono text-xs text-primary">{formatTimestamp(chapter.time)}</span><span><span className="block text-sm font-medium group-hover:text-primary">{chapter.title}</span><span className="mt-1 block text-sm leading-6 text-muted-foreground">{chapter.summary}</span></span></a>)}
                  </TabsContent>
                  <TabsContent value="transcript" className="mt-5 max-h-[520px] space-y-1 overflow-y-auto pr-2 scrollbar-thin">
                    {transcript.map((segment, index) => <a key={`${segment.start}-${index}`} href={`${video.url}&t=${Math.round(segment.start)}`} target="_blank" rel="noreferrer" className="grid grid-cols-[58px_1fr] gap-3 rounded-lg px-3 py-2 text-sm hover:bg-primary/[.06]"><span className="font-mono text-xs text-primary">{formatTimestamp(segment.start)}</span><span className="leading-6 text-muted-foreground">{segment.text}</span></a>)}
                  </TabsContent>
                </Tabs>
              </article>

              <aside className="space-y-4">
                <div className="rounded-[1.35rem] border border-border bg-card/75 p-5 backdrop-blur-xl"><p className="text-xs font-medium uppercase tracking-[.12em] text-muted-foreground">关键词</p><div className="mt-3 flex flex-wrap gap-2">{summary.keywords.map((keyword) => <Badge key={keyword} variant="secondary">{keyword}</Badge>)}</div></div>
                <div className="rounded-[1.35rem] border border-border bg-card/75 p-5 backdrop-blur-xl"><p className="text-xs font-medium uppercase tracking-[.12em] text-muted-foreground">高信息片段</p><div className="mt-3 space-y-4">{summary.quotes.map((quote, index) => <div key={`${quote.time}-${index}`}><span className="text-xs font-mono text-primary">{formatTimestamp(quote.time)}</span><p className="mt-1 text-sm leading-6 text-foreground/85">{quote.text}</p></div>)}</div></div>
                <div className="grid gap-2">
                  <Button variant="outline" onClick={() => downloadText(`${video.bvid}-summary.md`, markdown)}><Download className="size-4" />下载 Markdown</Button>
                  <Button variant="outline" asChild><a href={video.url} target="_blank" rel="noreferrer"><Play className="size-4" />打开原视频<ExternalLink className="size-3.5" /></a></Button>
                </div>
                <p className="px-1 text-xs leading-5 text-muted-foreground">{summary.disclaimer}</p>
              </aside>
            </div>
          </div>
        )}
      </section>
      <Toaster position="top-center" richColors />
    </main>
  );
}
