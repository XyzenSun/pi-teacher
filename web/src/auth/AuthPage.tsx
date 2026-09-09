import { useState, type FormEvent } from "react";
import { Navigate } from "react-router-dom";
import { useAuth } from "./AuthContext.tsx";

/** 登录与初始化共用同一表单，只有标题、按钮与密码确认不同。 */
export function AuthPage({ mode }: { mode: "login" | "setup" }) {
  const auth = useAuth();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (auth.phase === "loading") return <FullscreenNotice>正在检查登录状态…</FullscreenNotice>;
  if (auth.phase === "authenticated") return <Navigate to="/app" replace />;
  if (mode === "login" && auth.phase === "needsSetup") return <Navigate to="/setup" replace />;
  if (mode === "setup" && auth.phase === "anonymous") return <Navigate to="/login" replace />;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    if (mode === "setup" && password !== confirm) { setError("两次输入的密码不一致"); return; }
    setBusy(true);
    try {
      if (mode === "setup") await auth.setup(username.trim(), password);
      else await auth.login(username.trim(), password);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "操作失败");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="min-h-full flex items-center justify-center bg-surface">
      <form onSubmit={submit} className="card w-[380px] p-8 space-y-5">
        <div>
          <div className="font-reading text-[28px] text-primary">Pi Teacher</div>
          <div className="text-on-surface-variant text-[13px] mt-1">
            {mode === "setup" ? "首次使用：创建你的本地账号" : "登录以继续学习"}
          </div>
        </div>
        <label className="block space-y-1">
          <span className="label">用户名</span>
          <input className="input" value={username} onChange={(event) => setUsername(event.target.value)} autoComplete="username" autoFocus required />
        </label>
        <label className="block space-y-1">
          <span className="label">密码{mode === "setup" ? "（至少 6 位）" : ""}</span>
          <input className="input" type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete={mode === "setup" ? "new-password" : "current-password"} minLength={mode === "setup" ? 6 : undefined} required />
        </label>
        {mode === "setup" && (
          <label className="block space-y-1">
            <span className="label">确认密码</span>
            <input className="input" type="password" value={confirm} onChange={(event) => setConfirm(event.target.value)} autoComplete="new-password" required />
          </label>
        )}
        {error && <div className="text-error text-[13px]">{error}</div>}
        <button className="btn-primary w-full justify-center" disabled={busy}>
          {busy ? "处理中…" : mode === "setup" ? "创建账号并进入" : "登录"}
        </button>
      </form>
    </div>
  );
}

export function FullscreenNotice({ children }: { children: React.ReactNode }) {
  return <div className="min-h-full flex items-center justify-center text-on-surface-variant text-[13px]">{children}</div>;
}
