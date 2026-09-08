/**
 * cookie 中间件：解析 + 校验签名 + 注入 req.session。
 *
 * cookie 设计（PRD 认证结论）：值 = `<token>.<HMAC-SHA256(token, serverKey)>`，
 * HttpOnly + SameSite=Lax。serverKey 首次启动随机生成存 data 目录——
 * 重启后旧 cookie 仍有效，不需要 everybody 重登。
 * 手写解析不引 cookie-parser：只有我们自己种的一个 cookie，格式可控。
 */
import { createHmac, timingSafeEqual, createHash } from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import { getLoginSession, type LoginSession } from "./session-store.ts";

export const SESSION_COOKIE_NAME = "pi_teacher_session";

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      session?: LoginSession;
    }
  }
}

/** serverKey 归一成 32 字节密钥（无论外部传什么形态，HMAC 密钥定长）。 */
function normalizeKey(key: string): Buffer {
  return createHash("sha256").update(key, "utf8").digest();
}

let signingKey: Buffer | null = null;

export function initCookieSigning(keyMaterial: string): void {
  signingKey = normalizeKey(keyMaterial);
}

function signToken(token: string): string {
  if (!signingKey) throw new Error("cookie 签名未初始化（先调 initCookieSigning）");
  return `${token}.${createHmac("sha256", signingKey).update(token, "utf8").digest("hex")}`;
}

/** 恒定时间比较签名（归一长度 + timingSafeEqual，同 password.ts 思路）。 */
function signatureMatches(token: string, signature: string): boolean {
  if (!signingKey) return false;
  const expected = createHmac("sha256", signingKey).update(token, "utf8").digest("hex");
  const a = createHash("sha256").update(signature, "utf8").digest();
  const b = createHash("sha256").update(expected, "utf8").digest();
  return timingSafeEqual(a, b);
}

export function buildSessionCookie(token: string): string {
  return `${SESSION_COOKIE_NAME}=${signToken(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${7 * 24 * 60 * 60}`;
}

export function buildClearCookie(): string {
  return `${SESSION_COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}

/** 从 Cookie 头解析指定 cookie（只支持我们格式，够用；多 cookie 逗号分隔场景简单 split）。 */
function readCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return undefined;
}

/** 校验中间件：验签 → 查登录态 → 挂 req.session；失败 401。 */
export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  const raw = readCookie(req.headers.cookie, SESSION_COOKIE_NAME);
  if (raw) {
    const dot = raw.lastIndexOf(".");
    if (dot > 0) {
      const token = raw.slice(0, dot);
      const signature = raw.slice(dot + 1);
      if (signatureMatches(token, signature)) {
        const session = getLoginSession(token);
        if (session) {
          req.session = session;
          next();
          return;
        }
      }
    }
  }
  res.status(401).json({ error: "未登录" });
}
