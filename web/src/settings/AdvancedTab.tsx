import { useCallback, useEffect, useState } from "react";
import { configApi } from "../api/client.ts";
import type { ModelsConfigResponse, PiSettingsResponse, ReminderKind } from "../api/types.ts";
import { ErrorLine, Field, useSubmit } from "../ui/form.tsx";
import { UserEnvSection } from "./UserEnvSection.tsx";

/**
 * 高级配置：settings.json 的白名单字段 + 业务运行设置（setting 表）+ models.json 的脱敏 JSON 视图。
 *
 * 这里不做「任意文件编辑器」：能写的只有后端白名单接受的字段，JSON 视图里凭据
 * 显示为掩码，原样提交等于「保持不变」（后端的三态语义），因此可以安全地把脱敏
 * 结果交给用户编辑再回传。
 */

function ProviderJsonEditor({ providerId, secretMaskHint, onSaved }: {
  providerId: string;
  secretMaskHint: string;
  onSaved: (warnings: string[]) => void;
}) {
  const [text, setText] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const { busy, error, setError, run } = useSubmit();

  useEffect(() => {
    let cancelled = false;
    setText(null);
    setLoadError(null);
    setError(null);
    void configApi.providerJson(providerId)
      .then((result) => { if (!cancelled) setText(JSON.stringify(result.provider, null, 2)); })
      .catch((cause: unknown) => { if (!cancelled) setLoadError(cause instanceof Error ? cause.message : "读取失败"); });
    return () => { cancelled = true; };
  }, [providerId, setError]);

  const submit = () => void run(async () => {
    if (text === null) return;
    let parsed: unknown;
    // 先在前端 parse，语法错误能立刻定位到行；服务端仍会二次解析并按白名单校验。
    try { parsed = JSON.parse(text); } catch (cause) { throw new Error(`JSON 语法错误：${cause instanceof Error ? cause.message : String(cause)}`); }
    const result = await configApi.saveProviderJson(providerId, parsed);
    onSaved(result.warnings);
  }).catch(() => {});

  if (loadError) return <ErrorLine error={loadError} />;
  if (text === null) return <div className="text-[13px] text-muted">正在读取…</div>;

  return (
    <div className="space-y-2">
      <textarea
        className="input font-mono text-[12px] leading-[1.55]"
        rows={16}
        spellCheck={false}
        value={text}
        onChange={(event) => setText(event.target.value)}
      />
      <div className="text-[11px] text-muted">
        凭据显示为 <span className="font-mono">{secretMaskHint}</span>，原样提交表示保持不变；要清除凭据请把该字段值改为 <span className="font-mono">null</span>。
        只有 <span className="font-mono">name / api / baseUrl / apiKey / headers / models</span> 会被写入，其余字段按原值保留。
      </div>
      <ErrorLine error={error} />
      <div className="flex justify-end">
        <button type="button" className="btn-primary" disabled={busy} onClick={submit}>{busy ? "保存中…" : "保存 JSON"}</button>
      </div>
    </div>
  );
}

/**
 * 维护提醒间隔：存在 pi-teacher 自己的 setting 表，不进 settings.json。
 * 失焦或 Enter 才保存；输入非法时不发请求，恢复成当前生效值并提示。
 */
function ReminderIntervalField({ value, onSaved }: { value: number; onSaved: (app: PiSettingsResponse["app"], message: string) => void }) {
  const [text, setText] = useState(String(value));
  const { busy, error, setError, run } = useSubmit();
  useEffect(() => { setText(String(value)); }, [value]);

  const submit = () => {
    const next = Number(text.trim());
    if (text.trim() === "" || !Number.isInteger(next) || next < 0) {
      setText(String(value));
      setError("请输入 0 或正整数（0 表示关闭）");
      return;
    }
    if (next === value) return;
    void run(async () => {
      const result = await configApi.saveSettings({ reminderIntervalTurns: next });
      onSaved(result.app, next === 0 ? "已关闭维护提醒。" : `每 ${next} 轮追加维护提醒；学习对话同轮提醒维护精华。`);
    }).catch(() => setText(String(value)));
  };

  return (
    <div className="space-y-1">
      <Field label="维护提醒间隔（轮）" hint="每隔多少轮对话，在你的消息末尾追加维护提醒；学习对话同轮追加精华提醒。0 关闭全部提醒。改动对已打开的对话立即生效。">
        <input
          className="input max-w-[160px] font-mono"
          type="number"
          min={0}
          step={1}
          inputMode="numeric"
          value={text}
          disabled={busy}
          onChange={(event) => { setText(event.target.value); setError(null); }}
          onBlur={submit}
          onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); event.currentTarget.blur(); } }}
        />
      </Field>
      <ErrorLine error={error} />
    </div>
  );
}

