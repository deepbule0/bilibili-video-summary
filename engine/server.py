from __future__ import annotations

import os
import re
import hashlib
import gc
import json
import shutil
import tempfile
import threading
import time
import uuid
from concurrent.futures import ThreadPoolExecutor
from difflib import SequenceMatcher
from pathlib import Path
from typing import Callable, Literal
from urllib.parse import urlparse

import requests
from fastapi import BackgroundTasks, FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field


app = FastAPI(title="B站视频总结本地引擎", version="1.0.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["Content-Type"],
)


@app.middleware("http")
async def allow_local_network_access(request, call_next):
    """Allow an HTTPS page to call this loopback-only service in Chromium."""
    response = await call_next(request)
    if request.headers.get("access-control-request-private-network") == "true":
        response.headers["Access-Control-Allow-Private-Network"] = "true"
    return response

jobs: dict[str, dict] = {}
jobs_lock = threading.Lock()
models: dict[str, object] = {}
model_devices: dict[str, str] = {}
model_fallback_reasons: dict[str, str] = {}
model_lock = threading.Lock()
pipeline_lock = threading.Lock()

OLLAMA_URL = os.environ.get("OLLAMA_URL", "http://127.0.0.1:11434").rstrip("/")
SUMMARY_MODEL = os.environ.get("SUMMARY_MODEL", "qwen3.5:9b")
OLLAMA_HTTP = requests.Session()
OLLAMA_HTTP.trust_env = False

CHATTER_PATTERN = re.compile(
    r"能听到吗|声音.*正常|麦克风|没戴眼镜|看不清楚|眼睛|眼花|导盲犬|"
    r"发点信号|周末愉快|感谢.*(?:礼物|关注)|点个赞|刷一波|欢迎.*(?:进入|来到)|"
    r"谁来了|还有谁|来了|我看到了|名字.*记得|读.*名字|叫我读|帅哥|美女|小伙伴.*来了|"
    r"直播间|弹幕|摄像头|网络.*卡|北京时间|美东时间|稍等一下|等一下|提前.*分钟|没法.*互动|照片|用筷子|不要怪|亲爱的|"
    r"三哥|小伙伴|示范案例|经典推荐|站在光里|恭喜"
)
INFORMATION_PATTERN = re.compile(
    r"主题|重点|核心|分析|依据|证据|现象|差异|机制|作用|条件|假设|方案|效率|"
    r"性能|模型|标准|系统|结构|流程|目标|价值|行情|股市|市场|指数|数据|原因|"
    r"结论|方法|步骤|问题|结果|建议|风险|变化|趋势|影响|案例|例如|意味着|"
    r"逻辑|判断|预测|策略|成本|高点|低点|尾盘|盘中|拉升|反弹|震荡|买入|卖出|进场|盈利|亏损|"
    r"增长|下降|上涨|下跌|大跌|低开|高开|探底|见顶|创新高|回落|拉升|拉上|反弹|加息|降息|交易|价格|收入|用户|"
    r"产品|技术|业务|实验|转化|库存|事务|隔离|并发|约束|测试|未来|过去|目前"
)
FILLER_PATTERN = re.compile(
    r"^(?:嗯+|啊+|哦+|哎+|哎呀|对|是|好|好的|行|没错|sorry|然后|所以|就是|"
    r"这个|那个|亲爱的|各位同学|各位朋友|大家好|对吧|懂的都懂)$",
    re.IGNORECASE,
)
NUMERIC_FRAGMENT_PATTERN = re.compile(
    r"^(?:\d+(?:\.\d+)?)(?:(?:到|至)(?:\d+(?:\.\d+)?))?(?:%|％|倍|点|个点)?(?:见顶)?$"
)
AMBIGUOUS_ACTION_PATTERN = re.compile(r"^(?:你)?(?:肯定)?(?:是)?加大力度(?:嘛)?$")
SUSPECT_ASR_PATTERN = re.compile(r"放链|中国大海|死点(?:发力)?")

LARGE_V3_REPOSITORY = "https://modelscope.cn/models/pengzhendong/faster-whisper-large-v3/resolve/master"
LARGE_V3_MODEL_SIZE = 3_087_284_237
LARGE_V3_MODEL_SHA256 = "69f74147e3334731bc3a76048724833325d2ec74642fb52620eda87352e3d4f1"
LARGE_V3_FILES = (
    "config.json",
    "preprocessor_config.json",
    "tokenizer.json",
    "vocabulary.json",
)


class JobRequest(BaseModel):
    url: str = Field(min_length=3, max_length=1200)
    summary_mode: Literal["local", "gpt"] = "local"
    model: Literal["base", "small", "medium", "large-v3"] | None = None


