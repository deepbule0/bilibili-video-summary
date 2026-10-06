[English](README.md) | [简体中文](README.zh-CN.md)

# Bilibili Video Summary

Paste a Bilibili video link to get a complete summary, detailed key points, topic explanations, and the original timestamped transcript. Supports livestreams, courses, interviews, talks, and other general content—not just financial markets.

## Features

- Reuse available subtitles first; otherwise, download the audio and transcribe it with `faster-whisper large-v3`.
- Run Qwen locally through Ollama: the default model is `qwen3.5:9b-q8_0` with a 16K context window.
- Remove clearly irrelevant greetings, shout-outs, equipment checks, and repetitive interactions while preserving analysis, evidence, examples, numbers, reasoning, and conclusions.
- Process long transcripts in chunks, then run a draft → factual and logical review → rewrite pipeline. Keep the unfiltered transcript for verification.
- View, copy, and download summaries as Markdown; create direct links containing the video URL.
- Includes an account dashboard, subscription plans, usage records, Alipay integration code, phone-number binding, and an admin dashboard.
- Optional GPT-enhanced summaries require an API key and incur API charges.

“No API fees” means local inference does not call paid model APIs. It does not include hardware, electricity, network access, SMS, hosting, or payment-processing costs. Transcripts and model outputs may still contain errors; accuracy is not guaranteed.

## Architecture

```text
Web app (React / Next.js APIs, built with Vinext)
  ├─ Bilibili metadata and subtitles, results, Markdown export
  ├─ Identity, plans, orders, quotas, and records → Cloudflare D1
  └─ Local engine / authenticated GPU worker
       → yt-dlp audio extraction → faster-whisper transcription
       → release transcription VRAM → Ollama / Qwen summary and review
```

GitHub stores and shares the source code. **It does not provide GPU inference, and this full application cannot run as a GitHub Pages site.** Production accounts and database operations require a backend hosting environment, not just static files.

## Windows Quick Start

1. Install Python 3.10+. Compatible NVIDIA GPUs are used for acceleration; otherwise, transcription falls back to the CPU.
2. Download and extract the repository, then double-click `start-local.bat`.
3. The first launch installs Python dependencies and prepares the CUDA runtime and Ollama. It downloads the selected summary model; Whisper weights are downloaded when first needed. Subsequent runs reuse the local cache.
4. By default, the launcher opens the original project's hosted page. Sign in, allow local-network access when prompted, and submit a video link.

The default weights require approximately 3GB for Whisper and 10.7GB for Qwen. The Windows GPU runtime is approximately 810MB. Allow additional space for dependencies and download caches; the initial downloads can take some time.

`start-local.bat` **starts only the Python/Ollama engine, not the web development server**. To use your own web app, set the following in PowerShell before starting the launcher:

```powershell
$env:BILI_APP_URL = 'http://localhost:5173/' # Or your own web app URL
.\start-local.bat
```

Local model settings can be saved in the Git-ignored `work/gpu-summary-profile.json`. The environment variables `BILI_SUMMARY_MODEL`, `BILI_SUMMARY_NUM_CTX`, and `BILI_SUMMARY_NUM_BATCH` take precedence. Without overrides, the defaults are 9B Q8, 16384, and 128. Both `start-gpu-max.bat` and `start-gpu-precision.bat` are compatibility launchers for this configuration; neither automatically switches to 35B.

## Run Your Own Web App

Requires Node.js 22.13+; Node 24 is recommended. Run these commands from the repository root:

```powershell
npm run install:ci
Copy-Item .env.example .env.local
npm run build
node node_modules/wrangler/bin/wrangler.js d1 execute site-creator-d1 --local --config dist/server/wrangler.json --persist-to .wrangler/state --file drizzle/0000_mighty_slapstick.sql
npm run dev
```

Open `http://localhost:5173/`. Local sign-in uses a development test identity, not real account registration; never use this identity for a commercial deployment. The default D1 binding is `DB`, and local database files stay in the Git-ignored `.wrangler/` directory. Run the initial schema migration only on a fresh database, not repeatedly on an existing one.

Point `BILI_APP_URL` to your local web app, then start the local engine. To run Python manually instead of using the Windows launcher, follow the [deployment guide](docs/DEPLOYMENT.md) (Chinese).

`.env.example` lists the available settings and contains no credentials. The web app and Python engine run as separate processes: Python does not automatically read `.env.local`, and the Windows launcher reads only terminal/system environment variables. Configure the web app through its own deployment environment.

## Models and Testing

The default model was selected using a small set of project-specific examples. This is not a claim that it is the “best model available,” nor a guarantee that every device can load it entirely on the GPU. Quantization, context length, and other GPU workloads affect memory use and speed.

- [35B installation and inference guide](docs/MODEL_35B.md) (Chinese): optional Qwen3.6-35B-A3B IQ2_XXS, a community quantization of approximately 10.68GB, configured for text/code only.
- [Testing guide](docs/TESTING.md) (Chinese): summary fixtures, coding/general-task fixtures, grader self-tests, and reproduction commands.
- Tests do not automatically download every candidate model or change the production default.

```powershell
npm run typecheck
npm run lint
npm run build
npm run audit:publication -- --history
.venv\Scripts\python.exe scripts/compare-local-models.py --self-test
```

The GitHub Actions workflow is configured to run frontend type checks, linting, builds, Python compilation, and grader self-tests without downloading models or using a GPU. Synthetic examples do not replace manual verification against real videos.

## Subscription System: Scope and Limitations

The current code includes a one-time 30-minute trial; a Standard plan at CNY 20 per 30 days with 500 minutes every 7 days; a Premium plan at CNY 50 per 30 days with priority processing and no minute quota within available compute capacity; unlimited owner access; and job quota reservation, settlement, release on failure, order records, and admin configuration.

**This is not a production-ready paid service that can go live without further review.** Production sign-in currently relies on the hosting platform's ChatGPT identity. Phone-number verification binds a number to an already signed-in account; it is not an independent SMS registration/login system. Alipay and SMS services require your own provider accounts and configuration. Subscriptions use manual renewal, not automatic recurring charges.

Before accepting real payments, complete the configuration, business acceptance tests, and security checks in the [implementation plan](IMPLEMENTATION_PLAN.md), [deployment guide](docs/DEPLOYMENT.md), and [security notes](SECURITY.md), all currently in Chinese. Do not treat mock payments, test SMS, development identities, or unauthenticated GPU workers as production services.

## Repository Layout

| Location | Contents |
| --- | --- |
| `app/`, `components/` | Web UI, accounts, admin dashboard, and API routes |
| `lib/` | Summaries, quotas, Alipay, SMS, and API response handling |
| `engine/` | Python audio extraction, transcription, summaries, and priority queue |
| `engine/evaluation/` | Reproducible synthetic test fixtures |
| `engine/models/` | Model import definitions, not weights |
| `db/`, `drizzle/` | Database schema and migrations, not account data |
| `scripts/` | Build tools, model diagnostics, tests, and publication checks |
| `docs/` | Deployment, model inference, and testing guides |

Model weights, audio/video, personal transcripts, logs, databases, credentials, machine-specific handoff files, and runtime caches are excluded from publication. `.openai/hosting.json` contains only the original site's non-secret deployment identifier and binding names. Replace these with your own settings when hosting independently; they do not grant administrative access to the original site.

Process only videos you are authorized to access, transcribe, and use. Do not bypass access restrictions. Publishing the source does not authorize redistribution of video content. An overall open-source license has not yet been selected for this project; third-party components retain their respective licenses.