/** 与后端 app-settings.ts 的 REMINDER_TEXT_MAX_LENGTH 一致；前端只提前提示，拒绝仍由服务端判定。 */
const REMINDER_TEXT_MAX_LENGTH = 4000;

const REMINDER_KIND_LABELS: Record<ReminderKind, { label: string; hint: string }> = {
  makeCardOn: { label: "学习 / 复习（制卡开启）", hint: "学习与复习对话且制卡开关开启时附加的提醒。" },
  makeCardOff: { label: "学习 / 复习（制卡关闭）", hint: "学习与复习对话且制卡开关关闭时附加的提醒。" },
  ta: { label: "助教", hint: "助教对话附加的提醒；助教不维护全局偏好与用户信息，只维护「用户对你的要求」。" },
  learningEssence: { label: "学习精华", hint: "仅在学习对话的基础提醒后同轮追加，无论制卡是否开启；助教与复习不追加。老师按需维护 essence/，不要求每次写文件。" },
};

/**
 * 维护提醒文案：整段原样拼到用户消息末尾，含 <system-reminder> 标签。
 * 后端把空串视为「恢复出厂文案」并删行，所以「恢复默认」就是提交空串，回包里带的是出厂文案。
 */
function ReminderTextField({ kind, value, onSaved }: {
  kind: ReminderKind;
  value: string;
  onSaved: (app: PiSettingsResponse["app"], message: string) => void;
}) {
  const [text, setText] = useState(value);
  const { busy, error, setError, run } = useSubmit();
  useEffect(() => { setText(value); }, [value]);

  const { label, hint } = REMINDER_KIND_LABELS[kind];
  const overLimit = text.length > REMINDER_TEXT_MAX_LENGTH;
  const dirty = text !== value;

  const save = (next: string) => void run(async () => {
    const result = await configApi.saveSettings({ reminderTexts: { [kind]: next } });
    // 原值已是默认时，父组件 value 不会变化，仍需清掉本地未保存的草稿。
    setText(result.app.reminderTexts[kind]);
    onSaved(result.app, next.trim() ? `「${label}」提醒文案已保存，下一轮命中时生效。` : `「${label}」提醒文案已恢复默认。`);
  }).catch(() => {});

  return (
    <div className="space-y-1">
      <Field label={label} hint={hint}>
        <textarea
          className="input font-mono text-[12px] leading-[1.55]"
          rows={4}
          spellCheck={false}
          value={text}
          disabled={busy}
          onChange={(event) => { setText(event.target.value); setError(null); }}
        />
      </Field>
      <div className="flex items-center gap-2">
        <span className={`text-[11px] ${overLimit ? "text-error" : "text-muted"}`}>
          {text.length} / {REMINDER_TEXT_MAX_LENGTH} 字符{overLimit ? "，超出上限，请精简后再保存" : ""}
        </span>
        <button type="button" className="btn-ghost py-1 ml-auto" disabled={busy} onClick={() => save("")}>恢复默认</button>
        <button type="button" className="btn-primary py-1" disabled={busy || overLimit || !dirty || !text.trim()} onClick={() => save(text)}>
          {busy ? "保存中…" : "保存"}
        </button>
      </div>
      <ErrorLine error={error} />
    </div>
  );
}

