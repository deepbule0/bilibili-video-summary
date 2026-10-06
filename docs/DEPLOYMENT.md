# 运行与部署说明

## 本机模式

网页按 README 初始化本地 D1 并运行 `npm run dev`；使用页面上的本地测试登录。另一个终端启动 Python 引擎，两者分开运行。

Windows 优先使用 `start-local.bat`：它准备 NVIDIA 运行库并选择 GPU，不会启动网页服务器。自建网页设置 `BILI_APP_URL`，不设置则打开原项目在线页面。

手动启动示例（PowerShell，已经安装 Python 与 Ollama）：

```powershell
python -m venv .venv
.venv\Scripts\python.exe -m pip install -r engine/requirements.txt
ollama pull qwen3.5:9b-q8_0
$env:WHISPER_MODEL = 'large-v3'
$env:WHISPER_DEVICE = 'cpu' # CUDA/cuDNN 配置好后才改为 cuda
$env:SUMMARY_MODEL = 'qwen3.5:9b-q8_0'
.venv\Scripts\python.exe -m uvicorn engine.server:app --host 127.0.0.1 --port 8765
```

检查 `http://127.0.0.1:8765/api/health`：确认转写设备、总结模型、上下文与队列状态。健康检查不保证模型已经成功完成推理；用短视频验证实际处理。

## 自己部署完整服务

1. 配置可运行服务端接口的托管环境、Cloudflare D1 `DB` 绑定及数据库迁移。GitHub Pages 不支持此后端。
2. 接入可信身份提供方。现有生产代码信任平台注入的 `oai-authenticated-user-*` 请求头；自建反向代理必须移除客户端伪造头，并在验证会话后注入身份。否则需先更换认证实现，不能直接公开使用。
3. 设置 `OWNER_USER_ID`、`PUBLIC_APP_URL`。拥有者 ID 必须来自可信认证，不能来自用户输入。
4. 启动独立 GPU 工作节点，设置高强度 `ENGINE_API_TOKEN`；用经过鉴权的 HTTPS 反向代理或私有通道连接。网页后端配置 `GPU_ENGINE_URL` 和相同的 `GPU_ENGINE_TOKEN`。不要把令牌发送到浏览器。
5. 设置短信服务 `SMS_WEBHOOK_URL`、`SMS_WEBHOOK_TOKEN`、`PHONE_CODE_SECRET`；关闭 `SMS_TEST_MODE`。当前仅支持绑定中国大陆手机号，独立手机号注册登录仍需补齐认证链路。
6. 配置支付宝 `ALIPAY_APP_ID`、RSA2 应用私钥、支付宝公钥；关闭 `PAYMENT_TEST_MODE`。通知地址为 `/api/billing/alipay/notify`，退款与售后流程需另行验收。
7. 按实施方案测试并发额度、失败返还、通知验签、重复支付通知、权限与到期续费。保留备份和监控后再开放收费。

当前 Python 队列和任务结果在内存里，工作节点重启会丢失任务状态；正式多用户服务仍需持久化队列、失联任务恢复、超时释放额度、并发/速率限制与资源上限。高级版“不限量”不是无限并发或算力承诺。

现有 Windows 启动器默认面向私人本机服务，不是生产守护进程。本地浏览器直接访问引擎的路径不会替代云端付费任务的额度控制，不应对外宣称本机备用路径提供了付费服务隔离。

## 链接与成本

直达链接格式为 `https://你的网页/?url=编码后的视频地址&mode=local`。它会触发处理，需要可用身份、额度和引擎；不是永久缓存的公开总结页面。

本地模型无需 API 账单。GPT 模式、GPU 主机、短信、数据库/托管超额及支付服务费用需要分别核算。模型权重另行按来源许可下载，仓库不分发权重。
