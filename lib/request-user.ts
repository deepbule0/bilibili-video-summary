import { getChatGPTUser } from "@/app/chatgpt-auth";
import { ensureUser, isOwner } from "@/lib/commerce";

export async function requireApiUser() {
  const identity = await getChatGPTUser();
  if (!identity) throw new Error("AUTH_REQUIRED");
  await ensureUser(identity);
  return identity;
}

export async function requireOwner() {
  const identity = await requireApiUser();
  if (!(await isOwner(identity.userId))) throw new Error("OWNER_REQUIRED");
  return identity;
}

export function apiError(error: unknown) {
  const message = error instanceof Error ? error.message : "请求失败，请稍后重试";
  if (message === "AUTH_REQUIRED") return { status: 401, message: "请先登录或注册" };
  if (message === "OWNER_REQUIRED") return { status: 403, message: "仅管理员可以执行此操作" };
  return { status: 400, message };
}