class SummaryRequest(BaseModel):
    title: str = "未命名视频"
    description: str = ""
    transcript: list[dict]


class SummaryPoint(BaseModel):
    title: str = Field(min_length=2)
    detail: str = Field(min_length=30)
    time: float = Field(ge=0)


class SummaryChapter(BaseModel):
    title: str = Field(min_length=2)
    summary: str = Field(min_length=30)
    time: float = Field(ge=0)


class SummaryQuote(BaseModel):
    text: str = Field(min_length=2)
    time: float = Field(ge=0)


class GeneratedSummary(BaseModel):
    headline: str = Field(min_length=4)
    overview: str = Field(min_length=30)
    keyPoints: list[SummaryPoint] = Field(min_length=1, max_length=12)
    chapters: list[SummaryChapter] = Field(min_length=1, max_length=12)
    quotes: list[SummaryQuote] = Field(min_length=1, max_length=12)
    keywords: list[str] = Field(min_length=1, max_length=12)
    disclaimer: str = Field(min_length=4)


class SummaryAudit(BaseModel):
    unsupported_additions: list[str]
    logical_errors: list[str]
    missing_information: list[str]
    time_or_quote_errors: list[str]


def set_job(job_id: str, **values) -> None:
    with jobs_lock:
        jobs[job_id].update(values)
        jobs[job_id]["updated_at"] = int(time.time())


def validate_url(raw_url: str) -> str:
    value = raw_url.strip()
    if re.fullmatch(r"BV[1-9A-HJ-NP-Za-km-z]{10}", value):
        return f"https://www.bilibili.com/video/{value}/"
    try:
        parsed = urlparse(value)
    except ValueError as exc:
        raise ValueError("链接格式不正确") from exc
    host = (parsed.hostname or "").lower()
    if host not in {"bilibili.com", "www.bilibili.com", "m.bilibili.com", "b23.tv", "www.b23.tv"}:
        raise ValueError("本地引擎仅接受 B 站视频链接")
    return value


def large_v3_directory() -> Path:
    cache_root = Path(os.environ.get("LOCALAPPDATA") or (Path.home() / ".cache"))
    return cache_root / "BiliVideoSummary" / "models" / "faster-whisper-large-v3"


def download_small_model_file(model_dir: Path, filename: str) -> None:
    target = model_dir / filename
    if target.exists() and target.stat().st_size > 0:
        return
    temporary = target.with_suffix(target.suffix + ".download")
    with requests.get(f"{LARGE_V3_REPOSITORY}/{filename}", stream=True, timeout=(20, 120)) as response:
        response.raise_for_status()
        with temporary.open("wb") as output:
            for chunk in response.iter_content(chunk_size=1024 * 1024):
                if chunk:
                    output.write(chunk)
    temporary.replace(target)


def download_large_v3_weights(model_dir: Path, on_progress: Callable[[float], None] | None = None) -> None:
    target = model_dir / "model.bin"
    if target.exists() and target.stat().st_size == LARGE_V3_MODEL_SIZE:
        return

    workers = 8
    chunk_size = (LARGE_V3_MODEL_SIZE + workers - 1) // workers
    progress_lock = threading.Lock()
    completed_bytes = 0

    def download_part(index: int) -> Path:
        nonlocal completed_bytes
        start = index * chunk_size
        end = min(LARGE_V3_MODEL_SIZE - 1, start + chunk_size - 1)
        expected = end - start + 1
        part = model_dir / f"model.bin.part{index:02d}"
        existing = part.stat().st_size if part.exists() else 0
        if existing > expected:
            part.unlink()
            existing = 0
        with progress_lock:
            completed_bytes += existing
        if existing == expected:
            return part

        headers = {"Range": f"bytes={start + existing}-{end}"}
        with requests.get(
            f"{LARGE_V3_REPOSITORY}/model.bin",
            headers=headers,
            stream=True,
            timeout=(30, 180),
        ) as response:
            if response.status_code != 206:
                raise RuntimeError(f"模型分片下载失败（HTTP {response.status_code}）")
            with part.open("ab") as output:
                for data in response.iter_content(chunk_size=1024 * 1024):
                    if not data:
                        continue
                    output.write(data)
                    with progress_lock:
                        completed_bytes += len(data)
                        if on_progress:
                            on_progress(min(1.0, completed_bytes / LARGE_V3_MODEL_SIZE))
        if part.stat().st_size != expected:
            raise RuntimeError("模型分片下载不完整，请重新启动后继续")
        return part

    with ThreadPoolExecutor(max_workers=workers) as pool:
        parts = list(pool.map(download_part, range(workers)))

    assembled = model_dir / "model.bin.assembling"
    digest = hashlib.sha256()
    with assembled.open("wb") as output:
        for part in parts:
            with part.open("rb") as source:
                while block := source.read(4 * 1024 * 1024):
                    output.write(block)
                    digest.update(block)
    if digest.hexdigest() != LARGE_V3_MODEL_SHA256:
        assembled.unlink(missing_ok=True)
        raise RuntimeError("模型校验失败，请重新启动后重试")
    assembled.replace(target)
    for part in parts:
        part.unlink(missing_ok=True)


