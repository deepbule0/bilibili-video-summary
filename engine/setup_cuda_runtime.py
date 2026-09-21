from __future__ import annotations

import argparse
import os
import shutil
import subprocess
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import requests


ARCHIVE_URL = (
    "https://github.com/Purfview/whisper-standalone-win/releases/download/libs/"
    "cuBLAS.and.cuDNN_CUDA12_win_v3.7z"
)
ARCHIVE_SIZE = 849_141_159
WORKERS = 8


def runtime_directories(runtime_root: Path) -> list[Path]:
    cublas = next(runtime_root.rglob("cublas64_12.dll"), None) if runtime_root.exists() else None
    cudnn = next(runtime_root.rglob("cudnn64_9.dll"), None) if runtime_root.exists() else None
    if not cublas or not cudnn:
        return []
    return sorted({item.parent for item in runtime_root.rglob("*.dll")})


def download_archive(storage_root: Path) -> Path:
    archive = storage_root / "cuBLAS.and.cuDNN_CUDA12_win_v3.7z"
    part_size = (ARCHIVE_SIZE + WORKERS - 1) // WORKERS
    parts = [storage_root / f"cuda-runtime.part{index:02d}" for index in range(WORKERS)]

    if archive.exists() and archive.stat().st_size == ARCHIVE_SIZE:
        return archive
    if archive.exists() and archive.stat().st_size > ARCHIVE_SIZE:
        archive.unlink()

    # Reuse bytes written by the older single-stream downloader as the first part.
    if archive.exists() and archive.stat().st_size < ARCHIVE_SIZE and not parts[0].exists():
        if archive.stat().st_size <= part_size:
            archive.replace(parts[0])

    completed = 0
    completed_lock = threading.Lock()
    last_report = {"percent": -1, "time": 0.0}

    for index, part in enumerate(parts):
        start = index * part_size
        end = min(ARCHIVE_SIZE - 1, start + part_size - 1)
        expected = end - start + 1
        if part.exists() and part.stat().st_size > expected:
            part.unlink()
        completed += part.stat().st_size if part.exists() else 0

    def report(delta: int) -> None:
        nonlocal completed
        with completed_lock:
            completed += delta
            percent = int(completed * 100 / ARCHIVE_SIZE)
            now = time.monotonic()
            if percent > last_report["percent"] and now - last_report["time"] >= 0.8:
                print(f"GPU runtime download: {percent}%", flush=True)
                last_report.update(percent=percent, time=now)

    def download_part(index: int) -> Path:
        start = index * part_size
        end = min(ARCHIVE_SIZE - 1, start + part_size - 1)
        expected = end - start + 1
        part = parts[index]
        existing = part.stat().st_size if part.exists() else 0
        if existing == expected:
            return part
        headers = {"Range": f"bytes={start + existing}-{end}", "User-Agent": "BiliVideoSummary/1.0"}
        with requests.get(ARCHIVE_URL, headers=headers, stream=True, timeout=(30, 180)) as response:
            if response.status_code != 206:
                raise RuntimeError(f"GPU runtime part {index + 1} returned HTTP {response.status_code}")
            with part.open("ab") as output:
                for chunk in response.iter_content(chunk_size=1024 * 1024):
                    if chunk:
                        output.write(chunk)
                        report(len(chunk))
        if part.stat().st_size != expected:
            raise RuntimeError(f"GPU runtime part {index + 1} is incomplete")
        return part

    print("Downloading the free NVIDIA runtime in 8 parallel parts (first GPU start only)...", flush=True)
    with ThreadPoolExecutor(max_workers=WORKERS) as pool:
        downloaded_parts = list(pool.map(download_part, range(WORKERS)))

    assembling = archive.with_suffix(".7z.assembling")
    with assembling.open("wb") as output:
        for part in downloaded_parts:
            with part.open("rb") as source:
                shutil.copyfileobj(source, output, length=4 * 1024 * 1024)
    if assembling.stat().st_size != ARCHIVE_SIZE:
        raise RuntimeError("GPU runtime archive size validation failed")
    os.replace(assembling, archive)
    for part in downloaded_parts:
        part.unlink(missing_ok=True)
    return archive


def install_runtime(runtime_root: Path) -> list[Path]:
    directories = runtime_directories(runtime_root)
    if directories:
        return directories

    storage_root = runtime_root.parent
    storage_root.mkdir(parents=True, exist_ok=True)
    archive = download_archive(storage_root)
    runtime_root.mkdir(parents=True, exist_ok=True)
    print("Installing the NVIDIA runtime...", flush=True)
    subprocess.run(["tar.exe", "-xf", str(archive), "-C", str(runtime_root)], check=True)
    directories = runtime_directories(runtime_root)
    if not directories:
        raise RuntimeError("Required CUDA DLL files were not found after extraction")
    archive.unlink(missing_ok=True)
    return directories


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--runtime-root", required=True, type=Path)
    args = parser.parse_args()
    directories = install_runtime(args.runtime_root.resolve())
    print("CUDA runtime ready:", flush=True)
    for directory in directories:
        print(directory, flush=True)


if __name__ == "__main__":
    main()
