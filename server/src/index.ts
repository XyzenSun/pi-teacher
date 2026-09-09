import express from "express";
import { promises as fs, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import { parseEnv } from "node:util";
import { openDatabase, closeDatabase } from "./db/connection.ts";
import { initializeSchema } from "./db/schema.ts";
import { syncEnvToFile, getSyncKeys } from "./env-sync.ts";
import { apiRequestSecurity } from "./security/request-security.ts";
import { initCookieSigning, requireAuth } from "./auth/middleware.ts";
import { createAuthRouter } from "./routes/auth.ts";
import { createWorkspacesRouter } from "./routes/workspaces.ts";
import { createConversationsRouter } from "./routes/conversations.ts";
import { createAttachmentsRouter } from "./routes/attachments.ts";
import { createModelsRouter } from "./routes/models.ts";
import { createCardsRouter } from "./routes/cards.ts";
import { createGlossaryRouter } from "./routes/glossary.ts";
import { createTopicsRouter } from "./routes/topics.ts";
import { createPromptsRouter } from "./routes/prompts.ts";
import { apiErrorHandler } from "./routes/http.ts";
import type { AppState } from "./routes/app-state.ts";

export interface ServerOptions {
  homeDir?: string;
  dbPath?: string;
  port?: number;
  envFilePath?: string;
  webDistDir?: string;
}

function applicationHome(options: ServerOptions): string {
  return path.resolve(options.homeDir ?? process.env.PI_TEACHER_HOME ?? path.join(os.homedir(), "pi-teacher"));
}

/** 构造真实应用但不监听；验证使用独立临时数据目录，不动部署数据。 */
export async function buildApp(options: ServerOptions = {}) {
  const homeDir = applicationHome(options);
  const dataDir = path.join(homeDir, "data");
  await fs.mkdir(dataDir, { recursive: true });
  const db = openDatabase(options.dbPath ?? path.join(dataDir, "pi-teacher.db"));
  try {
    initializeSchema(db, homeDir);
    const keyPath = path.join(dataDir, "cookie.key");
    let keyMaterial: string;
    try {
      keyMaterial = await fs.readFile(keyPath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      keyMaterial = randomBytes(32).toString("hex");
      await fs.writeFile(keyPath, keyMaterial, { encoding: "utf8", flag: "wx", mode: 0o600 });
    }
    initCookieSigning(keyMaterial);
    const state: AppState = { db, homeDir, dataDir };
    const app = express();
    app.disable("x-powered-by");
    // 信任校验与认证先于大请求体解析，二进制附件由其路由单独限量。
    app.use("/api", apiRequestSecurity);
    app.use("/api", (_req, res, next) => { res.setHeader("Cache-Control", "no-store"); next(); });
    app.use("/api/auth", express.json({ limit: "16kb" }), createAuthRouter(db));
    app.use("/api", requireAuth, express.json({ limit: "512kb" }));
    app.use("/api/workspaces", createWorkspacesRouter(state));
    app.use("/api/conversations/:id", createAttachmentsRouter(state));
    app.use("/api/conversations", createConversationsRouter(state));
    app.use("/api/models", createModelsRouter(state));
    app.use("/api/cards", createCardsRouter(state));
    app.use("/api/glossary", createGlossaryRouter(state));
    app.use("/api/topics", createTopicsRouter(state));
    app.use("/api/prompts", createPromptsRouter(state));
    app.use("/api", (_req, res) => { res.status(404).json({ error: "API 不存在" }); });

    const webDistDir = options.webDistDir ?? fileURLToPath(new URL("../../web/dist", import.meta.url));
    if (existsSync(path.join(webDistDir, "index.html"))) {
      app.use(express.static(webDistDir, { index: false, dotfiles: "deny" }));
      // API 的 404 已在上方结束；刷新和直达 /settings 都交给 React Router。
      app.get(/.*/, (_req, res) => { res.sendFile(path.join(webDistDir, "index.html")); });
    }
    app.use(apiErrorHandler);
    return { app, db, state };
  } catch (error) {
    closeDatabase();
    throw error;
  }
}

/** Tavily 仅装入已约定白名单，配置值绝不输出到日志。 */
export async function startServer(options: ServerOptions = {}) {
  const homeDir = applicationHome(options);
  await fs.mkdir(homeDir, { recursive: true });
  const envFilePath = options.envFilePath ?? path.join(homeDir, ".env");
  try {
    const localEnv = parseEnv(await fs.readFile(envFilePath, "utf8"));
    for (const key of getSyncKeys()) if (!process.env[key] && localEnv[key]) process.env[key] = localEnv[key];
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  await syncEnvToFile(envFilePath, process.env);
  const { app } = await buildApp(options);
  const port = options.port ?? Number(process.env.PORT ?? 39871);
  return new Promise<{ close: () => void; port: number }>((resolve, reject) => {
    const server = app.listen(port, () => {
      const actualPort = (server.address() as { port: number }).port;
      console.log(`[server] Pi Teacher 已启动：http://localhost:${actualPort}`);
      resolve({ port: actualPort, close: () => { server.close(); } });
    });
    server.on("error", reject);
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  startServer().catch((error) => {
    console.error("[server] 启动失败：", error instanceof Error ? error.message : "未知错误");
    process.exitCode = 1;
  });
}
