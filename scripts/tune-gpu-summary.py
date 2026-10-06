"""Download a pinned quantization and measure real GPU use and summary output."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import subprocess
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import requests

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
MODEL_NAME = "bili-summary:35b-iq2xxs"
REPOSITORY = "bartowski/Qwen_Qwen3.6-35B-A3B-GGUF"
REVISION = "5c2410d71524f4f72b023ce8daf7a80528226d5f"
FILENAME = "Qwen_Qwen3.6-35B-A3B-IQ2_XXS.gguf"
FILE_SIZE = 10_676_139_648
FILE_SHA256 = "aa4a46af613699d81841505974c91c877139c713e9e1f25b7708471e0542e85b"
Q8_SHA256 = "73b25b6053372913a20bde4fd1c81db57fb573b2b8fc063ffdcf25c5ef1f1d68"
OLLAMA_URL = "http://127.0.0.1:11434"


def file_hash(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(8 * 1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def parallel_download(directory: Path, target: Path, source_name: str) -> None:
    chunk_size = 128 * 1024 * 1024
    cache = directory / (FILENAME + ".ranges")
    cache.mkdir(exist_ok=True)
    chunk_count = (FILE_SIZE + chunk_size - 1) // chunk_size
    files = [cache / f"{index:04d}.part" for index in range(chunk_count)]
    lengths = [min(chunk_size, FILE_SIZE - index * chunk_size) for index in range(chunk_count)]
    old_partial = directory / (FILENAME + ".part")
    if old_partial.exists() and not any(path.exists() for path in files):
        with old_partial.open("rb") as source:
            for path, length in zip(files, lengths):
                data = source.read(length)
                if not data:
                    break
                path.write_bytes(data)
    completed = [path.stat().st_size if path.exists() else 0 for path in files]
    if any(have > expected for have, expected in zip(completed, lengths)):
        raise RuntimeError("Existing range cache exceeds pinned lengths")
    guard = threading.Lock()
    last_print = [0.0]
    started = time.monotonic()
    if source_name == "modelscope":
        metadata_session = requests.Session()
        metadata_session.trust_env = False
        response = metadata_session.get(f"https://modelscope.cn/api/v1/models/{REPOSITORY}/repo/files", params={"Revision": "master", "Recursive": "true"}, timeout=(10, 30))
        response.raise_for_status()
        entry = next(item for item in response.json()["Data"]["Files"] if item.get("Name") == FILENAME)
        if entry.get("Sha256") != FILE_SHA256 or entry.get("Size") != FILE_SIZE:
            raise RuntimeError("ModelScope mirror does not match the pinned upstream artifact")
        print("ModelScope metadata matches the pinned upstream SHA256", flush=True)

    def fetch(index: int) -> None:
        path, length = files[index], lengths[index]
        for attempt in range(4):
            offset = path.stat().st_size if path.exists() else 0
            if offset == length:
                return
            first = index * chunk_size + offset
            final = index * chunk_size + length - 1
            url = (f"https://modelscope.cn/models/{REPOSITORY}/resolve/master/{FILENAME}" if source_name == "modelscope" else f"https://huggingface.co/{REPOSITORY}/resolve/{REVISION}/{FILENAME}")
            try:
                session = requests.Session()
                session.trust_env = source_name != "modelscope"
                with session.get(url, params={"download": "true", "cache": str(time.time_ns())}, headers={"Range": f"bytes={first}-{final}"}, stream=True, timeout=(20, 45)) as response:
                    response.raise_for_status()
                    if response.status_code != 206 or not response.headers.get("Content-Range", "").startswith(f"bytes {first}-{final}/"):
                        raise RuntimeError("Server did not honor the exact requested byte range")
                    with path.open("ab") as handle:
                        for data in response.iter_content(1024 * 1024):
                            if offset + len(data) > length:
                                raise RuntimeError("Range response exceeded its pinned length")
                            handle.write(data)
                            offset += len(data)
                            with guard:
                                completed[index] = offset
                                now = time.monotonic()
                                if now - last_print[0] >= 20:
                                    total = sum(completed)
                                    print(f"Parallel download {total * 100 / FILE_SIZE:.1f}% ({total / 1e9:.2f}/{FILE_SIZE / 1e9:.2f} GB), elapsed {now - started:.0f}s", flush=True)
                                    last_print[0] = now
                if offset != length:
                    raise requests.RequestException("Incomplete byte range")
                return
            except requests.RequestException:
                if attempt == 3:
                    raise RuntimeError(f"Download range {index} failed; resumable cache retained") from None

    print(f"Starting 24 concurrent HTTPS ranges from {source_name}; {sum(completed) / 1e9:.2f} GB already cached", flush=True)
    with ThreadPoolExecutor(max_workers=24) as executor:
        list(executor.map(fetch, range(chunk_count)))
    assembled = directory / (FILENAME + ".assembled")
    with assembled.open("wb") as output:
        for path in files:
            with path.open("rb") as source:
                for data in iter(lambda: source.read(8 * 1024 * 1024), b""):
                    output.write(data)
    if assembled.stat().st_size != FILE_SIZE or file_hash(assembled) != FILE_SHA256:
        raise RuntimeError("Parallel download failed pinned size or SHA256 verification")
    assembled.rename(target)


def install_35b(method: str, source_name: str) -> None:
    directory = ROOT / "work" / "models"
    directory.mkdir(parents=True, exist_ok=True)
    target = directory / FILENAME
    partial = directory / (FILENAME + ".part")
    if target.exists():
        if target.stat().st_size != FILE_SIZE or file_hash(target) != FILE_SHA256:
            raise RuntimeError("Existing model file failed verification; it was left untouched")
    else:
        if method == "ranges":
            parallel_download(directory, target, source_name)
            import_model()
            return
        os.environ["HF_HUB_DISABLE_XET"] = "0"
        os.environ["HF_XET_HIGH_PERFORMANCE"] = "1"
        os.environ["HF_XET_NUM_CONCURRENT_RANGE_GETS"] = "16"
        try:
            from huggingface_hub import hf_hub_download

            print("Using concurrent Hugging Face Xet download", flush=True)
            hf_hub_download(REPOSITORY, FILENAME, revision=REVISION, local_dir=directory)
            if target.stat().st_size != FILE_SIZE or file_hash(target) != FILE_SHA256:
                raise RuntimeError("Xet download failed pinned size or SHA256 verification")
            print("Concurrent download verified", flush=True)
        except Exception as exc:
            if target.exists():
                raise
            print(f"Concurrent download unavailable ({type(exc).__name__}); using resumable HTTPS", flush=True)
        if target.exists():
            import_model()
            return
        url = f"https://huggingface.co/{REPOSITORY}/resolve/{REVISION}/{FILENAME}"
        started = time.monotonic()
        last_print = 0.0
        last_percentage = -5
        for attempt in range(1, 5):
            offset = partial.stat().st_size if partial.exists() else 0
            if offset == FILE_SIZE:
                break
            headers = {"Range": f"bytes={offset}-"} if offset else {}
            try:
                # A unique query avoids stale, expired CDN signed redirects.
                with requests.get(
                    url, params={"download": "true", "cache": str(time.time_ns())},
                    headers=headers, stream=True, timeout=(20, 30),
                ) as response:
                    response.raise_for_status()
                    if offset and response.status_code != 206:
                        raise RuntimeError("Server did not honor resume; partial file was left untouched")
                    if offset and not response.headers.get("Content-Range", "").startswith(f"bytes {offset}-"):
                        raise RuntimeError("Unexpected resumed byte range")
                    with partial.open("ab" if offset else "wb") as handle:
                        for block in response.iter_content(4 * 1024 * 1024):
                            if not block:
                                continue
                            handle.write(block)
                            offset += len(block)
                            if offset > FILE_SIZE:
                                raise RuntimeError("Download exceeded the pinned file size")
                            now = time.monotonic()
                            percentage = int(offset * 100 / FILE_SIZE)
                            if now - last_print >= 30 or percentage >= last_percentage + 5:
                                print(f"Download {percentage}% ({offset / 1e9:.2f}/{FILE_SIZE / 1e9:.2f} GB), elapsed {now - started:.0f}s", flush=True)
                                last_print = now
                                last_percentage = percentage
                if partial.stat().st_size == FILE_SIZE:
                    break
                raise requests.RequestException("Incomplete download")
            except requests.RequestException as exc:
                print(f"Download attempt {attempt} failed: {type(exc).__name__}; retained resumable partial", flush=True)
                if attempt == 4:
                    raise RuntimeError("Model download failed after four attempts") from None
        if partial.stat().st_size != FILE_SIZE or file_hash(partial) != FILE_SHA256:
            raise RuntimeError("Downloaded model failed size or SHA256 verification")
        partial.rename(target)
    import_model()


def import_model() -> None:
    print("Pinned size and SHA256 verified; importing into Ollama", flush=True)
    subprocess.run(
        ["ollama", "create", MODEL_NAME, "-f", str(ROOT / "engine/models/qwen3.6-35b-iq2xxs.Modelfile")],
        check=True,
    )
    print(f"Installed {MODEL_NAME}", flush=True)


def pull_model(model: str) -> None:
    session = local_session()
    last_print = 0.0
    last_status = ""
    with session.post(OLLAMA_URL + "/api/pull", json={"model": model, "stream": True}, stream=True, timeout=(10, 180)) as response:
        response.raise_for_status()
        for line in response.iter_lines():
            if not line:
                continue
            item = json.loads(line)
            if item.get("error"):
                raise RuntimeError(item["error"])
            status = item.get("status", "")
            now = time.monotonic()
            if status != last_status or now - last_print >= 30:
                total = item.get("total") or 0
                completed = item.get("completed") or 0
                print(f"{model}: {status}" + (f" {completed * 100 / total:.1f}% ({completed / 1e9:.2f}/{total / 1e9:.2f} GB)" if total else ""), flush=True)
                last_print, last_status = now, status


def finish_q8_pull() -> None:
    """Complete this task's paused public blob download, then verify its digest."""
    blob_root = Path(os.environ.get("OLLAMA_MODELS", str(Path.home() / ".ollama/models"))) / "blobs"
    partial = blob_root / f"sha256-{Q8_SHA256}-partial"
    target = blob_root / f"sha256-{Q8_SHA256}"
    if target.exists():
        pull_model("qwen3.5:9b-q8_0")
        return
    if not partial.is_file() or partial.stat().st_size != 10_699_916_384:
        raise RuntimeError("Expected paused Q8 partial file was not found")
    ranges = []
    for path in blob_root.glob(f"sha256-{Q8_SHA256}-partial-*"):
        metadata = json.loads(path.read_text(encoding="utf-8"))
        first = metadata["Offset"] + metadata["Completed"]
        final = metadata["Offset"] + metadata["Size"]
        for offset in range(first, final, 4 * 1024 * 1024):
            ranges.append((offset, min(final, offset + 4 * 1024 * 1024) - 1))
    print(f"Completing {len(ranges)} small ranges of the paused Q8 download", flush=True)

    def fetch(bounds: tuple[int, int]) -> None:
        first, final = bounds
        for attempt in range(4):
            try:
                url = f"https://registry.ollama.ai/v2/library/qwen3.5/blobs/sha256:{Q8_SHA256}"
                with requests.get(url, params={"cache": str(time.time_ns())}, headers={"Range": f"bytes={first}-{final}"}, stream=True, timeout=(15, 45)) as response:
                    response.raise_for_status()
                    if response.status_code != 206 or not response.headers.get("Content-Range", "").startswith(f"bytes {first}-{final}/"):
                        raise RuntimeError("Blob server did not honor the exact requested range")
                    data = b"".join(response.iter_content(1024 * 1024))
                    if len(data) != final - first + 1:
                        raise requests.RequestException("Incomplete blob range")
                with partial.open("r+b") as handle:
                    handle.seek(first)
                    handle.write(data)
                return
            except requests.RequestException:
                if attempt == 3:
                    raise RuntimeError("Q8 tail recovery failed; partial file retained") from None
    with ThreadPoolExecutor(max_workers=12) as executor:
        list(executor.map(fetch, ranges))
    if file_hash(partial) != Q8_SHA256:
        raise RuntimeError("Recovered Q8 blob failed SHA256 verification; partial file retained")
    partial.rename(target)
    print("Complete Q8 blob passed SHA256; finishing official model manifest", flush=True)
    pull_model("qwen3.5:9b-q8_0")


