import { useCallback, useEffect, useState } from "react";
import { configApi } from "../api/client.ts";
import type { ModelsConfigResponse, PiSettingsResponse } from "../api/types.ts";
import { ErrorLine, Field, useSubmit } from "../ui/form.tsx";

/**
 * 高级配置：settings.json 的白名单字段 + models.json 的脱敏 JSON 视图。
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
    </div>
  );
}
