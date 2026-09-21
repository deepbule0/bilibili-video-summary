from __future__ import annotations

import os
import re
import shutil
import tempfile
import threading
import time
import uuid
from pathlib import Path
from typing import Literal
from urllib.parse import urlparse

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
model_lock = threading.Lock()


class JobRequest(BaseModel):
    url: str = Field(min_length=3, max_length=1200)
    summary_mode: Literal["local", "gpt"] = "local"
    model: Literal["base", "small", "medium"] | None = None


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


def get_model(model_name: str):
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
            try:
                models[model_name] = WhisperModel(model_name, device=device, compute_type=compute_type)
            except Exception:
                if device != "cuda":
                    raise
                models[model_name] = WhisperModel(model_name, device="cpu", compute_type="int8")
        return models[model_name]


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

        model_name = request.model or os.environ.get("WHISPER_MODEL", "base")
        model = get_model(model_name)
        set_job(job_id, stage="transcribe", progress=36)
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
        set_job(
            job_id,
            status="complete",
            stage="complete",
            progress=88,
            transcript=transcript,
            language=getattr(detected, "language", "zh"),
            language_probability=round(float(getattr(detected, "language_probability", 0)), 4),
            model=model_name,
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
    return {
        "status": "ready",
        "model": os.environ.get("WHISPER_MODEL", "base"),
        "device": os.environ.get("WHISPER_DEVICE", "cpu"),
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
