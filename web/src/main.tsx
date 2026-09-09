import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import "./styles.css";
import { AuthProvider, useAuth } from "./auth/AuthContext.tsx";
import { AuthPage, FullscreenNotice } from "./auth/AuthPage.tsx";
import { AppShell } from "./app/AppShell.tsx";
import { SettingsPage } from "./settings/SettingsPage.tsx";

/** 受保护路由：未登录去 /login，未初始化去 /setup。 */
function RequireAuth({ children }: { children: React.ReactNode }) {
  const { phase } = useAuth();
  if (phase === "loading") return <FullscreenNotice>正在加载…</FullscreenNotice>;
  if (phase === "needsSetup") return <Navigate to="/setup" replace />;
  if (phase === "anonymous") return <Navigate to="/login" replace />;
  return <>{children}</>;
}

function Root() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <Routes>
          <Route path="/login" element={<AuthPage mode="login" />} />
          <Route path="/setup" element={<AuthPage mode="setup" />} />
          <Route path="/app" element={<RequireAuth><AppShell /></RequireAuth>} />
          <Route path="/app/c/:conversationId" element={<RequireAuth><AppShell /></RequireAuth>} />
          <Route path="/settings" element={<RequireAuth><SettingsPage /></RequireAuth>} />
          <Route path="*" element={<Navigate to="/app" replace />} />
        </Routes>
      </AuthProvider>
    </BrowserRouter>
  );
}

createRoot(document.getElementById("root")!).render(<StrictMode><Root /></StrictMode>);