def local_session() -> requests.Session:
    session = requests.Session()
    session.trust_env = False
    return session


def request_json(session: requests.Session, path: str, payload: dict) -> dict:
    response = session.post(OLLAMA_URL + path, json=payload, timeout=(10, 900))
    response.raise_for_status()
    return response.json()


def loaded_state(session: requests.Session, model: str) -> dict:
    response = session.get(OLLAMA_URL + "/api/ps", timeout=10)
    response.raise_for_status()
    loaded = next((item for item in response.json().get("models", []) if item.get("name") == model), {})
    gpu_size = int(loaded.get("size_vram") or 0)
    total_size = int(loaded.get("size") or 0)
    gpu = subprocess.run(
        ["nvidia-smi", "--query-gpu=memory.total,memory.used", "--format=csv,noheader,nounits"],
        capture_output=True, text=True, check=True,
    ).stdout.strip()
    return {"size_bytes": total_size, "gpu_bytes": gpu_size, "full_gpu": bool(total_size and gpu_size >= total_size * .99), "gpu_memory_mib": gpu, "context": loaded.get("context_length")}


def probe_contexts(model: str, contexts: list[int], output: Path) -> None:
    session = local_session()
    records = []
    for context in contexts:
        result = request_json(session, "/api/chat", {"model": model, "messages": [{"role": "user", "content": "Reply with OK."}], "think": False, "stream": False, "keep_alive": "1m", "options": {"num_ctx": context, "num_batch": 128, "num_predict": 8}})
        record = {"model": model, "context": context, "reply": result.get("message", {}).get("content"), **loaded_state(session, model)}
        records.append(record)
        output.parent.mkdir(parents=True, exist_ok=True)
        output.write_text(json.dumps(records, indent=2), encoding="utf-8")
        print(json.dumps(record), flush=True)
        request_json(session, "/api/generate", {"model": model, "keep_alive": 0})


