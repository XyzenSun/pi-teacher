/**
 * Pi 配置路由：provider / 模型定义、默认模型、受控运行设置、全局 Markdown 与用户环境变量。
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
import { readHomeMarkdown, readHomeMarkdownContent, writeHomeMarkdown, type HomeMarkdownKind } from "../config/home-markdown.ts";
import { applyUserEnvPatch, deleteUserEnv, listUserEnv, readUserEnvPatch } from "../config/user-env.ts";
import { APP_SETTINGS_FIELDS, readAppSettings, readAppSettingsPatch, writeAppSettings } from "../config/app-settings.ts";

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

  // 运行设置分两半：`settings` 是 Pi 的 settings.json 受控字段，`app` 是 pi-teacher 自己的
  // 业务设置（setting 表，ADR-0036）。同一个 PATCH 可以混着传，路由先按字段名拆开。
  const settingsView = () => ({ settings: readSettingsJson(state.homeDir), app: readAppSettings(state.db), defaultModel: readDefaultModel(state.homeDir) });

  router.get("/settings", (_req, res) => {
    res.json(settingsView());
  });

  router.patch("/settings", async (req, res) => {
    const body = readBody(req.body);
    const appBody: Record<string, unknown> = {};
    const piBody: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(body)) (APP_SETTINGS_FIELDS.has(key as never) ? appBody : piBody)[key] = value;
    const appPatch = readAppSettingsPatch(appBody);
    // Pi 字段先校验后写入，避免业务字段已落库而 Pi 字段被拒的半成功；Pi 部分为空时跳过其「至少一个字段」检查。
    const piPatch = Object.keys(piBody).length ? readSettingsJsonPatch(piBody) : null;
    if (!piPatch && !Object.keys(appPatch).length) throw new HttpError(400, "至少要提供一个受控运行设置字段");
    if (piPatch) await writeSettingsJson(state.homeDir, piPatch);
    writeAppSettings(state.db, appPatch);
    res.json({ success: true, ...settingsView() });
  });

  // 全局 USER.md 与全局 AGENTS.md：都在下次开会话 / 切换风格重载时进入 system prompt
  // （前者经 appendSystemPrompt 合并，后者由 Pi 祖先遍历发现）。会话级 pi-session-user.md 没有 API。
  for (const kind of ["user-preferences", "global-agents-md"] as HomeMarkdownKind[]) {
    router.get(`/${kind}`, (_req, res) => {
      res.json(readHomeMarkdown(state.homeDir, kind));
    });
    router.put(`/${kind}`, (req, res) => {
      writeHomeMarkdown(state.homeDir, kind, readHomeMarkdownContent(readBody(req.body), kind));
      res.json({ success: true });
    });
  }

  // 用户环境变量（ADR-0034）：表是唯一源，保存 / 删除后立即同步 process.env，skill 子进程下次调用即生效。
  router.get("/user-env", (_req, res) => {
    res.json({ items: listUserEnv(state.db) });
  });

  router.patch("/user-env", (req, res) => {
    applyUserEnvPatch(state.db, readUserEnvPatch(readBody(req.body)));
    res.json({ success: true, items: listUserEnv(state.db) });
  });

  router.delete("/user-env/:key", (req, res) => {
    deleteUserEnv(state.db, req.params.key);
    res.json({ success: true, items: listUserEnv(state.db) });
  });

  return router;
}
