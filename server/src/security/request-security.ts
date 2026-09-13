// 移植自 pi-web v0.9.0 lib/request-security.ts（MIT License），改写为 Express
// 中间件形态。pi-teacher 用法见 PRD backend-host-mvp：先信任校验（本文件）
// 后认证——Host 不合法的请求连 401 都不给，防止 DNS rebinding 与跨站请求。
//
// 两道校验默认【关闭】，由 PI_TEACHER_REQUEST_SECURITY 打开（默认值见下方说明）：
//   1. Host 白名单 —— 防 DNS rebinding；
//   2. Origin / Sec-Fetch-Site 同源 —— 防 CSRF。
// 关闭的理由：单机自托管下 SameSite=Lax 已拦掉跨站写请求的 Cookie（本项目所有写操作
// 都是 POST/PATCH/DELETE），rebinding 也需要叠加「攻击者控制同父域子域」才可能奏效；
// 而开启后只要用域名访问又忘了配 PI_TEACHER_HOSTNAME，就会撞 403。
// 公网部署或对安全敏感时把它打开。
import { isIP } from "node:net";
import type { NextFunction, Request, Response } from "express";

function normalizeHostname(value: string): string {
  const unbracketed = value.startsWith("[") && value.endsWith("]")
    ? value.slice(1, -1)
    : value;
  return unbracketed.toLowerCase().replace(/\.$/, "");
}

function hostnameFromAuthority(value: string): string | null {
  if (!value || /[\s/@\\]/.test(value)) return null;
  try {
    const parsed = new URL(`http://${value}`);
    if (parsed.username || parsed.password || parsed.pathname !== "/" || parsed.search || parsed.hash) {
      return null;
    }
    return normalizeHostname(parsed.hostname);
  } catch {
    return null;
  }
}

function normalizeAuthority(value: string): string | null {
  if (!value || /[\s/@\\]/.test(value)) return null;
  try {
    const parsed = new URL(`http://${value}`);
    if (parsed.username || parsed.password || parsed.pathname !== "/" || parsed.search || parsed.hash) {
      return null;
    }
    const hostname = normalizeHostname(parsed.hostname);
    return parsed.port ? `${hostname}:${parsed.port}` : hostname;
  } catch {
    return null;
  }
}

function normalizeConfiguredHostname(value: string | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  return isIP(trimmed) ? normalizeHostname(trimmed) : hostnameFromAuthority(trimmed);
}

function isLoopbackHostname(hostname: string): boolean {
  return hostname === "localhost" || hostname.endsWith(".localhost");
}

function configuredHostnamesFromEnvironment(): string[] {
  return [
    process.env.PI_TEACHER_HOSTNAME,
    ...(process.env.PI_TEACHER_ALLOWED_HOSTS?.split(",") ?? []),
  ].filter((value): value is string => Boolean(value?.trim()));
}

/**
 * 两道校验的总开关，默认关闭。
 *
 * 认这几个词（大小写不敏感、可带空白）：`true` / `1` / `on` / `yes`；
 * 其余一切取值（含未设置、空串、拼写错误）都视为关闭——拼错时保持默认姿态，
 * 不会因为写了个 `TURE` 就以为防护开着。
 *
 * 受保护前缀 PI_TEACHER_ 会挡住用户环境变量界面（config/user-env.ts），
 * 因此这是纯部署期开关，只能在 compose / .env / docker run -e 里设。
 */
export function isRequestSecurityEnabled(): boolean {
  const raw = process.env.PI_TEACHER_REQUEST_SECURITY?.trim().toLowerCase();
  return raw === "true" || raw === "1" || raw === "on" || raw === "yes";
}

function canonicalOrigin(value: string): string | null {
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}

/**
 * Only trust local names, IP literals, or the hostname explicitly selected by
 * the operator. IP literals preserve LAN access but cannot be DNS-rebound
 * because the browser keeps the literal address in the Host header.
 */
export function isApiRequestHostAllowed(
  host: string | undefined,
  configuredHostnames: string[] = configuredHostnamesFromEnvironment(),
): boolean {
  const hostname = host ? hostnameFromAuthority(host) : null;
  if (!hostname) return false;
  if (isLoopbackHostname(hostname) || isIP(hostname)) return true;
  return configuredHostnames.some(
    (configured) => normalizeConfiguredHostname(configured) === hostname,
  );
}

/**
 * Reject browser cross-site API requests while preserving non-browser clients.
 * curl 等非浏览器客户端不送 Origin/sec-fetch-site，天然放行。
 */
export function isApiRequestOriginAllowed(
  host: string | undefined,
  origin: string | undefined,
  fetchSite: string | undefined,
): boolean {
  if (fetchSite === "cross-site") return false;
  if (!origin) return true;

  // 请求自报的 origin 必须与 Host 一致（same-origin 判定）
  const requestOrigin = host ? canonicalOrigin(`http://${host}`) : null;
  if (requestOrigin !== null && canonicalOrigin(origin) === requestOrigin) return true;
  return false;
}

export function shouldCheckApiRequestOrigin(
  origin: string | undefined,
  fetchSite: string | undefined,
): boolean {
  return origin !== undefined || fetchSite !== undefined;
}

/** Express 中间件：Host + Origin/sec-fetch-site 双段校验（先于认证）。
 *  总开关关闭时直接放行，两道校验都不做。 */
export function apiRequestSecurity(req: Request, res: Response, next: NextFunction): void {
  if (!isRequestSecurityEnabled()) {
    next();
    return;
  }
  if (!isApiRequestHostAllowed(req.headers.host)) {
    res.status(403).json({ error: "Invalid Host header" });
    return;
  }
  const origin = req.headers.origin;
  const fetchSite = req.headers["sec-fetch-site"] as string | undefined;
  if (shouldCheckApiRequestOrigin(origin, fetchSite)
    && !isApiRequestOriginAllowed(req.headers.host, origin, fetchSite)) {
    res.status(403).json({ error: "Cross-origin API requests are not allowed" });
    return;
  }
  next();
}
