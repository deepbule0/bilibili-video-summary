# 听见 · 总结

粘贴 B 站视频链接，自动提取音频、转写语音，并生成摘要、核心观点和时间线。

## 最快使用方式（Windows）

1. 安装 Python 3.10 或更高版本。
2. 双击 `start-local.bat`。
3. 首次启动会自动安装依赖与 Whisper 模型；准备完成后会自动打开在线页面。
4. 粘贴 B 站链接并点击「一键总结」。

默认使用 `faster-whisper base` 在本机 CPU 转写，使用规则模型在本地提炼摘要，不产生模型 API 费用。首次转写会下载 Whisper 模型，之后可离线复用。已正确安装 CUDA 运行库的电脑可设置 `WHISPER_DEVICE=cuda` 使用显卡。

## GPT 增强模式

复制 `.env.example` 为 `.env.local`，填写 `OPENAI_API_KEY`，然后在页面打开「GPT 增强总结」。默认模型为 `gpt-5-mini`，可通过 `OPENAI_SUMMARY_MODEL` 调整。GPT API 会按账户用量计费，因此不属于零费用模式。

## 工作流程

```text
B 站链接
  → 读取公开视频信息 / 优先复用现有字幕
  → 无字幕时由 yt-dlp 提取音频
  → faster-whisper 本地转写
  → 本地规则总结 或 GPT 结构化总结
  → 网页展示、复制、下载 Markdown、生成直达链接
```

## 目录

- `app/`：网页与 B 站信息、总结接口
- `engine/`：本地音频下载和 Whisper 转写引擎
- `start-local.bat`：Windows 一键启动入口
- `.env.example`：可选模型配置

请只处理你有权访问和转写的视频，并遵守 B 站服务条款及内容版权要求。
