# 可选 35B 模型：安装与调用

模型为 Qwen3.6-35B-A3B，MoE 总参数约 35B、每次激活约 3B；本项目使用 bartowski 的 **IQ2_XXS 社区极低位量化 GGUF**，约 10.68GB，并非完整精度模型。导入名称为 `bili-summary:35b-iq2xxs`，仅配置文本/代码，未配置视觉组件。

## 安装一次，后续复用

先确保 Ollama 已安装、启动并加入 PATH。仓库根目录执行：

```powershell
.venv\Scripts\python.exe scripts/tune-gpu-summary.py install-35b
ollama list
```

安装器将权重保存在 `work/models/`，校验固定大小和 SHA256，再通过 `engine/models/qwen3.6-35b-iq2xxs.Modelfile` 导入 Ollama。默认从 ModelScope 镜像下载并验证上游文件哈希；也支持 `--download-source huggingface`。不会自动改动应用默认 9B Q8 配置。

上游仓库：`bartowski/Qwen_Qwen3.6-35B-A3B-GGUF`；固定修订：`5c2410d71524f4f72b023ce8daf7a80528226d5f`；文件 SHA256：`aa4a46af613699d81841505974c91c877139c713e9e1f25b7708471e0542e85b`。这些是公开文件校验信息，不是访问密钥。

## 简要调用流程

1. `ollama list` 确认模型已安装；没有其他任务使用 GPU 时再调用。
2. 将任务、资料和输出约束放入 `messages`，先使用 16K 上下文，不盲目加大。
3. 读取最终 `message.content`；`done_reason=length` 或空回答必须视为未完成。
4. 代码跑测试，数值独立核验；不直接执行模型给出的系统命令。

```powershell
$requestBody = @{
  model = 'bili-summary:35b-iq2xxs'
  messages = @(@{ role = 'user'; content = '替换为实际任务、资料和输出要求' })
  think = $true
  stream = $false
  keep_alive = '2m'
  options = @{
    num_ctx = 16384; num_batch = 128; num_predict = 8192
    temperature = 0.6; top_p = 0.95; top_k = 20
    min_p = 0.0; presence_penalty = 0.0; repeat_penalty = 1.0
  }
}
$jsonBody = $requestBody | ConvertTo-Json -Depth 6
$reply = Invoke-RestMethod -Method Post -Uri 'http://127.0.0.1:11434/api/chat' `
  -ContentType 'application/json; charset=utf-8' `
  -Body ([Text.Encoding]::UTF8.GetBytes($jsonBody)) -TimeoutSec 300
if ($reply.done_reason -eq 'length' -or [string]::IsNullOrWhiteSpace($reply.message.content)) {
  throw '模型未在生成额度内完成，请拆分任务或调整额度。'
}
$reply.message.content
```

这是编程/推理调用起点，不是准确率保证。`num_predict` 同时包含思考和最终回答；输入、历史和生成内容要留在上下文容量内。简单改写可关闭 `think`、降低生成额度，实际效果以任务测试为准。

项目开发机的 12GB 显存曾验证 16K 配置全 GPU 分配，但其他设备、驱动或并行任务不保证相同表现。35B 低位量化在本项目的部分代码/推理测试中更快，质量没有全面赢家；详见测试说明。

只有确认自己任务已结束、无人使用该模型时，才用 `POST /api/generate` 发送 `{"model":"bili-summary:35b-iq2xxs","keep_alive":0}` 释放显存。它不会删除权重。

另一位助手必须具有同一台电脑的终端或本地 HTTP 访问能力才能使用此模型。给它文档不会改变它自身的基础模型；另一台设备的 `127.0.0.1` 也不是你的电脑。不要将无鉴权 Ollama 接口暴露到公网。
