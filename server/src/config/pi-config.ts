/**
 * Pi 配置读写（`~/.pi/agent/models.json` 与 `settings.json`）的唯一入口。
 *
 * 集中在这一个模块的原因：models.json 内嵌 provider 凭据，一旦读写逻辑散落到多个
 * 路由，就很难保证每条出口都做了脱敏。这里的约定是——
 *   出口：只给「是否已配置」，绝不给真实值、长度、前后缀，也不给 `$VAR` / `!command`
 *         这类引用形式本身（否则等于泄漏环境变量名或命令行）。
 *   入口：三态语义（缺省=保持、非空字符串=覆盖、null=清除），空串不代表清除。
 *   落盘：先严格白名单校验，再写同目录临时文件并用 SDK 真正加载一次，通过后
 *         rename 原子替换；任何一步失败原文件字节不变。
 *
 * settings.json 不走同样的整文件替换：SDK 的 SettingsManager 用 proper-lockfile
 * 加锁、锁内重读、字段级合并写入，整文件覆盖会与正在运行的 Pi Session 竞争并丢更新。
 * 因此默认模型一律走公开 setter + flush()。
 */
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { ModelRuntime, SettingsManager, getAgentDir } from "@earendil-works/pi-coding-agent";
import { HttpError } from "../routes/http.ts";

/** SDK 的 Known API 列表。`api` 在 SDK schema 里只是自由字符串，拼错会静默通过、
 *  直到真正发请求才失败，所以这里自己收成枚举。 */
export const KNOWN_APIS = [
  "openai-completions",
  "mistral-conversations",
  "openai-responses",
  "azure-openai-responses",
  "openai-codex-responses",
  "anthropic-messages",
  "bedrock-converse-stream",
  "google-generative-ai",
  "google-vertex",
  "pi-messages",
] as const;

export type KnownApi = (typeof KNOWN_APIS)[number];

/** 前端看到的固定掩码。原样提交回来视为「保持不变」，其本身不含任何真实信息。 */
export const SECRET_MASK = "••••••••";

const MODELS_FILE_MODE = 0o600;

export function modelsJsonPath(): string {
  return path.join(getAgentDir(), "models.json");
}

interface RawProvider {
  name?: unknown;
  baseUrl?: unknown;
  apiKey?: unknown;
  api?: unknown;
  headers?: unknown;
  models?: unknown;
  [key: string]: unknown;
}

interface RawModelsJson {
  providers: Record<string, RawProvider>;
  [key: string]: unknown;
}

/**
 * models.json 允许 `//` 行注释与尾逗号（SDK 自己也这么读），但字符串字面量里的
 * 这些字符必须原样保留，所以按字符扫描而不是正则替换。
 */
function stripJsonComments(input: string): string {
  let output = "";
  let inString = false;
  let escaped = false;
  for (let index = 0; index < input.length; index += 1) {
    const char = input[index];
    if (inString) {
      output += char;
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') { inString = true; output += char; continue; }
    if (char === "/" && input[index + 1] === "/") {
      while (index < input.length && input[index] !== "\n") index += 1;
      output += "\n";
      continue;
    }
    output += char;
  }
  // 尾逗号：注释已剥离，此处只可能出现在结构字符前
  return output.replace(/,(\s*[}\]])/g, "$1");
}

function parseModelsJson(text: string): RawModelsJson {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripJsonComments(text));
  } catch {
    throw new HttpError(409, "models.json 无法解析，请先手动修复该文件后再用界面编辑");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new HttpError(409, "models.json 的顶层必须是对象");
  }
  const root = parsed as Record<string, unknown>;
  const providers = root.providers;
  if (providers !== undefined && (typeof providers !== "object" || providers === null || Array.isArray(providers))) {
    throw new HttpError(409, "models.json 的 providers 必须是对象");
  }
  return { ...root, providers: (providers ?? {}) as Record<string, RawProvider> };
}

export function readModelsJson(): RawModelsJson {
  const filePath = modelsJsonPath();
  if (!existsSync(filePath)) return { providers: {} };
  return parseModelsJson(readFileSync(filePath, "utf8"));
}