def ensure_large_v3_model(on_progress: Callable[[float], None] | None = None) -> Path:
    model_dir = large_v3_directory()
    model_dir.mkdir(parents=True, exist_ok=True)
    for filename in LARGE_V3_FILES:
        download_small_model_file(model_dir, filename)
    download_large_v3_weights(model_dir, on_progress)
    return model_dir


def get_model(model_name: str, job_id: str | None = None) -> tuple[object, str]:
    from faster_whisper import WhisperModel

    with model_lock:
        if model_name not in models:
            # GPU enumeration can succeed even when the CUDA runtime DLLs are
            # missing. CPU/int8 works on every supported Windows installation;
            # users with a complete CUDA setup can opt in explicitly.
            device = os.environ.get("WHISPER_DEVICE", "cpu").strip().lower()
            if device not in {"cpu", "cuda"}:
                device = "cpu"
            compute_type = "float16" if device == "cuda" else "int8"
            model_source: str | Path = model_name
            if model_name == "large-v3":
                model_source = ensure_large_v3_model(
                    lambda value: set_job(job_id, progress=28 + int(value * 7)) if job_id else None,
                )
            try:
                models[model_name] = WhisperModel(str(model_source), device=device, compute_type=compute_type)
                model_devices[model_name] = device
                model_fallback_reasons.pop(model_name, None)
            except Exception as exc:
                if device != "cuda":
                    raise
                models[model_name] = WhisperModel(str(model_source), device="cpu", compute_type="int8")
                model_devices[model_name] = "cpu"
                model_fallback_reasons[model_name] = str(exc)
        return models[model_name], model_devices[model_name]


def unload_whisper_models() -> None:
    with model_lock:
        models.clear()
        model_devices.clear()
    gc.collect()


def unload_summary_model() -> None:
    try:
        OLLAMA_HTTP.post(
            f"{OLLAMA_URL}/api/generate",
            json={"model": SUMMARY_MODEL, "prompt": "", "stream": False, "keep_alive": 0},
            timeout=(3, 20),
        )
    except requests.RequestException:
        pass


def ollama_uses_gpu() -> bool:
    try:
        response = OLLAMA_HTTP.get(f"{OLLAMA_URL}/api/ps", timeout=(3, 10))
        response.raise_for_status()
        for model in response.json().get("models", []):
            if str(model.get("name", "")).startswith(SUMMARY_MODEL.split(":")[0]):
                return int(model.get("size_vram") or 0) > 0
    except (requests.RequestException, ValueError, TypeError):
        return False
    return False


