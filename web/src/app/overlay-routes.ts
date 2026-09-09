import { useLocation } from "react-router-dom";

/**
 * 工作台路由解析：覆盖层（设置 / 日历 / 帮助）是 `/app` 之上的一段路径，
 * 背景路由继续渲染，所以刷新、直接访问与前进后退都能回到同一状态。
 *
 * 不用嵌套 <Route> + <Outlet> 的原因：AppShell 由 `/app` 这一层渲染，
 * React Router 的 useParams 只给出该层匹配到的参数，拿不到子路由里的
 * :conversationId。这里统一解析 pathname，工作台与覆盖层共用同一份判断。
 */

export type OverlayKind = "settings" | "calendar" | "help";

const OVERLAY_KINDS: readonly OverlayKind[] = ["settings", "calendar", "help"];

/** `/app`、`/app/settings`、`/app/c/12`、`/app/c/12/help` 四种形态。 */
const WORKSPACE_PATH = /^\/app(?:\/c\/(\d+))?(?:\/(settings|calendar|help))?\/?$/;

export interface WorkspaceRoute {
  conversationId: number | null;
  overlay: OverlayKind | null;
  /** 关闭覆盖层后回到的路径（工作台本体）。 */
  basePath: string;
  /** 路径是否为合法的工作台形态；否则调用方应重定向到 /app。 */
  valid: boolean;
}

export function parseWorkspacePath(pathname: string): WorkspaceRoute {
  const match = WORKSPACE_PATH.exec(pathname);
  if (!match) return { conversationId: null, overlay: null, basePath: "/app", valid: false };
  const conversationId = match[1] ? Number(match[1]) : null;
  const overlay = OVERLAY_KINDS.find((kind) => kind === match[2]) ?? null;
  return {
    conversationId,
    overlay,
    basePath: conversationId === null ? "/app" : `/app/c/${conversationId}`,
    valid: true,
  };
}

export function useWorkspaceRoute(): WorkspaceRoute {
  return parseWorkspacePath(useLocation().pathname);
}

export function useWorkspaceBasePath(): string {
  return useWorkspaceRoute().basePath;
}

/** 覆盖层入口统一用这个函数拼路径，避免各处手写字符串拼接出错。 */
export function overlayPath(basePath: string, overlay: OverlayKind, search?: string): string {
  return `${basePath}/${overlay}${search ?? ""}`;
}