// ============================================================================
// 出口投影（脱敏）
// ============================================================================

export interface ProviderModelView {
  id: string;
  name: string | null;
}

export interface ProviderView {
  id: string;
  name: string | null;
  api: string | null;
  /** api 不在 Known API 列表里时为 true，界面要提示这条 provider 可能永远请求失败。 */
  apiUnknown: boolean;
  baseUrl: string | null;
  apiKeyConfigured: boolean;
  /** 只给出 header 名，值一律不出网（常被用来放令牌）。 */
  headerNames: string[];
  models: ProviderModelView[];
  /** 结构化编辑覆盖不到的字段名，界面据此提示「本 provider 含高级配置，保存会保留」。 */
  advancedKeys: string[];
}

const EDITABLE_PROVIDER_KEYS = new Set(["name", "baseUrl", "apiKey", "api", "headers", "models"]);

function readableString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function providerView(id: string, provider: RawProvider): ProviderView {
  const api = readableString(provider.api);
  const models = Array.isArray(provider.models)
    ? provider.models.flatMap((model) => {
      if (typeof model !== "object" || model === null) return [];
      const record = model as Record<string, unknown>;
      const modelId = readableString(record.id);
      return modelId ? [{ id: modelId, name: readableString(record.name) }] : [];
    })
    : [];
  const headers = typeof provider.headers === "object" && provider.headers !== null && !Array.isArray(provider.headers)
    ? Object.keys(provider.headers as Record<string, unknown>)
    : [];
  return {
    id,
    name: readableString(provider.name),
    api,
    apiUnknown: api !== null && !(KNOWN_APIS as readonly string[]).includes(api),
    baseUrl: readableString(provider.baseUrl),
    apiKeyConfigured: typeof provider.apiKey === "string" && provider.apiKey.trim().length > 0,
    headerNames: headers,
    models,
    advancedKeys: Object.keys(provider).filter((key) => !EDITABLE_PROVIDER_KEYS.has(key)),
  };
}

export function listProviderViews(): ProviderView[] {
  const config = readModelsJson();
  return Object.entries(config.providers).map(([id, provider]) => providerView(id, provider ?? {}));
}

// ============================================================================
// 入口校验
// ============================================================================

const PROVIDER_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** 本产品直接写入的 provider 字段；其余字段（如 compat）由 Pi 管辖，保存时原样保留。 */
const PROVIDER_MANAGED_KEYS = new Set(["name", "baseUrl", "api", "apiKey", "headers", "models"]);
/** 本产品直接写入的模型条目字段；reasoning / contextWindow / cost 等由 Pi 管辖，原样保留。 */
const MODEL_MANAGED_KEYS = new Set(["id", "name"]);

export interface ProviderPatchInput {
  name?: string | null;
  baseUrl?: string | null;
  api?: string;
  /** 三态：undefined 保持、字符串覆盖、null 清除。掩码原样回传等价于保持。 */
  apiKey?: string | null;
  headers?: Record<string, string | null>;
  models?: Array<{ id: string; name?: string | null }>;
}

function readOptionalText(value: unknown, label: string, maxLength: number): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== "string" || value.length > maxLength) {
    throw new HttpError(400, `${label} 必须是文本或 null，且不超过 ${maxLength} 个字符`);
  }
  return value.trim() || null;
}