def summary_system_prompt() -> str:
    return """你是一名专业的中文内容编辑，负责把视频语音转写整理成真正可读、可复用的内容总结。

先在内部判断视频的真实主题、内容类型和信息密度，不要预设财经、科技或其他领域。过滤依据是内容是否有信息价值，而不是视频是不是直播：只有明确不推进主题的点名、欢迎观众、感谢礼物、设备和声音调试、读弹幕、寒暄、广告套话、重复口头禅和无关闲聊才删除。口语化表达、铺垫、举例、重复解释或情绪表达只要承载了分析依据、推理过程、案例、事实或结论，就必须保留其有效信息。对于从头到尾持续输出信息的课程、访谈、演讲、分析或长视频，不得把正文误判成闲聊，也不能只抽少数亮点。

写作要求：
1. headline 是能够概括核心内容的结论式标题，不要照抄视频标题。
2. overview 是完整的叙述性总结。根据内容自然组织一段或数段，不使用时间轴式流水账；讲清主题、主要信息、论证关系、结论以及必要的限制。信息丰富时要充分覆盖全部主要论点，信息不足时不要注水。
3. keyPoints 的数量随内容密度自然变化，只保留真正有价值的洞察。每项 detail 都要具体解释“说了什么、依据是什么、意味着什么”，不能只有标题。
4. chapters 按主题、论证步骤或内容结构组织，不按固定时长机械切分。长篇高密度内容要覆盖开头、中段和结尾的主要分析，不能因篇幅长而遗漏后半部分；每段应能独立阅读。
5. quotes 只选信息密度高、能代表原意的片段；time 仅用于回到原片核对。
6. 忠于转写，不添加外部事实，也不使用常识扩写原文没有提到的例子、名词、字段、做法或结论。视频标题和简介只是帮助识别背景的元数据，不能当成正文已经论证过的事实。可以压缩和归纳；只有原文信息能够直接推出时才可说明其含义，不得把推测写成原话。不要用“如、例如、比如”自行补充示例；原文有示例时只保留原文的示例。
7. 所有数量、比例、分类和前后因果必须与转写一致，尤其检查“几类、几个步骤”等计数是否与实际列举相符，不得前后矛盾。
8. 严格区分“原文只提到”与“原文已经解释、证明或给出方法”；只出现名称但没有展开时，不得写成“详细解释了”。
9. 目录、开场预告或话题清单里只被列出、但正文没有展开的主题，不得写成视频已经分析或复盘过。主播自称、昵称和转写中的陌生专名保持原样，不得联想到国家、机构或外部人物。
10. 对语法破碎、孤立数字、疑似同音错字或上下文无法解释的片段，直接省略或明确写“转写不清，需回看原片”，不得自行补全含义，也不得把陌生词自动纠正成更常见的专业词。例如原文是无法确认的“放链”，不能自行改写成“放量”。
11. 涉及过程、走势、步骤或因果链时，必须保留原文的先后顺序和中间转折；不能把“下降—反弹—再回落”压缩成单向下降。逐句检查否定词和程度词：“没有大跌”不得写成“大跌”，“低开”不得升级成“低开低走”，“短暂拉升后回落”不得写成持续上涨或持续下跌。
12. keyPoints、chapters 和 quotes 的 time 必须取自最相关原文前的 [Xs] 标记，除非内容确实位于开头，否则不得统一填 0。quotes 必须是转写中连续出现的原话，不得改写、拼接或使用省略号。
13. 不得混淆陈述对象。日本、上证、美股或其他人物、产品、事件的表现必须分别对应其原文证据；不能把一个对象的尾盘表现、原因或结论移到另一个对象上。若原文对某对象只说“盘前上涨”，就不能扩写成其尾盘、全天或未来走势。
14. 不得从残缺的操作语句推导建议。原文没有说清“加大什么力度”时，不能补成加仓、防御或卖出；没有明确给出策略时，只能保留一般性的风险提醒。
15. 不要把客观描述升级成评价标签。除非原文明确使用，否则不要自行写“风险可控、稳健、韧性、积极信号、验证有效性、证明”等判断；直接写原文可核对的涨跌、时间、比较和先后过程。
16. 输出前在内部核对：正文中的每个主要论点、关键依据和最终结论是否都已覆盖；删除的是否确实只是低信息内容。
17. 直接输出符合 JSON Schema 的内容，不输出思考过程。"""


def transcript_chunks(transcript: list[dict], character_limit: int = 16_000) -> list[str]:
    chunks: list[str] = []
    current: list[str] = []
    length = 0
    for item in transcript:
        text = str(item.get("text") or "").strip()
        if not text:
            continue
        line = f"[{round(float(item.get('start') or 0))}s] {text}"
        if current and length + len(line) > character_limit:
            chunks.append("\n".join(current))
            current = []
            length = 0
        current.append(line)
        length += len(line) + 1
    if current:
        chunks.append("\n".join(current))
    return chunks


