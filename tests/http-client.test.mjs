import assert from "node:assert/strict";
import test from "node:test";
import { readJsonResponse } from "../lib/http-client.ts";

test("returns successful JSON data", async () => {
  const data = { ok: true, summary: { overview: "测试总结" } };
  assert.deepEqual(await readJsonResponse(Response.json(data)), data);
});

test("preserves API errors for callers to inspect", async () => {
  const data = { ok: false, error: "请先登录" };
  assert.deepEqual(await readJsonResponse(Response.json(data, { status: 401 })), data);
});

test("HTML error pages become readable messages without leaking the body", async () => {
  const response = new Response("<!DOCTYPE html><html>internal-debug-detail</html>", { status: 502 });
  await assert.rejects(readJsonResponse(response), (error) => {
    assert.match(error.message, /非 JSON.*502/);
    assert.doesNotMatch(error.message, /internal-debug-detail|DOCTYPE/);
    return true;
  });
});

for (const body of ["null", "[]", '"text"', "123"]) {
  test(`rejects a non-object response: ${body}`, async () => {
    await assert.rejects(readJsonResponse(new Response(body)), /无效的数据格式/);
  });
}