export function readProviderPatch(body: Record<string, unknown>): ProviderPatchInput {
  for (const key of Object.keys(body)) {
    if (!PROVIDER_MANAGED_KEYS.has(key)) throw new HttpError(400, `不支持的 provider 字段：${key}`);
  }
  const patch: ProviderPatchInput = {};
  const name = readOptionalText(body.name, "name", 200);
  if (name !== undefined) patch.name = name;
  const baseUrl = readOptionalText(body.baseUrl, "baseUrl", 2000);
  if (baseUrl !== undefined) patch.baseUrl = baseUrl;

  if (body.api !== undefined) {
    if (typeof body.api !== "string" || !(KNOWN_APIS as readonly string[]).includes(body.api)) {
      throw new HttpError(400, `api 必须是以下之一：${KNOWN_APIS.join("、")}`);
    }
    patch.api = body.api;
  }

  if (body.apiKey !== undefined) {
    if (body.apiKey === null) patch.apiKey = null;
    else if (typeof body.apiKey === "string") {
      if (body.apiKey.length > 8000) throw new HttpError(400, "apiKey 过长");
      // 掩码回传 = 用户没有改这个字段；空串同样按「保持不变」处理，清除要显式传 null。
      if (body.apiKey !== SECRET_MASK && body.apiKey.trim()) patch.apiKey = body.apiKey.trim();
    } else {
      throw new HttpError(400, "apiKey 必须是文本或 null");
    }
  }

  if (body.headers !== undefined) {
    if (typeof body.headers !== "object" || body.headers === null || Array.isArray(body.headers)) {
      throw new HttpError(400, "headers 必须是对象");
    }
    const headers: Record<string, string | null> = {};
    for (const [key, value] of Object.entries(body.headers as Record<string, unknown>)) {
      if (!/^[A-Za-z0-9-]{1,128}$/.test(key)) throw new HttpError(400, `header 名称无效：${key}`);
      if (value === null) { headers[key] = null; continue; }
      if (typeof value !== "string" || value.length > 8000) throw new HttpError(400, `header ${key} 的值无效`);
      if (value === SECRET_MASK) continue;
      headers[key] = value;
    }
    patch.headers = headers;
  }

  if (body.models !== undefined) {
    if (!Array.isArray(body.models) || body.models.length > 200) throw new HttpError(400, "models 必须是至多 200 项的数组");
    const seen = new Set<string>();
    patch.models = body.models.map((entry) => {
      if (typeof entry !== "object" || entry === null) throw new HttpError(400, "models 的每一项必须是对象");
      const record = entry as Record<string, unknown>;
      for (const key of Object.keys(record)) {
        if (key !== "id" && key !== "name") throw new HttpError(400, `模型条目不支持字段：${key}`);
      }
      if (typeof record.id !== "string" || !record.id.trim() || record.id.length > 300) {
        throw new HttpError(400, "模型 id 不能为空且不超过 300 个字符");
      }
      const id = record.id.trim();
      if (seen.has(id)) throw new HttpError(400, `模型 id 重复：${id}`);
      seen.add(id);
      const modelName = readOptionalText(record.name, "模型 name", 200);
      return { id, ...(modelName === undefined ? {} : { name: modelName }) };
    });
  }
  return patch;
}

export function assertProviderId(id: unknown): string {
  if (typeof id !== "string" || !PROVIDER_ID_PATTERN.test(id)) {
    throw new HttpError(400, "provider 标识只能包含字母、数字、点、下划线或连字符，且不超过 64 个字符");
  }
  return id;
}

/**
 * 把补丁合并到原 provider 上：结构化编辑覆盖不到的高级字段（compat、modelOverrides…）
 * 原样保留，模型条目也只改 id/name，不丢用户手写的 cost / contextWindow 等设置。
 */
function mergeProvider(current: RawProvider, patch: ProviderPatchInput): RawProvider {
  const next: RawProvider = { ...current };
  const applyOptional = (key: "name" | "baseUrl", value: string | null | undefined) => {
    if (value === undefined) return;
    if (value === null) delete next[key];
    else next[key] = value;
  };
  applyOptional("name", patch.name);
  applyOptional("baseUrl", patch.baseUrl);
  if (patch.api !== undefined) next.api = patch.api;
  if (patch.apiKey !== undefined) {
    if (patch.apiKey === null) delete next.apiKey;
    else next.apiKey = patch.apiKey;
  }
  if (patch.headers !== undefined) {
    const headers: Record<string, string> = {
      ...(typeof current.headers === "object" && current.headers !== null && !Array.isArray(current.headers)
        ? current.headers as Record<string, string>
        : {}),
    };
    for (const [key, value] of Object.entries(patch.headers)) {
      if (value === null) delete headers[key];
      else headers[key] = value;
    }
    if (Object.keys(headers).length) next.headers = headers;
    else delete next.headers;
  }
  if (patch.models !== undefined) {
    const existing = Array.isArray(current.models) ? current.models as Array<Record<string, unknown>> : [];
    next.models = patch.models.map((model) => {
      const previous = existing.find((item) => typeof item?.id === "string" && item.id === model.id) ?? {};
      const merged: Record<string, unknown> = { ...previous, id: model.id };
      if (model.name === undefined) return merged;
      if (model.name === null) delete merged.name;
      else merged.name = model.name;
      return merged;
    });
  }
  return next;
}

