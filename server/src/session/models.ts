import { ModelRuntime, SettingsManager, getAgentDir } from "@earendil-works/pi-coding-agent";
import { HttpError } from "../routes/http.ts";

let catalogPromise: Promise<ModelRuntime> | undefined;

export function getModelCatalog(): Promise<ModelRuntime> {
  catalogPromise ??= ModelRuntime.create({ allowModelNetwork: false }).catch((error) => {
    catalogPromise = undefined;
    throw error;
  });
  return catalogPromise;
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
