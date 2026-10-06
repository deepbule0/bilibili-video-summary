[English](README.md) | [简体中文](README.zh-CN.md)

# 听见 · 总结｜Bilibili 视频总结工具

粘贴 B 站视频链接，获取完整内容总结、详细要点、主题解读和带时间戳的原始转写。面向直播、课程、访谈、演讲等通用内容，不限定资本市场领域。

## 能做什么

- 优先读取已有字幕；无可用字幕时下载音频并用 `faster-whisper large-v3` 转写。
- 用 Ollama 运行本地 Qwen：默认 `qwen3.5:9b-q8_0`，16K 上下文。
- 过滤明确无关的寒暄、点名、设备调试和重复互动，保留分析、证据、案例、数字、推理过程和结论。
- 长文本分块处理，再经过“初稿 → 事实与逻辑审校 → 重写”；保留未经过滤的转写供核对。
- 网页查看、复制和下载 Markdown；支持包含视频地址的直达链接。
- 包含账户中心、套餐、额度记录、支付宝接入代码、手机号绑定和经营后台。
- 可选 GPT 增强总结；该模式需要 API 密钥并产生费用。

“零 API 费用”指本地模型推理不调用付费模型服务，不包括硬件、电费、网络、短信、托管或收款成本。模型输出和转写仍可能有错误，不作准确率保证。

## 架构

```text
网页（React / Next.js API，使用 Vinext 构建）
  ├─ B站信息与字幕、内容展示、Markdown 导出
  ├─ 身份、套餐、订单、额度与记录 → Cloudflare D1
  └─ 本机引擎 / 配置了鉴权的 GPU 工作节点
       → yt-dlp 音频提取 → faster-whisper 转写
       → 释放转写模型显存 → Ollama / Qwen 总结与审校
```

GitHub 用来保存和分享代码，**不提供 GPU 推理，也不是可直接运行此完整系统的 GitHub Pages 网站**。生产账户与数据库依赖托管运行环境，不能只上传静态文件替代。

## Windows 快速使用

1. 安装 Python 3.10+；可用 NVIDIA 显卡将用于加速，兼容性不足时回退 CPU。
2. 下载仓库源代码，解压后双击 `start-local.bat`。
3. 首次启动安装 Python 依赖、准备 CUDA 运行库及 Ollama，总结模型会按所选配置下载；Whisper 权重在首次需要时下载。之后复用本地缓存。
4. 启动器默认打开原项目的在线页面；按页面提示登录并允许访问本地网络，然后提交视频链接。

默认模型权重约需 3GB（Whisper）和 10.7GB（Qwen）；Windows GPU 运行库约 810MB。还需为依赖和下载缓存留出空间，首次下载可能较久。

`start-local.bat` **仅启动 Python/Ollama 引擎，不会启动网页开发服务器**。如果使用自己部署的网页，启动前在 PowerShell 中设置：

```powershell
$env:BILI_APP_URL = 'http://localhost:5173/' # 或自己的网页地址
.\start-local.bat
```

本机模型配置可保存在忽略上传的 `work/gpu-summary-profile.json`。终端环境变量 `BILI_SUMMARY_MODEL`、`BILI_SUMMARY_NUM_CTX`、`BILI_SUMMARY_NUM_BATCH` 优先于该文件；无配置时默认 9B Q8、16384、128。`start-gpu-max.bat` 和 `start-gpu-precision.bat` 都是这一配置的兼容入口，不会自动切换到 35B。

## 自己运行网页

需要 Node.js 22.13+（建议 Node 24），以下命令在仓库根目录执行：

```powershell
npm run install:ci
Copy-Item .env.example .env.local
npm run build
node node_modules/wrangler/bin/wrangler.js d1 execute site-creator-d1 --local --config dist/server/wrangler.json --persist-to .wrangler/state --file drizzle/0000_mighty_slapstick.sql
npm run dev
```

打开 `http://localhost:5173/`。本地登录使用开发测试身份，不是真实注册；商用登录不能使用这个测试身份。默认 D1 绑定名称为 `DB`，本地数据保存在 `.wrangler/`，不随代码上传。迁移命令用于初次初始化，不要在已有数据库上重复执行初始建表文件。

将 `BILI_APP_URL` 指向本地网页后，再启动本地引擎。若不使用 Windows 启动器，可按 [部署说明](docs/DEPLOYMENT.md) 手动运行 Python 服务。

`.env.example` 是配置清单，不包含密钥。网页和 Python 是独立进程，Python 不会自动读取 `.env.local`；Windows 启动器也只读取终端/系统环境变量。网页使用自身部署环境的配置。

## 模型与测试

默认选择是项目内少量样例的结果，不是“当前最强模型”结论，也不意味着所有设备都能全 GPU 加载。模型精度、上下文和其他 GPU 任务会影响显存与速度。

- [35B 模型调用与安装说明](docs/MODEL_35B.md)：可选 Qwen3.6-35B-A3B IQ2_XXS，社区量化、约 10.68GB，只用于文本/代码。
- [测试说明](docs/TESTING.md)：总结样例、编程/通用任务夹具、评分器自检与复跑命令。
- 不自动下载所有候选模型，不因测试改动生产默认模型。

```powershell
npm run typecheck
npm run lint
npm run build
npm run audit:publication -- --history
.venv\Scripts\python.exe scripts/compare-local-models.py --self-test
```

推送后的 GitHub Actions 会执行前端类型检查、静态检查、构建、Python 编译和评分器自检；不下载模型或占用 GPU。构造样例不能代替真实视频的人工核验。

## 收费系统边界

当前代码包含：一次性 30 分钟试用、标准版 ¥20/30天（每7天500分钟）、高级版 ¥50/30天（优先处理，在可用算力范围内不限量）、拥有者不限量，以及任务额度预留/结算/失败返还、订单和后台配置。

**这不是配置后即可无审核收费的成品服务。** 当前真实登录依赖托管平台的 ChatGPT 身份，手机号功能是登录后的绑定/验证，不是独立的短信注册登录系统。支付宝和短信需要自行申请服务并配置；订阅采用手动续费，不含自动扣款。

真实对外收费前请完成 [实施方案](IMPLEMENTATION_PLAN.md)、[部署说明](docs/DEPLOYMENT.md) 和 [安全说明](SECURITY.md) 中的配置、业务验收与安全检查。不要把模拟付款、测试短信、开发身份或无鉴权 GPU 节点当作生产服务。

## 目录

| 位置 | 内容 |
| --- | --- |
| `app/`、`components/` | 网页、账户、后台与服务接口 |
| `lib/` | 总结、额度、支付宝、短信与接口处理 |
| `engine/` | Python 音频、转写、总结与优先队列 |
| `engine/evaluation/` | 可复现的合成测试样例 |
| `engine/models/` | 模型导入定义，不含权重 |
| `db/`、`drizzle/` | 数据结构与迁移，不含账户数据 |
| `scripts/` | 构建、模型调试、测试及发布扫描 |
| `docs/` | 部署、模型调用和测试说明 |

权重、音视频、原始个人转写、日志、数据库、密钥、本机路径交接文件及运行缓存不上传。`.openai/hosting.json` 仅含原站点的非密钥部署标识与绑定名称；自行托管时应换成自己的配置，不能沿用它获得原站点管理权限。

请只处理有权访问、转写和使用的视频，不绕过访问限制。公开代码不等于授权重新发布视频内容；本项目尚未选定整体开源许可证，第三方组件保留各自的许可证。