// ============================================================================
// 落盘
// ============================================================================

/**
 * SDK 的加载错误按 provider 分段，形如 `Provider "id": ...`。
 * 逐段归属的意义在于：用户 models.json 里可能早就存在一条坏 provider，
 * 若一律拒绝，界面将永远无法保存任何修改——所以只有本次改动涉及的
 * provider 出错才拒绝，其余作为警告返回。
 */
function splitSdkErrors(error: string): Array<{ providerId: string | null; detail: string }> {
  return error.split("\n\n").map((block) => {
    const trimmed = block.trim();
    const match = /^Provider "([^"]+)":\s*([\s\S]*)$/.exec(trimmed);
    return match ? { providerId: match[1], detail: match[2].trim() } : { providerId: null, detail: trimmed };
  }).filter((item) => item.detail.length > 0);
}

/** 错误详情可能带上候选文件或部署目录，出网前一律抹掉绝对路径并截断。 */
function sanitizeSdkDetail(detail: string): string {
  return detail.replace(/(^|\s)\/\S+/g, "$1<路径已隐藏>").slice(0, 300);
}

/**
 * 候选内容先落到同目录临时文件，交给 SDK 真正加载一次；只有本次改动的 provider
 * 能被 SDK 接受时才 rename 成正式文件。rename 是同目录原子操作，因此失败路径下
 * 原文件字节不变。
 */
async function writeModelsJson(next: RawModelsJson, touchedProviderIds: string[]): Promise<string[]> {
  const filePath = modelsJsonPath();
  const directory = path.dirname(filePath);
  const mode = existsSync(filePath) ? statSync(filePath).mode & 0o777 : MODELS_FILE_MODE;
  const candidatePath = path.join(directory, `.models.json.${randomBytes(6).toString("hex")}.tmp`);
  writeFileSync(candidatePath, `${JSON.stringify(next, null, 2)}\n`, { encoding: "utf8", mode });
  let warnings: string[] = [];
  try {
    const candidate = await ModelRuntime.create({
      modelsPath: candidatePath,
      allowModelNetwork: false,
      refreshOnCreate: false,
    });
    const error = candidate.getError();
    if (error) {
      const issues = splitSdkErrors(error);
      const blocking = issues.filter((issue) => issue.providerId === null || touchedProviderIds.includes(issue.providerId));
      if (blocking.length) {
        throw new HttpError(400, `配置未通过 Pi 的模型定义校验：${blocking.map((issue) => sanitizeSdkDetail(issue.detail)).join("；")}`);
      }
      warnings = issues.map((issue) => `provider「${issue.providerId}」存在既有配置问题：${sanitizeSdkDetail(issue.detail)}`);
    }
    renameSync(candidatePath, filePath);
  } catch (error) {
    try { unlinkSync(candidatePath); } catch { /* 临时文件可能已被 rename 走 */ }
    if (error instanceof HttpError) throw error;
    throw new HttpError(400, "配置无法被 Pi 加载，已保持原文件不变");
  }
  return warnings;
}

export interface SaveProviderResult {
  provider: ProviderView;
  /** 本次未触碰、但 Pi 认为有问题的其他 provider；用于界面提示，不阻断保存。 */
  warnings: string[];
}

export async function saveProvider(providerId: string, patch: ProviderPatchInput): Promise<SaveProviderResult> {
  const config = readModelsJson();
  const current = config.providers[providerId] ?? {};
  const isNew = config.providers[providerId] === undefined;
  if (isNew && patch.api === undefined) throw new HttpError(400, "新建 provider 必须指定 api 类型");
  const merged = mergeProvider(current, patch);
  const warnings = await writeModelsJson(
    { ...config, providers: { ...config.providers, [providerId]: merged } },
    [providerId],
  );
  return { provider: providerView(providerId, merged), warnings };
}

