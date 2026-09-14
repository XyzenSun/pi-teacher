import { useCallback, useEffect, useState } from "react";
import { configApi } from "../api/client.ts";
import type { UserEnvItem } from "../api/types.ts";
import { ErrorLine, useSubmit } from "../ui/form.tsx";
import { ConfirmDialog } from "../ui/Overlays.tsx";

/**
 * 用户环境变量：SQLite 是唯一源，后端保存后立即写进自己的 process.env，
 * 老师下一次调用 skill 的子进程就能拿到，不用重开对话。
 *
 * 值明文存储、明文回显：数据库本身不加密，界面再遮一层没有意义。内置项是产品自带
 * skill 需要的变量，只能清值不能删行；名字规则由服务端判定，前端只做即时提示。
 */

/** 与后端 user-env.ts 的 KEY_PATTERN 一致，只用于即时提示。 */
const KEY_PATTERN = /^[A-Z_][A-Z0-9_]*$/;

function UserEnvRow({ item, onSaved, onRemove }: {
  item: UserEnvItem;
  onSaved: (items: UserEnvItem[], notice: string) => void;
  onRemove: () => void;
}) {
  const [draft, setDraft] = useState(item.value ?? "");
  const { busy, error, run } = useSubmit();
  const dirty = draft !== (item.value ?? "");
  const canSave = dirty && draft.trim().length > 0;

  const save = () => void run(async () => {
    const result = await configApi.saveUserEnv({ [item.key]: draft });
    onSaved(result.items, `${item.key} 已保存，立即生效。`);
  }).catch(() => {});

  return (
    <div className="card p-3 space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-mono text-[13px] text-on-surface">{item.key}</span>
        {item.builtin && <span className="chip bg-surface-container text-on-surface-variant">内置</span>}
        {item.builtin && !item.configured && <span className="chip bg-surface-container text-on-surface-variant">未设置</span>}
        {item.description && <span className="text-[12px] text-on-surface-variant">{item.description}</span>}
        <button
          type="button"
          className="btn-ghost text-error ml-auto -my-1"
          disabled={item.builtin && !item.configured}
          title={item.builtin ? "清除值（内置项保留在列表中）" : "删除变量"}
          onClick={onRemove}
        >
          {item.builtin ? "清除" : "删除"}
        </button>
      </div>
      <div className="flex items-center gap-2">
        <input
          className="input font-mono"
          spellCheck={false}
          autoComplete="off"
          value={draft}
          disabled={busy}
          placeholder={item.configured ? "" : "尚未设置，输入值后保存"}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => { if (event.key === "Enter" && canSave) save(); }}
        />
        <button type="button" className="btn-outline shrink-0" disabled={busy || !canSave} onClick={save}>
          {busy ? "保存中…" : "保存"}
        </button>
      </div>
      <ErrorLine error={error} />
    </div>
  );
}

function AddUserEnvForm({ existingKeys, onSaved }: {
  existingKeys: Set<string>;
  onSaved: (items: UserEnvItem[], notice: string) => void;
}) {
  const [key, setKey] = useState("");
  const [value, setValue] = useState("");
  const { busy, error, run } = useSubmit();

  const keyHint = key && !KEY_PATTERN.test(key)
    ? "只允许大写字母、数字与下划线，且不能以数字开头"
    : key && existingKeys.has(key) ? "该变量已存在，请直接在上方修改它的值" : null;
  const canSubmit = Boolean(key && value.trim()) && keyHint === null;

  const submit = () => void run(async () => {
    const result = await configApi.saveUserEnv({ [key]: value });
    onSaved(result.items, `${key} 已添加，立即生效。`);
    setKey("");
    setValue("");
  }).catch(() => {});

  return (
    <div className="card p-3 space-y-2">
      <div className="text-[12px] font-medium text-on-surface">添加变量</div>
      <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1.6fr)_auto] gap-2 items-start">
        <div className="space-y-1">
          <input
            className="input font-mono"
            placeholder="变量名，如 MY_SKILL_TOKEN"
            spellCheck={false}
            autoComplete="off"
            value={key}
            disabled={busy}
            onChange={(event) => setKey(event.target.value.toUpperCase())}
          />
          {keyHint && <div className="text-[11px] text-error">{keyHint}</div>}
        </div>
        <input
          className="input font-mono"
          spellCheck={false}
          autoComplete="off"
          placeholder="值"
          value={value}
          disabled={busy}
          onChange={(event) => setValue(event.target.value)}
          onKeyDown={(event) => { if (event.key === "Enter" && canSubmit) submit(); }}
        />
        <button type="button" className="btn-primary" disabled={busy || !canSubmit} onClick={submit}>{busy ? "添加中…" : "添加"}</button>
      </div>
      <ErrorLine error={error} />
    </div>
  );
}

export function UserEnvSection() {
  const [items, setItems] = useState<UserEnvItem[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [removing, setRemoving] = useState<UserEnvItem | null>(null);
  const removeSubmit = useSubmit();

  const load = useCallback(async () => {
    try {
      const result = await configApi.userEnv();
      setItems(result.items);
      setLoadError(null);
    } catch (cause) {
      setLoadError(cause instanceof Error ? cause.message : "加载失败");
    }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const onSaved = (nextItems: UserEnvItem[], message: string) => { setItems(nextItems); setNotice(message); };

  return (
    <section className="space-y-3 border-t border-line pt-5">
      <div>
        <h3 className="font-reading text-[17px] text-primary">用户环境变量</h3>
        <p className="text-[12px] text-on-surface-variant mt-0.5">
          提供给老师调用的 skill（如 Tavily 搜索）以及你自己添加的 skill 使用。保存后立即生效，老师下一次调用 skill 即使用新值，无需重开对话。
          值明文保存在本机数据库。由部署环境管理的变量（<span className="font-mono">PATH</span>、<span className="font-mono">PI_TEACHER_*</span> 等）不能在这里设置。
        </p>
      </div>
      {notice && <div className="text-[13px] text-secondary">{notice}</div>}
      {loadError && !items && <ErrorLine error={loadError} />}
      {!items && !loadError && <div className="text-[13px] text-muted">正在读取…</div>}
      {items && (
        <div className="space-y-2">
          {items.map((item) => (
            // 服务端值变化时用 key 重建行，让输入框回到最新值，不需要额外的同步 effect。
            <UserEnvRow
              key={`${item.key}:${item.value ?? ""}`}
              item={item}
              onSaved={onSaved}
              onRemove={() => { setRemoving(item); removeSubmit.setError(null); }}
            />
          ))}
          <AddUserEnvForm existingKeys={new Set(items.map((item) => item.key))} onSaved={onSaved} />
        </div>
      )}

      {removing && (
        <ConfirmDialog
          title={removing.builtin ? "清除变量值" : "删除变量"}
          danger
          busy={removeSubmit.busy}
          error={removeSubmit.error}
          message={<>
            将把 <span className="font-mono">{removing.key}</span> 立即从运行环境移除，依赖它的 skill 会失败。
            {removing.builtin ? "内置项会保留在列表中，可随时重新填写。" : "该变量会从列表中删除。"}
          </>}
          confirmLabel={removing.builtin ? "清除" : "删除"}
          onCancel={() => { setRemoving(null); removeSubmit.setError(null); }}
          onConfirm={() => void removeSubmit.run(async () => {
            const result = await configApi.removeUserEnv(removing.key);
            setRemoving(null);
            onSaved(result.items, `${removing.key} 已${removing.builtin ? "清除" : "删除"}，已从运行环境移除。`);
          }).catch(() => {})}
        />
      )}
    </section>
  );
}
