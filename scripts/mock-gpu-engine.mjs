import http from "node:http";

const jobs = new Map();
const server = http.createServer(async (request, response) => {
  response.setHeader("content-type", "application/json; charset=utf-8");
  if (request.url === "/api/health") return response.end(JSON.stringify({ status: "ready", priority_queue: true }));
  if (request.method === "POST" && request.url === "/api/jobs") {
    let raw = "";
    for await (const chunk of request) raw += chunk;
    const input = JSON.parse(raw || "{}");
    const id = `mock_${Date.now()}`;
    jobs.set(id, input);
    response.statusCode = 202;
    return response.end(JSON.stringify({ id, status: "queued", priority: input.priority }));
  }
  const match = request.url?.match(/^\/api\/jobs\/(mock_\d+)$/);
  if (match && jobs.has(match[1])) {
    const input = jobs.get(match[1]);
    if (String(input.url).includes("fail=1")) {
      return response.end(JSON.stringify({ id: match[1], status: "failed", stage: "failed", progress: 0, error: "模拟 GPU 失败" }));
    }
    return response.end(JSON.stringify({
      id: match[1], status: "complete", stage: "complete", progress: 100, device: "mock-gpu",
      video: { bvid: "BV1Sve26eEGE", title: "收费系统逻辑测试视频", description: "", cover: "", owner: "测试", duration: 600, part: "测试", partNumber: 1, parts: 1, url: input.url },
      transcript: [{ start: 0, end: 5, text: "这是一段用于验证额度结算的测试转写。" }],
      summary: { headline: "测试任务已完成", overview: "该输出用于验证任务完成后额度从预留转为实际消费，并且重复查询不会重复扣费。", keyPoints: [{ title: "幂等结算", detail: "任务完成后只结算一次，后续重复查询保持原有消费记录。", time: 0 }], chapters: [{ title: "测试", summary: "系统完成身份、额度、队列、任务与结算链路的自动测试。", time: 0 }], quotes: [{ text: "这是一段用于验证额度结算的测试转写。", time: 0 }], keywords: ["额度", "结算", "测试"], disclaimer: "AI生成内容，仅供测试。", mode: "local" },
      summary_model: "mock-qwen", summary_device: "mock-gpu",
    }));
  }
  response.statusCode = 404;
  response.end(JSON.stringify({ error: "not found" }));
});

server.listen(9876, "127.0.0.1", () => console.log("Mock GPU engine: http://127.0.0.1:9876"));
