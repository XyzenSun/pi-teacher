import { statSync } from "node:fs";
import path from "node:path";
import { ModelRuntime, SettingsManager, getAgentDir } from "@earendil-works/pi-coding-agent";
import { HttpError } from "../routes/http.ts";

let catalogPromise: Promise<ModelRuntime> | undefined;
/** refresh 串行化：并发保存配置时交错刷新会让目录停在中间状态。 */
let refreshChain: Promise<void> = Promise.resolve();
/** 上次目录加载 / 刷新完成时的配置指纹；null 表示单例尚未初始化。 */
let refreshedFingerprint: string | null = null;

/**
 * models.json 与 auth.json 的 (mtimeMs, size) 指纹：前者决定目录内容，后者决定
 * 凭据可用性（available 过滤）。settings.json 不参与——默认模型每次请求都现读，
 * 不存在快照脱节。指纹只用于检测「界面外修改」，mtime+size 足够，不算内容 hash。
 */
function configFingerprint(): string {
  return ["models.json", "auth.json"].map((fileName) => {
    try {
      const stat = statSync(path.join(getAgentDir(), fileName));
      return `${stat.mtimeMs}:${stat.size}`;
    } catch {
      return "-";
    }
  }).join("|");
}

export function getModelCatalog(): Promise<ModelRuntime> {
  catalogPromise ??= ModelRuntime.create({ allowModelNetwork: false }).then(
    (runtime) => {
      refreshedFingerprint = configFingerprint();
      return runtime;
    },
    (error) => {
      catalogPromise = undefined;
      throw error;
    },
  );
  // 目录单例原本只在界面内保存配置时刷新；用户在界面外改配置（pi CLI、手动编辑、
  // 版本升级迁移）后端无从得知，表现为「设置页显示已配置、模型列表却说默认模型
  // 不可用」。因此每次取目录都比较指纹，发现磁盘变化就先重载再返回；重载失败时
  // 退回旧目录而不是让请求 500——磁盘配置坏了不应拖垮整个模型列表。
  if (refreshedFingerprint !== null && configFingerprint() !== refreshedFingerprint) {
    return refreshModelCatalog().catch(() => {}).then(() => catalogPromise!);
  }
  return catalogPromise;
}

/**
 * 配置保存后刷新模型目录。用 SDK 公开的 refresh 而不是丢弃单例重建：
 * 重建会丢掉运行期注册的 provider，而 refresh 是 SDK 自己的重载路径。
 * 已启动的 Pi Session 保持其当前模型不变，只有新会话与目录列表用新配置。
 */
export function refreshModelCatalog(): Promise<void> {
  refreshChain = refreshChain
    .catch(() => {})
    .then(async () => {
      // 排队期间前一次刷新可能已把指纹对齐（并发触发的场景），跳过重复重载；
      // 单例尚未创建时也无需刷新：创建路径会直接读最新文件。
      if (catalogPromise === undefined) return;
      if (refreshedFingerprint !== null && configFingerprint() === refreshedFingerprint) return;
      const runtime = await catalogPromise;
      await runtime.refresh({ allowNetwork: false });
      refreshedFingerprint = configFingerprint();
    });
  return refreshChain;
}

/** 模型目录与新会话共用默认选择逻辑；只读部署配置，不把配置对象返回 HTTP。 */
export function selectDefaultModel(runtime: ModelRuntime, cwd: string) {
  const settings = SettingsManager.create(cwd, getAgentDir());
  // 用 || 而不是 ??：compose 里 `PI_TEACHER_PROVIDER=${PI_TEACHER_PROVIDER:-}` 未设置时得到的是空串，空串等同未设置。
  const provider = process.env.PI_TEACHER_PROVIDER || settings.getDefaultProvider();
  const modelId = process.env.PI_TEACHER_MODEL || settings.getDefaultModel();
  const available = runtime.getAvailableSnapshot();
  if (provider && modelId) {
    const configured = available.find((model) => model.provider === provider && model.id === modelId);
    if (!configured) throw new HttpError(503, "默认模型不可用，请检查部署模型与凭据配置");
    return configured;
  }
  return available.find((model) => !provider || model.provider === provider) ?? available[0];
}
