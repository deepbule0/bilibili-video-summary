from __future__ import annotations

import os
import re
import hashlib
import shutil
import tempfile
import threading
import time
import uuid
from concurrent.futures import ThreadPoolExecutor
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
    work_dir = Path(tempfile.mkdtemp(prefix="bili-summary-"))
    try:
        url = validate_url(request.url)
        set_job(job_id, status="working", stage="download", progress=8)
        audio_path, info = download_audio(url, work_dir)
        duration = float(info.get("duration") or 0)
        set_job(job_id, stage="model", progress=28)

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
        set_job(
            job_id,
            status="complete",
            stage="complete",
            progress=88,
            transcript=transcript,
            video=video,
            language=getattr(detected, "language", "zh"),
            language_probability=round(float(getattr(detected, "language_probability", 0)), 4),
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
    }


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
