"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertCircle,
  ArrowRight,
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
import { SiteNav } from "@/components/site-nav";
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

function extractBvid(value: string) {
  return value.match(/BV[1-9A-HJ-NP-Za-km-z]{10}/)?.[0] ?? "";
}

async function readJsonResponse(response: Response) {
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`线上接口返回了非 JSON 内容（HTTP ${response.status}），已停止解析以避免显示无意义错误。`);
  }
}

const phaseCopy: Record<Phase, { label: string; detail: string; progress: number }> = {
  idle: { label: "等待链接", detail: "粘贴后即可开始", progress: 0 },
  reading: { label: "读取视频", detail: "正在获取标题、分 P 与字幕信息", progress: 18 },
  transcribing: { label: "语音转写", detail: "本地 Whisper 正在识别音频", progress: 58 },
  summarizing: { label: "提炼内容", detail: "Qwen3.5 正在过滤口语并生成完整总结", progress: 84 },
  done: { label: "总结完成", detail: "结果已在本页生成", progress: 100 },
  "needs-engine": { label: "需要本地引擎", detail: "该视频没有可直接读取的字幕", progress: 28 },
  error: { label: "处理失败", detail: "请检查链接后重试", progress: 0 },
};

function toMarkdown(video: VideoInfo, summary: VideoSummary, transcript: TranscriptSegment[]) {
  return [
    `# ${video.title}`,
    "",
    "## 完整内容总结",
    summary.overview,
    "",
    "## 关键洞察",
    ...summary.keyPoints.flatMap((point) => [`### ${point.title}`, point.detail, `时间：${formatTimestamp(point.time)}`, ""]),
    "## 主题解读",
    ...summary.chapters.flatMap((chapter) => [`### ${formatTimestamp(chapter.time)} · ${chapter.title}`, chapter.summary, ""]),
    "",
    `关键词：${summary.keywords.join("、")}`,
    "",
    summary.disclaimer,
    "",
    "## 原始转写全文（未过滤）",
    ...transcript.map((segment) => `[${formatTimestamp(segment.start)}] ${segment.text}`),
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
  const [transcriptionDevice, setTranscriptionDevice] = useState("");
  const [summaryModel, setSummaryModel] = useState("");
  const [summaryDevice, setSummaryDevice] = useState("");
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
    setTranscriptionDevice("");
    setSummaryModel("");
    setSummaryDevice("");
    setProgress(10);
    setPhase("reading");

    try {
      // Commercial path: the hosted API owns authentication, quota reservation,
      // queue priority and settlement. If no public GPU worker is configured yet,
      // the owner's existing loopback engine remains available as a launch fallback.
      const serviceResponse = await fetch("/api/jobs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: trimmed, mode }),
      });
      const serviceData = await readJsonResponse(serviceResponse);
      if (serviceResponse.status === 401) {
        throw new Error("请先点击右上角“登录 / 注册”，登录后即可领取30分钟免费试用");
      }
      if (serviceResponse.ok && serviceData.ok && serviceData.id) {
        setPhase("transcribing");
        setProgress(32);
        for (let attempt = 0; attempt < 1800; attempt += 1) {
          await new Promise((resolve) => setTimeout(resolve, 1800));
          const statusResponse = await fetch(`/api/jobs/${serviceData.id}`);
          const status = await readJsonResponse(statusResponse);
          if (!statusResponse.ok || !status.ok) throw new Error(status.error || "无法读取云端处理进度");
          if (status.stage === "summarize") setPhase("summarizing");
          setProgress(Math.max(32, Math.min(status.stage === "summarize" ? 98 : 84, Number(status.progress ?? 0))));
          if (status.device) setTranscriptionDevice(String(status.device));
          if (status.status === "failed") throw new Error(status.error || "GPU 处理失败，预留额度已经退回");
          if (status.status === "complete") {
            const serviceTranscript = (status.transcript ?? []) as TranscriptSegment[];
            const serviceVideo = status.video as VideoInfo | undefined;
            if (serviceVideo) setVideo(serviceVideo);
            setTranscript(serviceTranscript);
            if (status.summary) {
              setSummaryModel(String(status.summary_model ?? "qwen3.5:9b"));
              setSummaryDevice(String(status.summary_device ?? "GPU"));
              setSummary(status.summary as VideoSummary);
              setProgress(100);
              setPhase("done");
              return status.summary as VideoSummary;
            }
            if (!serviceVideo || !serviceTranscript.length) throw new Error("GPU 任务已完成，但没有返回可用的转写内容");
            setPhase("summarizing");
            const enhancedResponse = await fetch("/api/summarize", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ title: serviceVideo.title, description: serviceVideo.description, transcript: serviceTranscript, mode, jobId: serviceData.id }),
            });
            const enhanced = await readJsonResponse(enhancedResponse);
            if (!enhancedResponse.ok || !enhanced.ok || !enhanced.summary) throw new Error(enhanced.error || "总结生成失败");
            setSummary(enhanced.summary as VideoSummary);
            setProgress(100);
            setPhase("done");
            return enhanced.summary as VideoSummary;
          }
        }
        throw new Error("处理时间超过预期，请稍后在账户中心查看任务状态");
      }
      if (serviceData.code && serviceData.code !== "GPU_ENGINE_NOT_CONFIGURED") {
        throw new Error(serviceData.error || "云端任务创建失败");
      }

      const infoResponse = await fetch(`/api/video?url=${encodeURIComponent(trimmed)}`, {
        credentials: "same-origin",
        headers: { Accept: "application/json" },
      });
      let info: any;
      try {
        info = await readJsonResponse(infoResponse);
      } catch {
        info = { ok: false, error: "线上视频接口暂时不可用", bvid: extractBvid(trimmed) };
      }
      const fallbackBvid = info.bvid || extractBvid(trimmed);
      if (!info.ok && !fallbackBvid) throw new Error(info.error || "无法从链接中识别 BV 号");
      let activeVideo: VideoInfo = info.video ?? {
        bvid: fallbackBvid,
        title: fallbackBvid ? `B站视频 ${fallbackBvid}` : "B站视频",
        description: "",
        cover: "",
        owner: "",
        duration: 0,
        part: "",
        partNumber: 1,
        parts: 1,
        url: `https://www.bilibili.com/video/${fallbackBvid}/`,
      };
      setVideo(activeVideo);
      setProgress(28);

      let activeTranscript = (info.transcript ?? []) as TranscriptSegment[];
      let localSummaryAttempted = false;
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
            if (status.stage === "summarize") setPhase("summarizing");
            setProgress(Math.max(35, Math.min(status.stage === "summarize" ? 98 : 82, Number(status.progress ?? 0))));
            if (status.device) setTranscriptionDevice(String(status.device));
            if (status.status === "failed") throw new Error(status.error || "本地转写失败");
            if (status.status === "complete") {
              activeTranscript = status.transcript ?? [];
              setTranscript(activeTranscript);
              localSummaryAttempted = mode === "local" && Boolean(status.summary || status.summary_error || status.summary_model !== undefined);
              if (status.video) {
                activeVideo = status.video as VideoInfo;
                setVideo(activeVideo);
              }
              if (status.summary) {
                setSummaryModel(String(status.summary_model ?? "qwen3.5:9b"));
                setSummaryDevice(String(status.summary_device ?? ""));
                setSummary(status.summary);
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
      if (mode === "local" && !localSummaryAttempted) {
        try {
          const localSummaryResponse = await fetch(`${localEngine}/api/summarize`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ title: activeVideo.title, description: activeVideo.description, transcript: activeTranscript }),
          });
          const localSummaryData = await localSummaryResponse.json();
          if (localSummaryResponse.ok && localSummaryData.ok && localSummaryData.summary) {
            setSummaryModel(String(localSummaryData.summary_model ?? "qwen3.5:9b"));
            setSummaryDevice(String(localSummaryData.summary_device ?? ""));
            setSummary(localSummaryData.summary);
            setProgress(100);
            setPhase("done");
            return localSummaryData.summary as VideoSummary;
          }
        } catch {
          // The hosted rule-based summary below remains available as a fallback.
        }
      }
      const summaryResponse = await fetch("/api/summarize", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: activeVideo.title,
          description: activeVideo.description,
          transcript: activeTranscript,
          mode,
        }),
      });
      const summaryData = await readJsonResponse(summaryResponse);
      if (!summaryResponse.ok || !summaryData.ok || !summaryData.summary) {
        throw new Error(summaryData.error || "总结生成失败");
      }
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

  const transcriptText = useMemo(
    () => transcript.map((segment) => `[${formatTimestamp(segment.start)}] ${segment.text}`).join("\n"),
    [transcript],
  );
  const markdown = useMemo(() => video && summary ? toMarkdown(video, summary, transcript) : "", [video, summary, transcript]);

  function submit(event: React.FormEvent) {
    event.preventDefault();
    void analyze(url).catch(() => undefined);
  }

  async function copySummary() {
    if (!markdown) return;
    await navigator.clipboard.writeText(markdown);
    toast.success("总结已复制");
  }

  async function copyTranscript() {
    if (!transcriptText) return;
    await navigator.clipboard.writeText(transcriptText);
    toast.success("完整转写已复制");
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
      <SiteNav />

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
                      {[{ label: "读取视频", at: 18 }, { label: "语音转写", at: 58 }, { label: "提炼内容", at: 84 }].map((step) => (
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
                <div className="min-w-0"><p className="text-xs font-medium text-primary">总结完成 · {summary.mode === "gpt" ? "GPT 增强" : "零费用模式"}{transcriptionDevice ? ` · ${transcriptionDevice === "cuda" ? "GPU 转写" : "CPU 转写"}` : ""}{summaryModel ? ` · ${summaryModel.replace("qwen3.5:", "Qwen3.5 ")} ${summaryDevice === "gpu" ? "GPU" : "本地"}总结` : ""}</p><h1 className="mt-1 truncate text-lg font-semibold sm:text-xl">{video.title}</h1><p className="mt-1 text-xs text-muted-foreground">{video.owner} · {formatTimestamp(video.duration)} · {transcript.length} 段转写</p></div>
              </div>
              <div className="flex flex-wrap gap-2">
                <Button variant="outline" size="sm" onClick={() => { setSummary(null); setPhase("idle"); }}><RotateCcw className="size-3.5" />新建</Button>
                <Button variant="outline" size="sm" onClick={copyDirectLink}><Share2 className="size-3.5" />直达链接</Button>
                <Button size="sm" onClick={copySummary}><Copy className="size-3.5" />复制总结</Button>
              </div>
            </div>

            <div className="grid gap-7 lg:grid-cols-[minmax(0,1fr)_300px]">
              <article className="rounded-[1.5rem] border border-border bg-card/78 p-5 shadow-[0_24px_80px_rgba(0,0,0,.2)] backdrop-blur-xl sm:p-8">
                <div className="border-b border-border pb-7"><p className="text-xs font-medium uppercase tracking-[.13em] text-primary">内容核心结论</p><h2 className="mt-3 text-pretty text-2xl font-semibold leading-[1.35] tracking-tight sm:text-3xl">{summary.headline}</h2></div>
                <Tabs defaultValue="summary" className="mt-6">
                  <TabsList className="w-full"><TabsTrigger value="summary"><FileText />完整总结</TabsTrigger><TabsTrigger value="points"><Sparkles />关键洞察</TabsTrigger><TabsTrigger value="detail"><Clock3 />主题解读</TabsTrigger><TabsTrigger value="transcript"><AudioLines />原始转写</TabsTrigger></TabsList>
                  <TabsContent value="summary" className="mt-6">
                    <div className="rounded-2xl border border-primary/20 bg-primary/[.045] p-5 sm:p-6"><div className="mb-4 flex flex-wrap items-center gap-2"><Badge variant="secondary">已过滤低信息口语</Badge><span className="text-xs text-muted-foreground">只保留与视频主题直接相关的有效内容</span></div><p className="whitespace-pre-line text-[16px] leading-8 text-foreground/90">{summary.overview}</p></div>
                  </TabsContent>
                  <TabsContent value="detail" className="mt-6 space-y-7">
                    {summary.chapters.map((chapter, index) => <section key={`${chapter.time}-${index}`} className="border-b border-border/70 pb-6 last:border-0 last:pb-0"><h3 className="text-lg font-semibold leading-7">{chapter.title}</h3><p className="mt-3 text-[15px] leading-8 text-foreground/85">{chapter.summary}</p><a href={`${video.url}&t=${Math.round(chapter.time)}`} target="_blank" rel="noreferrer" className="mt-3 inline-block text-xs text-primary hover:underline">查看相关原片 · {formatTimestamp(chapter.time)}</a></section>)}
                  </TabsContent>
                  <TabsContent value="points" className="mt-5 space-y-3">
                    {summary.keyPoints.map((point, index) => <div key={`${point.title}-${index}`} className="flex gap-3 rounded-xl border border-border/80 bg-background/30 p-4"><span className="grid size-7 shrink-0 place-items-center rounded-lg bg-primary/12 text-xs font-semibold text-primary">{index + 1}</span><div><h3 className="text-[15px] font-semibold leading-7 text-foreground">{point.title}</h3><p className="mt-1 text-sm leading-7 text-muted-foreground">{point.detail}</p><a href={`${video.url}&t=${Math.round(point.time)}`} target="_blank" rel="noreferrer" className="mt-2 inline-block text-xs text-primary hover:underline">定位原片 · {formatTimestamp(point.time)}</a></div></div>)}
                  </TabsContent>
                  <TabsContent value="transcript" className="mt-5">
                    <div className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border bg-background/35 p-4"><div><p className="text-sm font-medium">原始转写（未过滤）</p><p className="mt-1 text-xs text-muted-foreground">保留全部口语供核对 · 共 {transcript.length} 段，约 {transcript.reduce((sum, item) => sum + item.text.length, 0).toLocaleString()} 字</p></div><Button variant="outline" size="sm" onClick={copyTranscript}><Copy className="size-3.5" />复制原文</Button></div>
                    <div className="max-h-[560px] space-y-1 overflow-y-auto pr-2 scrollbar-thin">{transcript.map((segment, index) => <a key={`${segment.start}-${index}`} href={`${video.url}&t=${Math.round(segment.start)}`} target="_blank" rel="noreferrer" className="grid grid-cols-[58px_1fr] gap-3 rounded-lg px-3 py-2 text-sm hover:bg-primary/[.06]"><span className="font-mono text-xs text-primary">{formatTimestamp(segment.start)}</span><span className="leading-7 text-foreground/80">{segment.text}</span></a>)}</div>
                  </TabsContent>
                </Tabs>
              </article>

              <aside className="space-y-4">
                <div className="rounded-[1.35rem] border border-border bg-card/75 p-5 backdrop-blur-xl"><p className="text-xs font-medium uppercase tracking-[.12em] text-muted-foreground">关键词</p><div className="mt-3 flex flex-wrap gap-2">{summary.keywords.map((keyword) => <Badge key={keyword} variant="secondary">{keyword}</Badge>)}</div></div>
                <div className="rounded-[1.35rem] border border-border bg-card/75 p-5 backdrop-blur-xl"><p className="text-xs font-medium uppercase tracking-[.12em] text-muted-foreground">高信息证据片段</p><div className="mt-3 space-y-4">{summary.quotes.map((quote, index) => <div key={`${quote.time}-${index}`}><span className="text-xs font-mono text-primary">{formatTimestamp(quote.time)}</span><p className="mt-1 text-sm leading-6 text-foreground/85">{quote.text}</p></div>)}</div></div>
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
