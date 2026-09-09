import { useCallback, useEffect, useState } from "react";
import { configApi } from "../api/client.ts";
import type { ModelsConfigResponse, ProviderConfigView, ProviderPatch } from "../api/types.ts";
import { ErrorLine, Field, useSubmit } from "../ui/form.tsx";
import { ConfirmDialog, Modal } from "../ui/Overlays.tsx";

/**
 * 模型与 Provider 配置：直接编辑 Pi 的 models.json 与默认模型。
 *
 * 凭据永远不从后端出网：界面上只知道「已配置 / 未配置」。留空提交表示保持原值，
 * 清除必须显式点「清除凭据」，避免误清；这与后端的三态语义一一对应。
 */

interface ProviderDraft {
  id: string;
  name: string;
  api: string;
  baseUrl: string;
  apiKey: string;
  clearApiKey: boolean;
  models: Array<{ id: string; name: string }>;
}

function draftFrom(provider: ProviderConfigView | null, knownApis: string[]): ProviderDraft {
  return {
    id: provider?.id ?? "",
    name: provider?.name ?? "",
    api: provider?.api ?? knownApis[0] ?? "",
    baseUrl: provider?.baseUrl ?? "",
    apiKey: "",
    clearApiKey: false,
    models: (provider?.models ?? []).map((model) => ({ id: model.id, name: model.name ?? "" })),
  };
}

function ProviderEditor({ draft, config, isNew, onClose, onSaved }: {
  draft: ProviderDraft;
  config: ModelsConfigResponse;
  isNew: boolean;
  onClose: () => void;
  onSaved: (warnings: string[]) => void;
}) {
  const [state, setState] = useState(draft);
  const { busy, error, run } = useSubmit();

  const buildPatch = (): ProviderPatch => {
    const patch: ProviderPatch = {
      name: state.name.trim() || null,
      api: state.api,
      baseUrl: state.baseUrl.trim() || null,
      models: state.models
        .filter((model) => model.id.trim())
        .map((model) => ({ id: model.id.trim(), name: model.name.trim() || null })),
    };
    // 三态：勾选清除 → null；填了新值 → 覆盖；两者都没有 → 字段缺省，后端保持原值。
    if (state.clearApiKey) patch.apiKey = null;
    else if (state.apiKey.trim()) patch.apiKey = state.apiKey.trim();
    return patch;
  };

  const submit = () => void run(async () => {
    const result = await configApi.saveProvider(state.id.trim(), buildPatch());
    onSaved(result.warnings);
  }).catch(() => {});

  const existing = config.providers.find((provider) => provider.id === state.id.trim());

  return (
    <Modal
      title={isNew ? "新增 Provider" : `编辑 Provider：${state.id}`}
      size="lg"
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn-ghost" disabled={busy} onClick={onClose}>取消</button>
          <button type="button" className="btn-primary" disabled={busy || !state.id.trim() || !state.api} onClick={submit}>
            {busy ? "保存中…" : "保存"}
          </button>
        </>
      }
    >
      <div className="space-y-4">
        <Field label="Provider 标识" hint="写入 models.json 的键名，创建后不可改名（改名请新建后删除旧项）。">
          <input
            className="input font-mono"
            value={state.id}
            disabled={!isNew}
            placeholder="如：openrouter"
            onChange={(event) => setState({ ...state, id: event.target.value })}
          />
        </Field>
        <Field label="显示名称（可选）">
          <input className="input" value={state.name} onChange={(event) => setState({ ...state, name: event.target.value })} />
        </Field>
        <Field label="API 类型" hint="必须是 Pi 支持的协议之一；填错会在真正请求时才失败，因此这里只能选。">
          <select className="input" value={state.api} onChange={(event) => setState({ ...state, api: event.target.value })}>
            {config.knownApis.map((api) => <option key={api} value={api}>{api}</option>)}
          </select>
        </Field>
        <Field label="Base URL" hint="自定义模型必须提供 Base URL，否则 Pi 无法加载该 Provider。">
          <input className="input font-mono" value={state.baseUrl} placeholder="https://…/v1" onChange={(event) => setState({ ...state, baseUrl: event.target.value })} />
        </Field>

        <Field
          label="API Key"
          hint={existing?.apiKeyConfigured
            ? "已配置。留空表示保持现有凭据不变；服务端不会把凭据回传浏览器。"
            : "尚未配置。留空表示不设置凭据。"}
        >
          <input
            className="input font-mono"
            type="password"
            value={state.apiKey}
            disabled={state.clearApiKey}
            placeholder={existing?.apiKeyConfigured ? config.secretMask : "sk-…"}
            autoComplete="new-password"
            onChange={(event) => setState({ ...state, apiKey: event.target.value })}
          />
        </Field>
        {existing?.apiKeyConfigured && (
          <label className="flex items-center gap-2 text-[13px]">
            <input
              type="checkbox"
              className="accent-secondary w-4 h-4"
              checked={state.clearApiKey}
              onChange={(event) => setState({ ...state, clearApiKey: event.target.checked, apiKey: "" })}
            />
            清除已保存的 API Key
          </label>
        )}
        {existing && existing.headerNames.length > 0 && (
          <div className="text-[12px] text-on-surface-variant">
            该 Provider 配置了自定义请求头：<span className="font-mono">{existing.headerNames.join("、")}</span>
            （头部的值同样不回传浏览器，需要修改请直接编辑 models.json）。
          </div>
        )}
        {existing && existing.advancedKeys.length > 0 && (
          <div className="text-[12px] text-on-surface-variant">
            该 Provider 还含有高级字段：<span className="font-mono">{existing.advancedKeys.join("、")}</span>，保存时会原样保留。
          </div>
        )}

        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <span className="label">模型列表</span>
            <button type="button" className="btn-ghost text-[12px]" onClick={() => setState({ ...state, models: [...state.models, { id: "", name: "" }] })}>
              <span className="icon text-[16px]">add</span>添加模型
            </button>
          </div>
          {state.models.length === 0 && <div className="text-[12px] text-muted">没有自定义模型；Pi 会使用该 Provider 的内置目录。</div>}
          {state.models.map((model, index) => (
            <div key={index} className="flex items-center gap-2">
              <input
                className="input font-mono flex-1"
                value={model.id}
                placeholder="模型 id"
                onChange={(event) => setState({
                  ...state,
                  models: state.models.map((item, position) => (position === index ? { ...item, id: event.target.value } : item)),
                })}
              />
              <input
                className="input flex-1"
                value={model.name}
                placeholder="显示名称（可选）"
                onChange={(event) => setState({
                  ...state,
                  models: state.models.map((item, position) => (position === index ? { ...item, name: event.target.value } : item)),
                })}
              />
              <button
                type="button"
                className="icon text-[18px] text-muted hover:text-error"
                title="移除该模型"
                onClick={() => setState({ ...state, models: state.models.filter((_, position) => position !== index) })}
              >
                delete
              </button>
            </div>
          ))}
          <div className="text-[11px] text-muted">模型条目的 cost、contextWindow 等高级字段不在此编辑，保存时原样保留。</div>
        </div>

        <ErrorLine error={error} />
      </div>
    </Modal>
  );
}

