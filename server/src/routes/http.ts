import type { ErrorRequestHandler } from "express";

/** 只有明确标为 HttpError 的消息才返回浏览器，避免泄露驱动错误与部署路径。 */
export class HttpError extends Error {
  constructor(public readonly status: number, message: string, public readonly code?: string) {
    super(message);
    this.name = "HttpError";
  }
}

export function readBody(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new HttpError(400, "请求体必须是 JSON 对象");
  }
  return value as Record<string, unknown>;
}

export function readId(value: unknown, label = "id", allowZero = false): number {
  const parsed = typeof value === "string" && /^\d+$/.test(value) ? Number(value) : value;
  if (typeof parsed !== "number" || !Number.isSafeInteger(parsed) || parsed < (allowZero ? 0 : 1)) {
    throw new HttpError(400, `${label} 必须是有效的整数 ID`);
  }
  return parsed;
}

export function readText(value: unknown, label: string, maxLength = 100_000): string {
  if (typeof value !== "string" || !value.trim() || value.length > maxLength) {
    throw new HttpError(400, `${label} 不能为空，且不能超过 ${maxLength} 个字符`);
  }
  return value.trim();
}

export function readNullableText(value: unknown, label: string, maxLength = 100_000): string | null {
  if (value === null) return null;
  if (typeof value !== "string" || value.length > maxLength) {
    throw new HttpError(400, `${label} 必须是文本或 null，且不能超过 ${maxLength} 个字符`);
  }
  return value.trim() || null;
}

export const apiErrorHandler: ErrorRequestHandler = (error: unknown, _req, res, next) => {
  if (res.headersSent) {
    next(error);
    return;
  }
  if (error instanceof HttpError) {
    res.status(error.status).json({ error: error.message, ...(error.code ? { code: error.code } : {}) });
    return;
  }
  const details = error as { code?: string; type?: string; status?: number } | null;
  if (details?.type === "entity.too.large") {
    res.status(413).json({ error: "请求内容超过大小限制" });
  } else if (details?.type === "entity.parse.failed" || error instanceof URIError) {
    res.status(400).json({ error: "请求格式无效" });
  } else if (details?.code === "SQLITE_CONSTRAINT_UNIQUE") {
    res.status(409).json({ error: "相同名称或记录已经存在" });
  } else if (details?.code === "SQLITE_CONSTRAINT_FOREIGNKEY") {
    res.status(409).json({ error: "记录仍被引用，或关联记录不存在" });
  } else if (details?.code?.startsWith("SQLITE_CONSTRAINT")) {
    res.status(400).json({ error: "数据不满足业务约束" });
  } else {
    console.error("[server] 请求处理失败，请检查服务端配置与文件权限");
    res.status(500).json({ error: "服务暂时无法完成请求，请稍后重试" });
  }
};