export function AdvancedTab() {
  const [settings, setSettings] = useState<PiSettingsResponse | null>(null);
  const [models, setModels] = useState<ModelsConfigResponse | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [retryEnabled, setRetryEnabled] = useState(true);
  const [jsonProviderId, setJsonProviderId] = useState("");
  const retrySubmit = useSubmit();

  const load = useCallback(async () => {
    try {
      const [settingsResult, modelsResult] = await Promise.all([configApi.settings(), configApi.models()]);
      setSettings(settingsResult);
      setModels(modelsResult);
      setRetryEnabled(settingsResult.settings.retryEnabled);
      setJsonProviderId((current) => current || modelsResult.providers[0]?.id || "");
      setLoadError(null);
    } catch (cause) {
      setLoadError(cause instanceof Error ? cause.message : "加载失败");
    }
  }, []);
  useEffect(() => { void load(); }, [load]);

  if (loadError && !settings) return <ErrorLine error={loadError} />;
  if (!settings || !models) return <div className="text-[13px] text-muted">正在读取 Pi 配置…</div>;

  const retry = settings.settings.retry;

  return (
    <div className="space-y-6">
      <section className="space-y-3">
        <div>
          <h3 className="font-reading text-[17px] text-primary">Pi 运行设置</h3>
          <p className="text-[12px] text-on-surface-variant mt-0.5">
            写入 Pi 的 <span className="font-mono">settings.json</span>，只修改这里列出的字段，其余由 Pi 自身管理的配置不受影响。
          </p>
        </div>
        {notice && <div className="text-[13px] text-secondary">{notice}</div>}

        <label className="flex items-start gap-2 text-[13px]">
          <input
            type="checkbox"
            className="accent-secondary w-4 h-4 mt-0.5"
            checked={retryEnabled}
            disabled={retrySubmit.busy}
            onChange={(event) => {
              const next = event.target.checked;
              setRetryEnabled(next);
              void retrySubmit.run(async () => {
                const result = await configApi.saveSettings({ retryEnabled: next });
                setSettings((current) => (current ? { ...current, settings: result.settings } : current));
                setNotice(next ? "已开启模型请求自动重试。" : "已关闭模型请求自动重试。");
              }).catch(() => setRetryEnabled(!next));
            }}
          />
          <span>
            模型请求失败时自动重试
            <span className="block text-[11px] text-muted">
              当前生效参数：最多 {retry.maxRetries} 次，基础退避 {retry.baseDelayMs}ms，最大退避 {retry.provider.maxRetryDelayMs}ms
              {retry.provider.timeoutMs !== undefined ? `，超时 ${retry.provider.timeoutMs}ms` : ""}。这些明细由 Pi 管理，本页只切换开关。
            </span>
          </span>
        </label>
        <ErrorLine error={retrySubmit.error} />

        <div className="grid grid-cols-2 gap-3 max-w-[560px]">
          <Field label="默认 Provider" hint="在「模型与 Provider」页修改">
            <input className="input font-mono" readOnly value={settings.settings.defaultProvider ?? "未设置"} />
          </Field>
          <Field label="默认模型" hint={settings.defaultModel.source === "env" ? "由部署环境变量固定" : "在「模型与 Provider」页修改"}>
            <input className="input font-mono" readOnly value={settings.settings.defaultModel ?? "未设置"} />
          </Field>
        </div>
      </section>

      <section className="space-y-3 border-t border-line pt-5">
        <div>
          <h3 className="font-reading text-[17px] text-primary">教学运行设置</h3>
          <p className="text-[12px] text-on-surface-variant mt-0.5">
            Pi Teacher 自己的运行参数，存在数据库里，不写入 Pi 的配置文件。
          </p>
        </div>
        <ReminderIntervalField
          value={settings.app.reminderIntervalTurns}
          onSaved={(app, message) => { setSettings((current) => (current ? { ...current, app } : current)); setNotice(message); }}
        />
        <div className="space-y-3">
          <div className="text-[12px] text-on-surface-variant">
            提醒文案会整段附在你的消息末尾（保留 <span className="font-mono">&lt;system-reminder&gt;</span> 标签）。按对话类型与制卡开关选用一段基础提醒，学习对话再同轮追加「学习精华」。
            点击「恢复默认」可还原该段出厂文案；改动对已打开的对话下一轮命中时生效。
          </div>
          {(Object.keys(REMINDER_KIND_LABELS) as ReminderKind[]).map((kind) => (
            <ReminderTextField
              key={kind}
              kind={kind}
              value={settings.app.reminderTexts[kind]}
              onSaved={(app, message) => { setSettings((current) => (current ? { ...current, app } : current)); setNotice(message); }}
            />
          ))}
        </div>
      </section>

      <section className="space-y-3 border-t border-line pt-5">
        <div>
          <h3 className="font-reading text-[17px] text-primary">Provider JSON</h3>
          <p className="text-[12px] text-on-surface-variant mt-0.5">
            以 JSON 形式核对与编辑单个 Provider 的定义，适合批量修改模型列表。结构化表单在「模型与 Provider」页。
          </p>
        </div>
        {models.providers.length === 0 ? (
          <div className="text-[13px] text-muted">models.json 中还没有 Provider，先到「模型与 Provider」页新增。</div>
        ) : (
          <>
            <Field label="选择 Provider">
              <select className="input max-w-[320px]" value={jsonProviderId} onChange={(event) => setJsonProviderId(event.target.value)}>
                {models.providers.map((provider) => <option key={provider.id} value={provider.id}>{provider.id}</option>)}
              </select>
            </Field>
            {jsonProviderId && (
              <ProviderJsonEditor
                key={jsonProviderId}
                providerId={jsonProviderId}
                secretMaskHint={models.secretMask}
                onSaved={(warnings) => { setNotice(warnings.length ? warnings.join("；") : `${jsonProviderId} 已保存，模型目录已刷新。`); void load(); }}
              />
            )}
          </>
        )}
      </section>

      <UserEnvSection />
    </div>
  );
}
