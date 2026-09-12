import { useState } from "react";
import { authApi } from "../api/client.ts";
import { useAuth } from "../auth/AuthContext.tsx";
import { ErrorLine, Field, useSubmit } from "../ui/form.tsx";

/**
 * 账号设置：改用户名与改密码。
 *
 * 两个操作都要求当前密码——cookie 被盗时不能让攻击者悄悄改掉账号标识或密码。
 * 改密成功后后端会失效其他登录态并给本浏览器换发新 token，所以这里不需要重新登录。
 */
export function AccountTab() {
  const auth = useAuth();
  const [name, setName] = useState(auth.username ?? "");
  const [namePassword, setNamePassword] = useState("");
  const [nameDone, setNameDone] = useState(false);
  const nameSubmit = useSubmit();

  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [passwordDone, setPasswordDone] = useState(false);
  const passwordSubmit = useSubmit();

  const passwordMismatch = confirmPassword.length > 0 && newPassword !== confirmPassword;

  const submitName = () => void nameSubmit.run(async () => {
    const result = await authApi.changeUsername(name.trim(), namePassword);
    setNamePassword("");
    setNameDone(true);
    setName(result.username);
    await auth.refresh();
  }).catch(() => setNameDone(false));

  const submitPassword = () => void passwordSubmit.run(async () => {
    if (newPassword !== confirmPassword) throw new Error("两次输入的新密码不一致");
    await authApi.changePassword(currentPassword, newPassword);
    setCurrentPassword("");
    setNewPassword("");
    setConfirmPassword("");
    setPasswordDone(true);
  }).catch(() => setPasswordDone(false));

  return (
    <div className="space-y-8 max-w-[520px]">
      <section className="space-y-3">
        <div>
          <h3 className="font-reading text-[17px] text-primary">修改用户名</h3>
          <p className="text-[12px] text-on-surface-variant mt-0.5">当前用户名：{auth.username ?? "—"}</p>
        </div>
        <Field label="新用户名">
          <input className="input" value={name} maxLength={100} autoComplete="username" onChange={(event) => { setName(event.target.value); setNameDone(false); }} />
        </Field>
        <Field label="当前密码" hint="修改账号信息需要验证当前密码。">
          <input className="input" type="password" value={namePassword} autoComplete="current-password" onChange={(event) => { setNamePassword(event.target.value); setNameDone(false); }} />
        </Field>
        <ErrorLine error={nameSubmit.error} />
        {nameDone && <div className="text-[13px] text-secondary">用户名已更新。</div>}
        <button
          type="button"
          className="btn-primary"
          disabled={nameSubmit.busy || !name.trim() || name.trim() === auth.username || !namePassword}
          onClick={submitName}
        >
          {nameSubmit.busy ? "保存中…" : "保存用户名"}
        </button>
      </section>

      <section className="space-y-3 border-t border-line pt-6">
        <div>
          <h3 className="font-reading text-[17px] text-primary">修改密码</h3>
          <p className="text-[12px] text-on-surface-variant mt-0.5">保存后其他设备上的登录会立即失效，当前浏览器保持登录。</p>
        </div>
        <Field label="当前密码">
          <input className="input" type="password" value={currentPassword} autoComplete="current-password" onChange={(event) => { setCurrentPassword(event.target.value); setPasswordDone(false); }} />
        </Field>
        <Field label="新密码" hint="至少 6 位。">
          <input className="input" type="password" value={newPassword} autoComplete="new-password" onChange={(event) => { setNewPassword(event.target.value); setPasswordDone(false); }} />
        </Field>
        <Field label="确认新密码">
          <input className="input" type="password" value={confirmPassword} autoComplete="new-password" onChange={(event) => { setConfirmPassword(event.target.value); setPasswordDone(false); }} />
        </Field>
        {passwordMismatch && <div className="text-[13px] text-error">两次输入的新密码不一致。</div>}
        <ErrorLine error={passwordSubmit.error} />
        {passwordDone && <div className="text-[13px] text-secondary">密码已更新，其他设备需要重新登录。</div>}
        <button
          type="button"
          className="btn-primary"
          disabled={passwordSubmit.busy || !currentPassword || newPassword.length < 6 || passwordMismatch || !confirmPassword}
          onClick={submitPassword}
        >
          {passwordSubmit.busy ? "保存中…" : "保存新密码"}
        </button>
      </section>
    </div>
  );
}
