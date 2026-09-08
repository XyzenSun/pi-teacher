/**
 * 登录态存储：内存 Map（单进程，PRD 认证结论——不引第三方 session 库）。
 * 服务重启即全部失效（重新登录），对单用户自部署可接受。
 */
import { randomBytes } from "node:crypto";

export interface LoginSession {
  /** cookie 里的不透明 token */
  token: string;
  username: string;
  createdAt: number;
}

/** token → session。模块级 Map：与 server 进程同生命周期。 */
const loginSessions = new Map<string, LoginSession>();

const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 天

export function createLoginSession(username: string): LoginSession {
  // 顺手清理过期项（单用户场景 Map 极小，遍历成本可忽略）
  const now = Date.now();
  for (const [token, session] of loginSessions) {
    if (now - session.createdAt > SESSION_TTL_MS) loginSessions.delete(token);
  }
  const session: LoginSession = {
    token: randomBytes(32).toString("hex"),
    username,
    createdAt: now,
  };
  loginSessions.set(session.token, session);
  return session;
}

export function getLoginSession(token: string | undefined): LoginSession | null {
  if (!token) return null;
  const session = loginSessions.get(token);
  if (!session) return null;
  if (Date.now() - session.createdAt > SESSION_TTL_MS) {
    loginSessions.delete(token);
    return null;
  }
  return session;
}

export function destroyLoginSession(token: string | undefined): void {
  if (token) loginSessions.delete(token);
}