export function ModelProvidersTab() {
  const [config, setConfig] = useState<ModelsConfigResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ draft: ProviderDraft; isNew: boolean } | null>(null);
  const [removing, setRemoving] = useState<ProviderConfigView | null>(null);
  const removeSubmit = useSubmit();
  const defaultSubmit = useSubmit();

  const load = useCallback(async () => {
    try { setConfig(await configApi.models()); setError(null); } catch (cause) { setError(cause instanceof Error ? cause.message : "加载失败"); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  if (error && !config) return <ErrorLine error={error} />;
  if (!config) return <div className="text-[13px] text-muted">正在读取 Pi 配置…</div>;

  const defaultValue = config.defaultModel.provider && config.defaultModel.modelId
    ? `${config.defaultModel.provider}/${config.defaultModel.modelId}`
    : "";
  const defaultOptions = config.providers.flatMap((provider) =>
    provider.models.map((model) => ({ value: `${provider.id}/${model.id}`, label: `${provider.name ?? provider.id} · ${model.name ?? model.id}` })));

  return (
    <div className="space-y-6">
      <section className="space-y-2">
        <div className="flex items-center justify-between">
          <div>
            <h3 className="font-reading text-[17px] text-primary">默认模型</h3>
            <p className="text-[12px] text-on-surface-variant mt-0.5">
              {config.defaultModel.source === "env"
                ? "当前由部署环境变量固定，界面修改不会生效。"
                : "新建对话默认使用的模型；已经在运行的对话不受影响。"}
            </p>
          </div>
        </div>
        <select
          className="input max-w-[420px]"
          value={defaultValue}
          disabled={!config.defaultModel.editable || defaultSubmit.busy}
          title={config.defaultModel.editable ? "设置默认模型" : "由部署环境变量固定"}
          onChange={(event) => {
            const [provider, ...rest] = event.target.value.split("/");
            void defaultSubmit.run(async () => {
              await configApi.setDefaultModel(provider, rest.join("/"));
              await load();
              setNotice("默认模型已更新。");
            }).catch(() => {});
          }}
        >
          {!defaultValue && <option value="">未设置</option>}
          {defaultOptions.length === 0 && <option value={defaultValue}>{defaultValue || "当前配置中没有可选模型"}</option>}
          {defaultOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
        </select>
        <ErrorLine error={defaultSubmit.error} />
      </section>

      <section className="space-y-3 border-t border-line pt-5">
        <div className="flex items-center justify-between">
          <div>
            <h3 className="font-reading text-[17px] text-primary">Provider</h3>
            <p className="text-[12px] text-on-surface-variant mt-0.5">直接写入 Pi 的 models.json；保存后模型目录会立即刷新。</p>
          </div>
          <button type="button" className="btn-secondary" onClick={() => setEditing({ draft: draftFrom(null, config.knownApis), isNew: true })}>
            <span className="icon text-[16px]">add</span>新增 Provider
          </button>
        </div>
        {notice && <div className="text-[13px] text-secondary">{notice}</div>}
        <ErrorLine error={error} />
        {config.providers.length === 0 && <div className="text-[13px] text-muted">models.json 中还没有自定义 Provider。</div>}
        <div className="space-y-2">
          {config.providers.map((provider) => (
            <div key={provider.id} className="card p-3 flex items-start justify-between gap-3">
              <div className="min-w-0 space-y-1">
                <div className="flex items-center gap-2">
                  <span className="text-[14px] font-medium text-primary truncate">{provider.name ?? provider.id}</span>
                  <span className="chip bg-surface-container text-on-surface-variant font-mono">{provider.id}</span>
                  {provider.api && (
                    <span className={`chip ${provider.apiUnknown ? "bg-error-container text-on-error-container" : "bg-secondary-container text-on-secondary-container"}`}>
                      {provider.api}{provider.apiUnknown ? "（Pi 不认识该协议）" : ""}
                    </span>
                  )}
                  <span className={`chip ${provider.apiKeyConfigured ? "bg-secondary-container text-on-secondary-container" : "bg-surface-container text-on-surface-variant"}`}>
                    {provider.apiKeyConfigured ? "凭据已配置" : "无凭据"}
                  </span>
                </div>
                <div className="text-[12px] text-on-surface-variant font-mono truncate">{provider.baseUrl ?? "未设置 Base URL"}</div>
                <div className="text-[12px] text-muted truncate">
                  {provider.models.length ? `${provider.models.length} 个模型：${provider.models.map((model) => model.id).join("、")}` : "使用内置模型目录"}
                </div>
              </div>
              <div className="flex items-center gap-1 shrink-0">
                <button type="button" className="btn-ghost text-[12px]" onClick={() => setEditing({ draft: draftFrom(provider, config.knownApis), isNew: false })}>编辑</button>
                <button type="button" className="btn-danger text-[12px]" onClick={() => setRemoving(provider)}>删除</button>
              </div>
            </div>
          ))}
        </div>
      </section>

      {editing && (
        <ProviderEditor
          draft={editing.draft}
          config={config}
          isNew={editing.isNew}
          onClose={() => setEditing(null)}
          onSaved={(warnings) => {
            setEditing(null);
            setNotice(warnings.length ? warnings.join("；") : "Provider 已保存，模型目录已刷新。");
            void load();
          }}
        />
      )}

      {removing && (
        <ConfirmDialog
          title="删除 Provider"
          danger
          busy={removeSubmit.busy}
          error={removeSubmit.error}
          message={<>将从 models.json 中删除 <span className="font-mono">{removing.id}</span> 及其模型与凭据配置。使用该 Provider 的历史对话不会被修改，但重新打开时可能无法启动模型。</>}
          confirmLabel="删除"
          onCancel={() => { setRemoving(null); removeSubmit.setError(null); }}
          onConfirm={() => void removeSubmit.run(async () => {
            await configApi.removeProvider(removing.id);
            setRemoving(null);
            setNotice("Provider 已删除，模型目录已刷新。");
            await load();
          }).catch(() => {})}
        />
      )}
    </div>
  );
}
