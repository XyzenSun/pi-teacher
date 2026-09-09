import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { authApi, onUnauthorized } from "../api/client.ts";

export type AuthPhase = "loading" | "needsSetup" | "anonymous" | "authenticated";

interface AuthContextValue {
  phase: AuthPhase;
  username: string | null;
  refresh: () => Promise<void>;
  login: (username: string, password: string) => Promise<void>;
  setup: (username: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [phase, setPhase] = useState<AuthPhase>("loading");
  const [username, setUsername] = useState<string | null>(null);

  /** 以 status → me 两步判断：status 不需要登录，me 需要；两者组合才能区分四种状态。 */
  const refresh = useCallback(async () => {
    const { needsSetup } = await authApi.status();
    if (needsSetup) { setPhase("needsSetup"); setUsername(null); return; }
    try {
      const me = await authApi.me();
      if (me.username) { setUsername(me.username); setPhase("authenticated"); return; }
    } catch { /* 401 → 匿名 */ }
    setUsername(null);
    setPhase("anonymous");
  }, []);

  useEffect(() => { void refresh().catch(() => setPhase("anonymous")); }, [refresh]);
  useEffect(() => onUnauthorized(() => { setUsername(null); setPhase("anonymous"); }), []);

  const value = useMemo<AuthContextValue>(() => ({
    phase, username, refresh,
    login: async (name, password) => { const result = await authApi.login(name, password); setUsername(result.username); setPhase("authenticated"); },
    setup: async (name, password) => { const result = await authApi.setup(name, password); setUsername(result.username); setPhase("authenticated"); },
    logout: async () => { await authApi.logout(); setUsername(null); setPhase("anonymous"); },
  }), [phase, username, refresh]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const value = useContext(AuthContext);
  if (!value) throw new Error("useAuth 必须在 AuthProvider 内使用");
  return value;
}