def benchmark(models: list[str], contexts: list[int], output: Path, pipeline: bool, case_ids: list[str] | None) -> None:
    from engine import server
    from engine.server import GeneratedSummary, summary_system_prompt

    with (ROOT / "engine/evaluation/gpu-summary-cases.json").open(encoding="utf-8") as handle:
        cases = json.load(handle)
    if case_ids:
        cases = [case for case in cases if case["id"] in case_ids]
        if not cases:
            raise ValueError("No matching evaluation case IDs")
    session = local_session()
    records: list[dict] = []
    output.parent.mkdir(parents=True, exist_ok=True)
    for model in models:
        # These are local diagnostic runs; do not evict other users' models.
        current = session.get(OLLAMA_URL + "/api/ps", timeout=10).json().get("models", [])
        if any(item.get("name") != model for item in current):
            raise RuntimeError("Another model is loaded; wait for the service to be idle before benchmarking")
        context = contexts[0]
        for context in contexts:
            smoke = request_json(session, "/api/chat", {
                "model": model, "messages": [{"role": "user", "content": "Reply with OK."}],
                "think": False, "stream": False, "keep_alive": "5m",
                "options": {"num_ctx": context, "num_batch": 128, "num_predict": 8},
            })
            state = loaded_state(session, model)
            print(json.dumps({"model": model, "context": context, "reply": smoke.get("message", {}).get("content"), **state}, ensure_ascii=False), flush=True)
            if state["full_gpu"]:
                break
            request_json(session, "/api/generate", {"model": model, "keep_alive": 0})
        for case in cases:
            transcript = case["transcript"]
            if case.get("repeat_background"):
                background = "\n".join(f"[{40 + i * 12}s] 第{i + 1}个样本：实验使用相同输入和硬件，先测量单请求响应，再观察并发排队；记录结果用于比较，不能把相关性当成因果。" for i in range(case["repeat_background"]))
                transcript = transcript.replace("{{BACKGROUND}}", background)
            started = time.monotonic()
            chat_payload = {
                "model": model,
                "messages": [{"role": "system", "content": summary_system_prompt()}, {"role": "user", "content": f"请完整总结以下转写，保留正文分析、因果、条件和关键数字，去掉无关互动。\n标题：{case['title']}\n{transcript}"}],
                "format": GeneratedSummary.model_json_schema(), "think": False, "stream": False, "keep_alive": "5m",
                "options": {"num_ctx": context, "num_batch": 128, "num_predict": 4096, "temperature": 0, "repeat_penalty": 1.08, "presence_penalty": 0},
            }
            snapshots: list[dict] = []
            calls: list[dict] = []
            if pipeline:
                server.SUMMARY_MODEL = model
                server.SUMMARY_NUM_CTX = context
                server.SUMMARY_CHUNK_CHARACTERS = min(16000, max(1000, context - 5000)) if context < 16384 else 16000
                def collect_response(response, *args, **kwargs):
                    if response.url.endswith("/api/chat") and response.ok:
                        calls.append(response.json())
                server.OLLAMA_HTTP.hooks["response"] = [collect_response]
                entries = []
                for line in transcript.splitlines():
                    match = re.match(r"\[(\d+)s\]\s*(.*)", line)
                    if match:
                        entries.append({"start": float(match.group(1)), "text": match.group(2)})
                summary, device = server.summarize_with_ollama(case["title"], "", entries, lambda _: snapshots.append(loaded_state(session, model)))
                content = json.dumps(summary, ensure_ascii=False)
                result = {"eval_count": sum(call.get("eval_count", 0) for call in calls), "prompt_eval_count": sum(call.get("prompt_eval_count", 0) for call in calls), "eval_duration": sum(call.get("eval_duration", 0) for call in calls), "done_reason": ",".join(str(call.get("done_reason", "")) for call in calls)}
            else:
                result = request_json(session, "/api/chat", chat_payload)
                content = result.get("message", {}).get("content", "")
                snapshots.append(loaded_state(session, model))
            error = ""
            try:
                summary = GeneratedSummary.model_validate_json(content).model_dump()
            except Exception as exc:
                summary = None
                error = str(exc)
            searchable = json.dumps(summary, ensure_ascii=False) if summary else content
            missing_anchors = [alternatives for alternatives in case.get("anchors", []) if not any(re.search(pattern, searchable) for pattern in alternatives)]
            unexpected = [phrase for phrase in case.get("forbidden", []) if phrase in searchable]
            record = {
                "model": model, "case": case["id"], "context": context, "elapsed_seconds": round(time.monotonic() - started, 1),
                "output_tokens": result.get("eval_count"), "prompt_tokens": result.get("prompt_eval_count"),
                "tokens_per_second": round(result.get("eval_count", 0) * 1e9 / max(result.get("eval_duration", 1), 1), 2),
                "done_reason": result.get("done_reason"), "gpu": snapshots[-1] if snapshots else {}, "pipeline": pipeline,
                "schema_error": error, "missing_anchors": missing_anchors, "forbidden_matches": unexpected,
                "expectations_for_manual_review": case["expectations"], "summary": summary, "raw": content if summary is None else "",
            }
            records.append(record)
            output.write_text(json.dumps(records, ensure_ascii=False, indent=2), encoding="utf-8")
            print(json.dumps({key: record[key] for key in ("model", "case", "elapsed_seconds", "tokens_per_second", "done_reason", "schema_error", "missing_anchors", "forbidden_matches")}, ensure_ascii=False), flush=True)
        request_json(session, "/api/generate", {"model": model, "keep_alive": 0})
    print(f"Saved measured output for manual review: {output}", flush=True)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=("install-35b", "pull", "finish-q8-pull", "probe", "benchmark"))
    parser.add_argument("--models", nargs="+", default=["qwen3.5:9b-q8_0"])
    parser.add_argument("--contexts", nargs="+", type=int, default=[16384, 8192])
    parser.add_argument("--download-method", choices=("xet", "ranges"), default="ranges")
    parser.add_argument("--download-source", choices=("modelscope", "huggingface"), default="modelscope")
    parser.add_argument("--output", type=Path, default=ROOT / "outputs/gpu-summary-benchmark.json")
    parser.add_argument("--pipeline", action="store_true", help="Use the application's draft, audit and rewrite flow")
    parser.add_argument("--case-ids", nargs="+")
    args = parser.parse_args()
    if args.action == "install-35b":
        install_35b(args.download_method, args.download_source)
    elif args.action == "finish-q8-pull":
        finish_q8_pull()
    elif args.action == "pull":
        for model in args.models:
            pull_model(model)
    elif args.action == "probe":
        probe_contexts(args.models[0], args.contexts, args.output)
    else:
        benchmark(args.models, args.contexts, args.output, args.pipeline, args.case_ids)


if __name__ == "__main__":
    main()
