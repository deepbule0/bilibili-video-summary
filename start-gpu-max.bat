@echo off
chcp 65001 >nul
setlocal
set "BILI_SUMMARY_MODEL=qwen3.5:9b-q8_0"
set "BILI_SUMMARY_NUM_CTX=16384"
set "BILI_SUMMARY_NUM_BATCH=128"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0start-local.ps1"
