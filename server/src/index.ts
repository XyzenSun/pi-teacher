/**
 * Express 入口：中间件装配、路由挂载、启动钩子。
 * 启动顺序（PRD 工程骨架）：env-sync → user 表检查 → 监听。
 * 安全顺序：request-security（Host/Origin）先于 requireAuth（cookie）。
 */
import express from "express";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import Database from "better-sqlite3";
import { openDatabase } from "./db/connection.ts";
import { initializeSchema } from "./db/schema.ts";
import { syncEnvToFile } from "./env-sync.ts";
import { apiRequestSecurity } from "./security/request-security.ts";
import { initCookieSigning, requireAuth } from "./auth/middleware.ts";
import { createAuthRouter } from "./routes/auth.ts";
import { createWorkspacesRouter } from "./routes/workspaces.ts";
import { createConversationsRouter } from "./routes/conversations.ts";
import { createCardsRouter } from "./routes/cards.ts";
import { createGlossaryRouter } from "./routes/glossary.ts";
import { createTopicsRouter } from "./routes/topics.ts";
import { createPromptsRouter } from "./routes/prompts.ts";
import type { AppState } from "./routes/app-state.ts";

export interface ServerOptions {
  /** 部署根（默认 ~/pi-teacher；测试传临时目录） */
  homeDir?: string;
  /** 数据库路径（默认 <homeDir>/data/pi-teacher.db） */
  dbPath?: string;
  /** 监听端口（默认 39871；0 = 随机） */
  port?: number;
  /** .env 同步目标（默认 <homeDir>/.env） */
  envFilePath?: string;
}

/** 建 Express app 但不监听——http-smoke 用 supertest 语义直接打 app。 */
export function buildApp(options: ServerOptions = {}) {
  const homeDir = options.homeDir ?? path.join(os.homedir(), "pi-teacher");
  const dataDir = path.join(homeDir, "data");

  return fs.mkdir(dataDir, { recursive: true }).then(async () => {
    const dbPath = options.dbPath ?? path.join(dataDir, "pi-teacher.db");
    const db: Database.Database = openDatabase(dbPath);
    initializeSchema(db);

    // cookie 签名密钥：首启动生成，落 data 目录（重启后旧 cookie 仍有效）
    const keyPath = path.join(dataDir, "cookie.key");
    let keyMaterial: string;
    try {
      keyMaterial = await fs.readFile(keyPath, "utf8");
    } catch {
      keyMaterial = randomBytes(32).toString("hex");
      await fs.writeFile(keyPath, keyMaterial, "utf8");
    }
    initCookieSigning(keyMaterial);

    const state: AppState = { db, homeDir, dataDir };
    const app = express();
    app.disable("x-powered-by");
    app.use(express.json({ limit: "10mb" }));
    // 先信任校验（Host/Origin）后认证：不合法的 Host 连 401 都不给（PRD 要点 9）
    app.use("/api", apiRequestSecurity);
    // /api/auth/status 与 setup/login 无需登录；logout 允许未登录调用（幂等）
    app.use("/api/auth", createAuthRouter(db));
    app.use("/api", requireAuth);
    app.use("/api/workspaces", createWorkspacesRouter(state));
    app.use("/api/conversations", createConversationsRouter(state));
    app.use("/api/cards", createCardsRouter(state));
    app.use("/api/glossary", createGlossaryRouter(state));
    app.use("/api/topics", createTopicsRouter(state));
    app.use("/api/prompts", createPromptsRouter(state));

    return { app, db, state };
  });
}

/** 正式启动入口：构建 app → env-sync → 监听。 */
export function startServer(options: ServerOptions = {}) {
  const homeDir = options.homeDir ?? path.join(os.homedir(), "pi-teacher");
  const envFilePath = options.envFilePath ?? path.join(homeDir, ".env");
  const port = options.port ?? 39871;

  return syncEnvToFile(envFilePath, process.env)
    .then((written) => {
      if (written.length > 0) console.log(`[env-sync] 已同步 ${written.join(", ")} → ${envFilePath}`);
      return buildApp(options);
    })
    .then(({ app }) => {
      return new Promise<{ close: () => void; port: number }>((resolve) => {
        const server = app.listen(port, () => {
          console.log(`[server] pi-teacher 后端已启动：http://localhost:${port}`);
          resolve({
            port: (server.address() as { port: number }).port,
            close: () => server.close(),
          });
        });
      });
    });
}

// 直接运行（非 import）时启动
if (process.argv[1] && process.argv[1].endsWith("index.ts")) {
  startServer().catch((error) => {
    console.error("[server] 启动失败:", error);
    process.exit(1);
  });
}