export async function deleteProvider(providerId: string): Promise<void> {
  const config = readModelsJson();
  if (config.providers[providerId] === undefined) throw new HttpError(404, "provider 不存在");
  const providers = { ...config.providers };
  delete providers[providerId];
  // 删除只可能减少问题，不把其他 provider 的既有错误算到本次操作头上。
  await writeModelsJson({ ...config, providers }, []);
}

// ============================================================================
// settings.json（只经 SettingsManager，绝不整文件覆盖）
// ============================================================================

export type DefaultModelSource = "env" | "settings" | "catalog";

export interface DefaultModelView {
  provider: string | null;
  modelId: string | null;
  source: DefaultModelSource;
  /** 由部署环境变量固定时不允许在界面上改，否则是假成功。 */
  editable: boolean;
}

export function readDefaultModel(cwd: string): DefaultModelView {
  const settings = SettingsManager.create(cwd, getAgentDir());
  const envProvider = process.env.PI_TEACHER_PROVIDER;
  const envModel = process.env.PI_TEACHER_MODEL;
  if (envProvider || envModel) {
    return {
      provider: envProvider ?? settings.getDefaultProvider() ?? null,
      modelId: envModel ?? settings.getDefaultModel() ?? null,
      source: "env",
      editable: false,
    };
  }
  const provider = settings.getDefaultProvider() ?? null;
  const modelId = settings.getDefaultModel() ?? null;
  return {
    provider,
    modelId,
    source: provider && modelId ? "settings" : "catalog",
    editable: true,
  };
}

export async function writeDefaultModel(cwd: string, provider: string, modelId: string): Promise<void> {
  assertDefaultModelEditable();
  const settings = SettingsManager.create(cwd, getAgentDir());
  settings.setDefaultModelAndProvider(provider, modelId);
  await settings.flush();
}

/** 环境变量固定默认模型时，任何写入都只会造成「保存成功但没生效」的错觉。 */
export function assertDefaultModelEditable(): void {
  if (process.env.PI_TEACHER_PROVIDER || process.env.PI_TEACHER_MODEL) {
    throw new HttpError(409, "默认模型由部署环境变量固定，界面修改不会生效");
  }
}

export interface RetryView {
  enabled: boolean;
  maxRetries: number;
  baseDelayMs: number;
  /** provider 级 retry 明细没有公开 setter，本阶段只读展示。 */
  provider: { timeoutMs?: number; maxRetries?: number; maxRetryDelayMs: number };
}

export interface SettingsJsonView {
  defaultProvider: string | null;
  defaultModel: string | null;
  retryEnabled: boolean;
  retry: RetryView;
}

export function readSettingsJson(cwd: string): SettingsJsonView {
  const settings = SettingsManager.create(cwd, getAgentDir());
  return {
    defaultProvider: settings.getDefaultProvider() ?? null,
    defaultModel: settings.getDefaultModel() ?? null,
    retryEnabled: settings.getRetryEnabled(),
    retry: { ...settings.getRetrySettings(), provider: settings.getProviderRetrySettings() },
  };
}

export interface SettingsJsonPatch {
  defaultProvider?: string | null;
  defaultModel?: string | null;
  retryEnabled?: boolean;
}

export function readSettingsJsonPatch(value: unknown): SettingsJsonPatch {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new HttpError(400, "运行设置必须是 JSON 对象");
  }
  const record = value as Record<string, unknown>;
  const allowed = new Set(["defaultProvider", "defaultModel", "retryEnabled"]);
  for (const key of Object.keys(record)) if (!allowed.has(key)) throw new HttpError(400, `运行设置不支持字段：${key}`);
  const patch: SettingsJsonPatch = {};
  for (const key of ["defaultProvider", "defaultModel"] as const) {
    if (!(key in record)) continue;
    const item = record[key];
    if (item !== null && (typeof item !== "string" || !item.trim() || item.length > 300)) {
      throw new HttpError(400, `${key} 必须是非空文本或 null`);
    }
    patch[key] = item === null ? null : (item as string).trim();
  }
  if ("retryEnabled" in record) {
    if (typeof record.retryEnabled !== "boolean") throw new HttpError(400, "retryEnabled 必须是布尔值");
    patch.retryEnabled = record.retryEnabled;
  }
  if (!Object.keys(patch).length) throw new HttpError(400, "至少要提供一个受控运行设置字段");
  return patch;
}

