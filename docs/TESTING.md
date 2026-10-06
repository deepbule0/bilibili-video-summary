# 测试与复现

## 不需要 GPU 的检查

```powershell
npm run typecheck
npm run lint
npm run build
npm run audit:publication -- --history
.venv\Scripts\python.exe -m compileall -q engine scripts/compare-local-models.py scripts/tune-gpu-summary.py
.venv\Scripts\python.exe scripts/compare-local-models.py --self-test
```

评分器自检包含正确参考答案、故意错误答案和安全守卫：三道代码题共 181 项检查，四道通用题检查事实、概率、排程和通知。它不代表实际模型通过了这些题。

`audit:publication` 扫描当前可发布文件，`--history` 另扫描全部 Git 历史；只报告文件、行号和规则，不输出疑似密钥。扫描基于启发式规则，不能替代人工检查。请在已暂存、无删除文件的发布快照上使用。

## 需要本地模型的测试

确保 Ollama 正在运行，所选模型已经安装，没有别人的推理任务占用 GPU。以下命令不会自动下载模型，也不会切换应用默认配置：

```powershell
.venv\Scripts\python.exe scripts/tune-gpu-summary.py benchmark --models qwen3.5:9b-q8_0 --contexts 16384 --pipeline
.venv\Scripts\python.exe scripts/compare-local-models.py
```

总结夹具：`engine/evaluation/gpu-summary-cases.json`，覆盖直播闲聊过滤、信息密集课程、长文本末尾分析。检查 JSON 结构、关键事实与禁用闲聊；还需人工核对因果、证据覆盖和无依据扩写。

代码/通用夹具：`engine/evaluation/coding-general-cases.json`。可用 `--case-ids`、`--modes`、`--thinking-token-budget`、`--sampling-profile` 控制复跑；具体参数见 `--help`。

生成代码只在受限、限时子进程执行纯函数题，禁止导入及文件/网络/系统命令等接口。**这不是通用安全沙箱**；不要把任意未知代码交给该脚本执行。

## 已有小样本结果的边界

开发机：RTX 5070 Ti Laptop 12GB、32GB 内存。比较 `qwen3.5:9b-q8_0` 与 `bili-summary:35b-iq2xxs`，不是同等精度原版模型的排行榜。

曾完成 7 类编程/通用题、38 次生成：基础编程两者均通过；复杂 CSV 边界两者均未完全达标；概率与排程在思考模式中改善。35B 的生成速度更高，但不存在全面质量赢家。视频总结另有三个合成样例的初稿/审校/重写测试，9B Q8 较贴近原文，因此保留为默认。

每个题目/参数阶段仅少量生成；不能把 38 次输出当成 38 道独立题，更不能据此估计真实视频识别或总结准确率。静音转写只验证显存交接，不验证 ASR 精度。

原始响应、转写与评测结果保存到忽略上传的 `outputs/`。仓库发布夹具和评分方法，不上传个人视频全文、模型思考内容或本机测试日志。

## 正式使用的验收

选择已授权的短视频、信息密集长视频和互动直播各一段；逐项检查原始转写的专名/数字、总结中的因果与条件、末尾分析覆盖、互动过滤，以及失败后额度返还。支付、短信、身份与并发额度应另外测试，不能以构建成功替代业务验收。
