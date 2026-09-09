/**
 * Pi 配置路由：provider / 模型定义、默认模型与受控运行设置。
 *
 * 所有读写都走 server/src/config/pi-config.ts，本文件只负责 HTTP 形状与鉴权，
 * 不直接触碰 models.json 或 settings.json——secret 的脱敏规则只应有一处实现。
 */
import { Router } from "express";
import type { AppState } from "./app-state.ts";
import { HttpError, readBody } from "./http.ts";
import {
  KNOWN_APIS, SECRET_MASK, assertDefaultModelEditable, assertProviderId, deleteProvider,
  listProviderViews, providerJsonView, providerPatchFromJson, readDefaultModel, readProviderPatch,
  readSettingsJson, readSettingsJsonPatch, saveProvider, writeDefaultModel, writeSettingsJson,
} from "../config/pi-config.ts";
import { getModelCatalog, refreshModelCatalog } from "../session/models.ts";

export function createConfigRouter(state: AppState): Router {
  const router = Router();

  router.get("/models", (_req, res) => {
    res.json({
      knownApis: KNOWN_APIS,
      secretMask: SECRET_MASK,
      providers: listProviderViews(),
      defaultModel: readDefaultModel(state.homeDir),
    });
  });

  // 高级视图：结构化表单覆盖不到的字段以脱敏 JSON 呈现，便于核对而不泄漏凭据。
  router.get("/models/:providerId/json", (req, res) => {
    res.json({ provider: providerJsonView(assertProviderId(req.params.providerId)), secretMask: SECRET_MASK });
  });

  router.patch("/models/:providerId", async (req, res) => {
    const providerId = assertProviderId(req.params.providerId);
    const body = readBody(req.body);
    // 高级 JSON 提交与结构化表单走同一条校验路径，不给 JSON 开后门。
    // JSON 视图里 Pi 管辖的字段（compat、模型 reasoning 等）不写入但原样保留，
    // 并作为提示回报，让用户知道「这些字段没有被这次保存修改」。
    const { patch, ignoredKeys } = body.json === undefined
      ? { patch: readProviderPatch(body), ignoredKeys: [] as string[] }
      : providerPatchFromJson(body.json);
    const result = await saveProvider(providerId, patch);
    await refreshModelCatalog();
    const warnings = ignoredKeys.length
      ? [...result.warnings, `以下字段由 Pi 管理，本次未修改：${ignoredKeys.join("、")}`]
      : result.warnings;
    res.json({ success: true, provider: result.provider, warnings });
  });

  router.delete("/models/:providerId", async (req, res) => {
    await deleteProvider(assertProviderId(req.params.providerId));
    await refreshModelCatalog();
    res.json({ success: true });
  });

  router.patch("/default-model", async (req, res) => {
    const body = readBody(req.body);
    const keys = Object.keys(body);
    if (keys.length !== 2 || !keys.includes("provider") || !keys.includes("modelId")) {
      throw new HttpError(400, "default-model 只接收 provider 与 modelId");
    }
    if (typeof body.provider !== "string" || typeof body.modelId !== "string") {
      throw new HttpError(400, "provider 与 modelId 必须是文本");
    }
    // 环境变量固定时先拒，避免为一个注定不生效的组合去查目录甚至写盘。
    assertDefaultModelEditable();
    // 必须是目录里真实存在的组合，否则保存的是一个永远起不来的默认值。
    const runtime = await getModelCatalog();
    if (!runtime.getModel(body.provider, body.modelId)) {
      throw new HttpError(400, "该 provider 与模型组合不在当前模型目录中");
    }
    await writeDefaultModel(state.homeDir, body.provider, body.modelId);
    res.json({ success: true, defaultModel: readDefaultModel(state.homeDir) });
  });

  router.get("/settings", (_req, res) => {
    res.json({ settings: readSettingsJson(state.homeDir), defaultModel: readDefaultModel(state.homeDir) });
  });

  router.patch("/settings", async (req, res) => {
    await writeSettingsJson(state.homeDir, readSettingsJsonPatch(readBody(req.body)));
    res.json({ success: true, settings: readSettingsJson(state.homeDir), defaultModel: readDefaultModel(state.homeDir) });
  });

  return router;
}
