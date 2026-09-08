// 移植自 pi-web v0.9.0 lib/request-security.ts（MIT License），改写为 Express
// 中间件形态。pi-teacher 用法见 PRD backend-host-mvp：先信任校验（本文件）
// 后认证——Host 不合法的请求连 401 都不给，防止 DNS rebinding 与跨站请求。
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

/** Express 中间件：Host + Origin/sec-fetch-site 双段校验（先于认证）。 */
export function apiRequestSecurity(req: Request, res: Response, next: NextFunction): void {
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
