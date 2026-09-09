import { ModelRuntime, SettingsManager, getAgentDir } from "@earendil-works/pi-coding-agent";
import { HttpError } from "../routes/http.ts";

let catalogPromise: Promise<ModelRuntime> | undefined;
/** refresh 串行化：并发保存配置时交错刷新会让目录停在中间状态。 */
let refreshChain: Promise<void> = Promise.resolve();

export function getModelCatalog(): Promise<ModelRuntime> {
  catalogPromise ??= ModelRuntime.create({ allowModelNetwork: false }).catch((error) => {
    catalogPromise = undefined;
    throw error;
  });
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
      const runtime = await getModelCatalog();
      await runtime.refresh({ allowNetwork: false });
    });
  return refreshChain;
}

/** 模型目录与新会话共用默认选择逻辑；只读部署配置，不把配置对象返回 HTTP。 */
export function selectDefaultModel(runtime: ModelRuntime, cwd: string) {
  const settings = SettingsManager.create(cwd, getAgentDir());
  const provider = process.env.PI_TEACHER_PROVIDER ?? settings.getDefaultProvider();
  const modelId = process.env.PI_TEACHER_MODEL ?? settings.getDefaultModel();
  const available = runtime.getAvailableSnapshot();
  if (provider && modelId) {
    const configured = available.find((model) => model.provider === provider && model.id === modelId);
    if (!configured) throw new HttpError(503, "默认模型不可用，请检查部署模型与凭据配置");
    return configured;
  }
  return available.find((model) => !provider || model.provider === provider) ?? available[0];
}