def filter_transcript_for_summary(transcript: list[dict]) -> list[dict]:
    """Remove only strongly signalled interaction while preserving the raw transcript."""
    if not transcript:
        return []
    annotated: list[tuple[dict, str, bool, bool, int]] = []
    windows: dict[int, list[tuple[bool, bool]]] = {}
    for item in transcript:
        text = re.sub(r"\s+", "", str(item.get("text") or ""))
        chatter = bool(CHATTER_PATTERN.search(text) or FILLER_PATTERN.fullmatch(text))
        informative = bool(INFORMATION_PATTERN.search(text))
        window = int(float(item.get("start") or 0) // 30)
        annotated.append((item, text, chatter, informative, window))
        windows.setdefault(window, []).append((chatter, informative))

    chatter_windows = {
        window
        for window, labels in windows.items()
        if sum(1 for chatter, _ in labels if chatter) >= 2
        or (
            sum(1 for chatter, _ in labels if chatter) >= 1
            and sum(1 for chatter, _ in labels if chatter) / max(1, len(labels)) >= 0.25
        )
    }
    initial_cutoff = -1.0
    if 0 in chatter_windows or 1 in chatter_windows:
        clean_streak = 0
        last_initial_chatter_window = -1
        for window in range(0, max(windows, default=0) + 1):
            if window in chatter_windows:
                clean_streak = 0
                last_initial_chatter_window = window
            elif last_initial_chatter_window >= 0:
                clean_streak += 1
                if clean_streak >= 2:
                    break
        if last_initial_chatter_window >= 0:
            chatter_times = [
                float(item.get("start") or 0)
                for item, _, chatter, _, window in annotated
                if chatter and window <= last_initial_chatter_window
            ]
            if chatter_times:
                initial_cutoff = max(chatter_times) + 3

    filtered: list[dict] = []
    for item, text, chatter, informative, window in annotated:
        if not text:
            continue
        if float(item.get("start") or 0) <= initial_cutoff:
            continue
        if chatter:
            continue
        if SUSPECT_ASR_PATTERN.search(text):
            continue
        if NUMERIC_FRAGMENT_PATTERN.fullmatch(text):
            continue
        if AMBIGUOUS_ACTION_PATTERN.fullmatch(text):
            continue
        if len(text) <= 4 and not informative:
            continue
        filtered.append(item)
    return filtered


def align_quotes_with_transcript(summary: GeneratedSummary, transcript: list[dict]) -> GeneratedSummary:
    source = [
        (str(item.get("text") or "").strip(), float(item.get("start") or 0))
        for item in transcript
        if str(item.get("text") or "").strip()
    ]
    aligned: list[SummaryQuote] = []
    for quote in summary.quotes:
        compact_quote = re.sub(r"\s+", "", quote.text)
        exact = next(
            ((text, start) for text, start in source if compact_quote in re.sub(r"\s+", "", text)),
            None,
        )
        if exact:
            aligned.append(SummaryQuote(text=quote.text, time=exact[1]))
            continue
        best = max(
            source,
            key=lambda item: SequenceMatcher(
                None,
                compact_quote,
                re.sub(r"\s+", "", item[0]),
            ).ratio(),
            default=None,
        )
        if best:
            aligned.append(SummaryQuote(text=best[0], time=best[1]))
    return summary.model_copy(update={"quotes": aligned or summary.quotes})


def resolve_obvious_contradictions(summary: GeneratedSummary) -> GeneratedSummary:
    """Fix only explicit self-contradictions without adding new source claims."""
    payload = json.dumps(summary.model_dump(), ensure_ascii=False)
    payload = re.sub(
        r"强度稍弱[（(]稍微强一点[）)]",
        "表现稍强",
        payload,
    )
    payload = re.sub(
        r"(一步一步下跌[^。]{0,40})也未在高位失守",
        r"\1最后未停留在高点",
        payload,
    )
    return GeneratedSummary.model_validate_json(payload)


def ollama_summary_request(prompt: str, keep_alive: str = "10m") -> GeneratedSummary:
    payload = {
        "model": SUMMARY_MODEL,
        "messages": [
            {"role": "system", "content": summary_system_prompt()},
            {"role": "user", "content": prompt},
        ],
        "stream": False,
        "think": False,
        "format": GeneratedSummary.model_json_schema(),
        "keep_alive": keep_alive,
        "options": {
            "temperature": 0,
            "num_ctx": 16384,
            "num_predict": 4096,
            "repeat_penalty": 1.08,
        },
    }
    response = OLLAMA_HTTP.post(f"{OLLAMA_URL}/api/chat", json=payload, timeout=(30, 1200))
    response.raise_for_status()
    content = str(response.json().get("message", {}).get("content") or "")
    if not content:
        raise RuntimeError("本地总结模型没有返回内容")
    return GeneratedSummary.model_validate_json(content)


def ollama_audit_request(prompt: str) -> SummaryAudit:
    payload = {
        "model": SUMMARY_MODEL,
        "messages": [
            {
                "role": "system",
                "content": "你是只负责查错的事实审校员。逐条对照原始内容与总结草稿，宁可报告可疑扩写，也不要替草稿辩解。不要重写总结；每类最多列 12 条，每条用一句短句说明，只输出符合 JSON Schema 的具体问题清单。",
            },
            {"role": "user", "content": prompt},
        ],
        "stream": False,
        "think": False,
        "format": SummaryAudit.model_json_schema(),
        "keep_alive": "10m",
        "options": {
            "temperature": 0,
            "num_ctx": 16384,
            "num_predict": 4096,
            "repeat_penalty": 1.05,
        },
    }
    response = OLLAMA_HTTP.post(f"{OLLAMA_URL}/api/chat", json=payload, timeout=(30, 1200))
    response.raise_for_status()
    content = str(response.json().get("message", {}).get("content") or "")
    if not content:
        raise RuntimeError("本地审校模型没有返回内容")
    return SummaryAudit.model_validate_json(content)


def summarize_with_ollama(
    title: str,
    description: str,
    transcript: list[dict],
    on_progress: Callable[[float], None] | None = None,
) -> tuple[dict, str]:
    summary_transcript = filter_transcript_for_summary(transcript)
    chunks = transcript_chunks(summary_transcript)
    if not chunks:
        raise RuntimeError("没有可用于总结的转写文本")
    partials: list[GeneratedSummary] = []
    total_steps = len(chunks) + (1 if len(chunks) > 1 else 0) + 2
    completed_steps = 0
    try:
        for index, chunk in enumerate(chunks):
            prompt = (
                f"这是第 {index + 1}/{len(chunks)} 段转写。视频标题和简介不作为事实来源，本次只依据下面的转写。按信息价值判断：只忽略明确无关的低信息口语，完整保留这部分的分析、推理、案例、事实、方法和结论。每个判断必须能在转写中找到对应主体和证据；转写里没有逐字出现的专业术语不得自行引入。\n\n{chunk}"
            )
            partials.append(ollama_summary_request(prompt))
            completed_steps += 1
            if on_progress:
                on_progress(completed_steps / total_steps)

        if len(partials) == 1:
            result = partials[0]
        else:
            merged_source = "\n\n".join(
                f"分段 {index + 1}：\n{json.dumps(summary.model_dump(), ensure_ascii=False)}"
                for index, summary in enumerate(partials)
            )
            result = ollama_summary_request(
                f"以下是长视频各段的初步提炼。请去重、合并上下文，形成一份完整且连贯的最终总结；不得加入这些分段提炼中没有依据的新事实。\n\n{merged_source}",
                keep_alive="2m",
            )
            completed_steps += 1
            if on_progress:
                on_progress(completed_steps / total_steps)

        if len(chunks) == 1:
            verification_source = chunks[0]
        else:
            verification_source = "\n\n".join(
                f"分段 {index + 1}：\n{json.dumps(summary.model_dump(), ensure_ascii=False)}"
                for index, summary in enumerate(partials)
            )
        draft = json.dumps(result.model_dump(), ensure_ascii=False)
        try:
            audit = ollama_audit_request(
                f"""请将“总结草稿”的每一项与“原始内容”逐条核对，列出所有具体问题。每类最多 12 条，每条只写一个问题并保持简洁。

重点检查：
- 原文没说却由常识补出的例子、适用场景、术语、结果、动机或建议。
- 原文只是提到，草稿却声称已经解释或证明的内容。
- 数量、比例、分类、因果链、前后结论之间的逻辑错误。
- 逐句核对陈述主体，检查是否把日本、上证、美股等不同对象的盘前、盘中或尾盘表现互相移植。
- 逐句核对否定词、程度词和走势顺序；特别查找把“没有大跌”写成“大跌”、把“低开—反弹—回落”写成单向走势的错误。
- 检查是否把标题、简介或开场预告当成正文已分析的内容；标题和简介不能单独支撑事实。
- 检查是否把疑似同音错字擅自纠正为专业术语，或从宾语缺失的残句推导出投资、操作或行动建议。
- 检查是否把客观涨跌描述升级成原文没有的“风险可控、稳健、韧性、积极信号、证明有效”等评价标签。
- 将草稿拆成最小事实单元，为每个单元寻找原始内容中的直接证据；找不到对应主体、动作、时间范围或程度的，一律列入 unsupported_additions，不得因为“听起来合理”而放过。
- 长内容中遗漏的主要分析，或把有用分析误删为口语。
- time 与 [Xs] 不对应，quotes 不是连续原话。

原始内容：
{verification_source}

总结草稿：
{draft}"""
            )
        except (requests.RequestException, ValueError) as exc:
            audit = SummaryAudit(
                unsupported_additions=[f"自动审校输出无法解析（{type(exc).__name__}），最终重写必须自行逐句重新核对原文。"],
                logical_errors=[],
                missing_information=[],
                time_or_quote_errors=[],
            )
        completed_steps += 1
        if on_progress:
            on_progress(completed_steps / total_steps)
        audit_text = json.dumps(audit.model_dump(), ensure_ascii=False)
        result = ollama_summary_request(
            f"""请对下面的总结草稿做最后一次事实与逻辑审校，并直接返回修正后的完整总结。

审校规则：
- 唯一事实来源是“原始内容”，删除草稿中来源没有出现的例子、术语、数字、做法或结论。使用原文已有概念做保守归纳，不要为了写得更丰富而扩写常识。
- 专门检查括号、“例如”、“如”、“比如”、“也就是”等位置：若其中的例子或解释没有逐项出现在原始内容，必须删除。最终文本不要自行添加示例；原文只说“明确字段”时，不能补充字段名称。
- 检查所有计数、分类、比例、因果链和结论是否自洽；不要为了修错而降低原有信息覆盖度。
- 只被原文点名但没有展开的概念只能写成“提到”，不能写成“解释、证明或分析了”。
- 检查目录或开场预告中的话题是否在正文真正展开；没有展开的不能写成已分析。检查昵称和陌生专名是否被擅自解释为国家、机构或外部人物。
- 检查语法破碎的转写、孤立数字和疑似同音错字是否被草稿擅自补全；无法由上下文确认时必须删除或标记不清。
- 检查走势、步骤和因果过程是否保留了原文的先后顺序与中间转折，不能把有反弹或反转的过程写成单向变化。
- 逐句核对陈述主体、时间范围、否定词和程度词。不同对象的盘前、盘中、尾盘表现不得互相移植；“没有大跌”不得变成“大跌”，“低开”不得扩写成“低开低走”。
- 视频标题、简介和开场预告都不是正文证据；没有在原始内容中实际展开的标题结论必须删除。
- 疑似同音错字只能按原文保留并标注转写不清，或直接省略，绝不能自动纠正成专业术语。从“加大力度”等缺失宾语的残句不得推导出加仓、防御、卖出或其他行动建议。
- 全文搜索转写中没有逐字出现的专业术语；若它改变了事实含义或提供了新的市场解释，必须删除。不能一边在免责声明里说某词转写不清，一边又在正文里按猜测后的词继续分析。
- 最终 headline 只能概括正文有直接证据的结论，不得借用视频标题里“中美大考”等正文未展开的判断。
- 删除原文没有明确使用的评价标签，如“风险可控、稳健、韧性、积极信号、证明有效”；改回可以从转写逐句核对的客观描述。
- keyPoints 的每个 detail 和 chapters 的每个 summary 都必须用完整内容说明，不能留空，也不能只写标题换一种说法。
- 高密度长内容必须保留全部主要分析；低信息互动才删除。
- 每个 time 必须对应最相关的 [Xs] 原文位置，不能无理由全部填 0。
- quotes 必须逐字取自原始转写中的连续原话，不得改写、拼接或使用省略号。

原始内容：
{verification_source}

待审校草稿：
{draft}

独立审校发现的问题（必须逐项处理）：
{audit_text}""",
            keep_alive="2m",
        )
        completed_steps += 1
        if on_progress:
            on_progress(completed_steps / total_steps)

        result = align_quotes_with_transcript(result, summary_transcript)
        result = resolve_obvious_contradictions(result)

        accelerated_by = "gpu" if ollama_uses_gpu() else "cpu"
        summary = result.model_dump()
        summary["mode"] = "local"
        return summary, accelerated_by
    finally:
        unload_summary_model()


def download_audio(url: str, directory: Path) -> tuple[Path, dict]:
    from yt_dlp import YoutubeDL

    template = str(directory / "%(id)s-%(section_number|0)s.%(ext)s")
    options = {
        "format": "bestaudio/best",
        "outtmpl": template,
        "noplaylist": True,
        "quiet": True,
        "no_warnings": True,
        "retries": 5,
        "fragment_retries": 5,
        "http_headers": {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
            "Referer": "https://www.bilibili.com/",
        },
    }
    with YoutubeDL(options) as downloader:
        info = downloader.extract_info(url, download=True)
        requested = info.get("requested_downloads") or []
        candidates = [item.get("filepath") for item in requested if item.get("filepath")]
        if not candidates:
            candidates = [downloader.prepare_filename(info)]
    file_path = next((Path(item) for item in candidates if Path(item).exists()), None)
    if file_path is None:
        files = [item for item in directory.iterdir() if item.is_file()]
        file_path = max(files, key=lambda item: item.stat().st_size) if files else None
    if file_path is None:
        raise RuntimeError("音频下载完成，但没有找到媒体文件")
    return file_path, info


def run_job(job_id: str, request: JobRequest) -> None:
    with pipeline_lock:
        process_job(job_id, request)


def process_job(job_id: str, request: JobRequest) -> None:
    work_dir = Path(tempfile.mkdtemp(prefix="bili-summary-"))
    try:
        url = validate_url(request.url)
        set_job(job_id, status="working", stage="download", progress=8)
        audio_path, info = download_audio(url, work_dir)
        duration = float(info.get("duration") or 0)
        set_job(job_id, stage="model", progress=28)

        unload_summary_model()
        model_name = request.model or os.environ.get("WHISPER_MODEL", "large-v3")
        model, active_device = get_model(model_name, job_id)
        set_job(job_id, stage="transcribe", progress=36, device=active_device)
        segment_stream, detected = model.transcribe(
            str(audio_path),
            language="zh",
            vad_filter=True,
            vad_parameters={"min_silence_duration_ms": 450},
            beam_size=5,
            condition_on_previous_text=True,
            word_timestamps=False,
        )

        transcript = []
        for segment in segment_stream:
            text = segment.text.strip()
            if text:
                transcript.append({
                    "start": round(float(segment.start), 2),
                    "end": round(float(segment.end), 2),
                    "text": text,
                })
            if duration:
                percent = 36 + min(46, int((float(segment.end) / duration) * 46))
                set_job(job_id, progress=percent)

        if not transcript:
            raise RuntimeError("没有识别到清晰语音，请确认视频包含可听见的人声")
        detected_language = getattr(detected, "language", "zh")
        language_probability = round(float(getattr(detected, "language_probability", 0)), 4)
        webpage_url = str(info.get("webpage_url") or url)
        raw_video_id = str(info.get("id") or "")
        bvid_match = re.search(r"BV[1-9A-HJ-NP-Za-km-z]{10}", f"{webpage_url} {raw_video_id}")
        video_id = bvid_match.group(0) if bvid_match else raw_video_id
        video = {
            "bvid": video_id,
            "title": str(info.get("title") or video_id or "B站视频"),
            "description": str(info.get("description") or ""),
            "cover": str(info.get("thumbnail") or ""),
            "owner": str(info.get("uploader") or info.get("channel") or ""),
            "duration": round(duration),
            "part": str(info.get("title") or ""),
            "partNumber": int(info.get("playlist_index") or 1),
            "parts": int(info.get("n_entries") or 1),
            "url": webpage_url,
        }

        summary = None
        summary_error = ""
        summary_device = ""
        if request.summary_mode == "local":
            set_job(job_id, stage="summarize", progress=86)
            del segment_stream
            del model
            unload_whisper_models()
            try:
                summary, summary_device = summarize_with_ollama(
                    video["title"],
                    video["description"],
                    transcript,
                    lambda value: set_job(job_id, progress=86 + int(value * 12)),
                )
            except Exception as exc:
                summary_error = str(exc)

        set_job(
            job_id,
            status="complete",
            stage="complete",
            progress=100,
            transcript=transcript,
            video=video,
            summary=summary,
            summary_model=SUMMARY_MODEL if summary else "",
            summary_device=summary_device,
            summary_error=summary_error,
            language=detected_language,
            language_probability=language_probability,
            model=model_name,
            device=active_device,
        )
    except Exception as exc:
        set_job(job_id, status="failed", stage="failed", error=str(exc), progress=0)
    finally:
        shutil.rmtree(work_dir, ignore_errors=True)


@app.get("/")
def root():
    return {
        "name": "B站视频总结本地引擎",
        "status": "ready",
        "message": "请保持本窗口运行，然后在网页中粘贴 B 站视频链接。",
    }


@app.get("/api/health")
def health():
    model_name = os.environ.get("WHISPER_MODEL", "large-v3")
    configured_device = os.environ.get("WHISPER_DEVICE", "cpu").strip().lower()
    active_device = model_devices.get(model_name)
    return {
        "status": "ready",
        "model": model_name,
        "device": active_device or configured_device,
        "configured_device": configured_device,
        "model_loaded": active_device is not None,
        "fallback_reason": model_fallback_reasons.get(model_name, ""),
        "summary_engine": "ollama",
        "summary_model": SUMMARY_MODEL,
    }


@app.post("/api/summarize")
def summarize_transcript(request: SummaryRequest):
    if not request.transcript:
        raise HTTPException(status_code=400, detail="没有可用于总结的转写文本")
    try:
        with pipeline_lock:
            unload_whisper_models()
            summary, summary_device = summarize_with_ollama(
                request.title[:300],
                request.description[:4000],
                request.transcript[:12000],
            )
        return {
            "ok": True,
            "summary": summary,
            "summary_model": SUMMARY_MODEL,
            "summary_device": summary_device,
        }
    except Exception as exc:
        raise HTTPException(status_code=503, detail=f"本地总结模型不可用：{exc}") from exc


@app.post("/api/jobs", status_code=202)
def create_job(request: JobRequest, background_tasks: BackgroundTasks):
    try:
        validate_url(request.url)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    job_id = uuid.uuid4().hex
    with jobs_lock:
        jobs[job_id] = {
            "id": job_id,
            "status": "queued",
            "stage": "queued",
            "progress": 2,
            "created_at": int(time.time()),
            "updated_at": int(time.time()),
        }
    background_tasks.add_task(run_job, job_id, request)
    return {"id": job_id, "status": "queued"}


@app.get("/api/jobs/{job_id}")
def get_job(job_id: str):
    with jobs_lock:
        job = jobs.get(job_id)
        if not job:
            raise HTTPException(status_code=404, detail="任务不存在或已过期")
        return dict(job)