export async function writeSettingsJson(cwd: string, patch: SettingsJsonPatch): Promise<void> {
  if (patch.defaultProvider !== undefined || patch.defaultModel !== undefined) assertDefaultModelEditable();
  const settings = SettingsManager.create(cwd, getAgentDir());
  if (patch.defaultProvider !== undefined || patch.defaultModel !== undefined) {
    const provider = patch.defaultProvider ?? settings.getDefaultProvider() ?? "";
    const modelId = patch.defaultModel ?? settings.getDefaultModel() ?? "";
    if (!provider || !modelId) throw new HttpError(400, "defaultProvider 与 defaultModel 必须同时存在");
    settings.setDefaultModelAndProvider(provider, modelId);
  }
  if (patch.retryEnabled !== undefined) settings.setRetryEnabled(patch.retryEnabled);
  await settings.flush();
}

export function providerJsonView(providerId: string): Record<string, unknown> {
  const config = readModelsJson();
  const provider = config.providers[providerId];
  if (!provider) throw new HttpError(404, "provider 不存在");
  return sanitizeProviderJson(provider);
}

/** 脱敏后的高级视图：凭据和所有 header 值只显示固定掩码，不能从 JSON 反推出原值。 */
function sanitizeProviderJson(value: unknown): Record<string, unknown> {
  if (Array.isArray(value)) return value.map((item) => sanitizeProviderValue(item)) as unknown as Record<string, unknown>;
  if (typeof value !== "object" || value === null) return {};
  return sanitizeProviderValue(value) as Record<string, unknown>;
}

function sanitizeProviderValue(value: unknown, parentKey?: string): unknown {
  if (Array.isArray(value)) return value.map((item) => sanitizeProviderValue(item, parentKey));
  if (typeof value !== "object" || value === null) return value;
  const record = value as Record<string, unknown>;
  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(record)) {
    if (key === "apiKey" || (parentKey === "headers" && typeof item === "string")) {
      result[key] = SECRET_MASK;
    } else {
      result[key] = sanitizeProviderValue(item, key);
    }
  }
  return result;
}

/**
 * 清理 JSON 高级视图中的掩码与非受管字段。
 *
 * 高级视图展示的是 provider 的完整定义，其中包含 `compat`、模型条目的
 * `reasoning` / `contextWindow` 等由 Pi 管辖的字段。它们不在本产品的写入白名单里，
 * 但直接拒绝会让「原样保存视图内容」这一最自然的动作失败。因此这里把它们从补丁中
 * 剔除（mergeProvider 会按原值保留），并把被忽略的字段名回报给调用方，
 * 由界面明确告知「这些字段没有被修改」——不静默丢弃用户可能有意的编辑。
 */
export interface ProviderJsonPatchResult {
  patch: ProviderPatchInput;
  ignoredKeys: string[];
}

export function providerPatchFromJson(value: unknown): ProviderJsonPatchResult {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new HttpError(400, "provider JSON 必须是对象");
  }
  const record = value as Record<string, unknown>;
  const ignored = new Set<string>();
  const managed: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(record)) {
    if (PROVIDER_MANAGED_KEYS.has(key)) managed[key] = item;
    else ignored.add(key);
  }
  if (Array.isArray(managed.models)) {
    managed.models = managed.models.map((entry) => {
      if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return entry;
      const model: Record<string, unknown> = {};
      for (const [key, item] of Object.entries(entry as Record<string, unknown>)) {
        if (MODEL_MANAGED_KEYS.has(key)) model[key] = item;
        else ignored.add(`models[].${key}`);
      }
      return model;
    });
  }
  return { patch: readProviderPatch(managed), ignoredKeys: [...ignored] };
}