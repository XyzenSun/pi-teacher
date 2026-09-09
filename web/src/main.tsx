import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Navigate, Route, Routes, useLocation } from "react-router-dom";
import "./styles.css";
import { AuthProvider, useAuth } from "./auth/AuthContext.tsx";
import { AuthPage, FullscreenNotice } from "./auth/AuthPage.tsx";
import { AppShell } from "./app/AppShell.tsx";

/** 受保护路由：未登录去 /login，未初始化去 /setup。 */
function RequireAuth({ children }: { children: React.ReactNode }) {
  const { phase } = useAuth();
  if (phase === "loading") return <FullscreenNotice>正在加载…</FullscreenNotice>;
  if (phase === "needsSetup") return <Navigate to="/setup" replace />;
  if (phase === "anonymous") return <Navigate to="/login" replace />;
  return <>{children}</>;
}

/** 旧的 /settings 书签仍要能用，且 ?tab= 必须带过去，否则会丢失用户要看的子页。 */
function LegacySettingsRedirect() {
  return <Navigate to={`/app/settings${useLocation().search}`} replace />;
}

/**
 * 覆盖层（设置 / 日历 / 帮助）是 `/app` 之上的一段路径，由 AppShell 自己解析并
 * 在工作台之上渲染，因此这里用通配路由把整棵 `/app/*` 交给它，而不是逐条列举。
 */
function Root() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <Routes>
          <Route path="/login" element={<AuthPage mode="login" />} />
          <Route path="/setup" element={<AuthPage mode="setup" />} />
          <Route path="/app/*" element={<RequireAuth><AppShell /></RequireAuth>} />
          <Route path="/settings" element={<LegacySettingsRedirect />} />
          <Route path="*" element={<Navigate to="/app" replace />} />
        </Routes>
      </AuthProvider>
    </BrowserRouter>
  );
}

createRoot(document.getElementById("root")!).render(<StrictMode><Root /></StrictMode>);
