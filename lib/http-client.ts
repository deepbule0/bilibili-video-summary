/** Parse API responses without leaking a platform's HTML error page to users. */
export async function readJsonResponse<T extends object>(response: Response): Promise<T> {
  const text = await response.text();
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`接口返回了非 JSON 内容（HTTP ${response.status}），请检查服务是否正常。`);
  }
  if (data === null || typeof data !== "object" || Array.isArray(data)) {
    throw new Error(`接口返回了无效的数据格式（HTTP ${response.status}）。`);
  }
  // Callers still check the response status and required success fields.
  return data as T;
}
