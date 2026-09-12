import { Router } from "express";
import type { AppState } from "./app-state.ts";
import { HttpError } from "./http.ts";
import { getModelCatalog, selectDefaultModel } from "../session/models.ts";

export function createModelsRouter(state: AppState): Router {
  const router = Router();
  router.get("/", async (_req, res) => {
    const runtime = await getModelCatalog();
    const available = await runtime.getAvailable();
    // 默认模型不可用时列表照常返回（defaultModel: null），用户仍能看到可用模型手动切换，
    // 而不是整个接口 503 连自救的机会都没有；开会话路径（agent-session-wrapper）保持
    // 抛 503——不能在用户不知情时静默换模型开课。非 HttpError 的意外错误照常冒泡。
    let defaultModel: ReturnType<typeof selectDefaultModel> | undefined;
    try {
      defaultModel = selectDefaultModel(runtime, state.homeDir);
    } catch (error) {
      if (!(error instanceof HttpError)) throw error;
      defaultModel = undefined;
    }
    res.json({
      models: available.map((model) => ({ provider: model.provider, id: model.id, name: model.name })),
      defaultModel: defaultModel ? { provider: defaultModel.provider, id: defaultModel.id } : null,
    });
  });
  return router;
}
