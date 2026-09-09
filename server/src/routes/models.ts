import { Router } from "express";
import type { AppState } from "./app-state.ts";
import { getModelCatalog, selectDefaultModel } from "../session/models.ts";

export function createModelsRouter(state: AppState): Router {
  const router = Router();
  router.get("/", async (_req, res) => {
    const runtime = await getModelCatalog();
    const available = await runtime.getAvailable();
    const defaultModel = selectDefaultModel(runtime, state.homeDir);
    res.json({
      models: available.map((model) => ({ provider: model.provider, id: model.id, name: model.name })),
      defaultModel: defaultModel ? { provider: defaultModel.provider, id: defaultModel.id } : null,
    });
  });
  return router;
}
