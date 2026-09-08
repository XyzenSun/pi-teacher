/**
 * 对话路由：pi_session 生命周期（列表/开启/关闭）+ Agent 命令（prompt/abort）
 * + SSE 事件流。桥接 wrapper 的会话 key 用 pi_session.path（jsonl 路径），
 * 前端全程拿这个路径当 id（等价 pi-web 的 sessionId）。
 */
import { Router } from "express";
import type { Request, Response } from "express";
import { promises as fs } from "node:fs";
import path from "node:path";
import type Database from "better-sqlite3";
import type { AppState } from "./app-state.ts";
import { workspaceDirFor, sandboxRootFor } from "./app-state.ts";
import { startWorkspaceSession, getSessionWrapper } from "../bridge/agent-session-wrapper.ts";
import { createAgentEventStream } from "../bridge/agent-event-stream.ts";
import { projectAgentsMd, projectTeachStyle } from "../projection/agents-md.ts";
import { buildContextInjection } from "../projection/context-inject.ts";
import { listConversations, readSessionEntries, buildSessionContext, type PiSessionRow } from "../session/session-reader.ts";
import { generateSessionTitle } from "../session/title-generator.ts";
import type { SessionToolContext } from "../tools/context.ts";
import { onAgentRunComplete } from "../events/hub.ts";

function rowToToolContext(db: Database.Database, row: PiSessionRow, state: AppState): SessionToolContext {
  return {
    db,
    spaceId: row.space_id as 0 | 1 | 2,
    enableMakeCard: row.enable_make_card === 1,
    reviewTopicId: row.review_topic_id,
    workspaceRoot: sandboxRootFor(state, row.space_id, row.session_id),
  };
}

export function createConversationsRouter(state: AppState): Router {
  const router = Router();

  // —— 标题生成订阅：轮次空闲 → 生成 → 写回 pi_session.name（幂等：已有名不覆盖）——
  onAgentRunComplete((jsonlPath) => {
    const row = state.db
      .prepare("SELECT * FROM pi_session WHERE path = ?")
      .get(jsonlPath) as PiSessionRow | undefined;
    if (!row || row.name) return; // 用户已命名或已生成过
    const wrapper = getSessionWrapper(jsonlPath);
    if (!wrapper?.isAlive()) return;
    void generateSessionTitle(wrapper.inner)
      .then(({ title }) => {
        state.db.prepare("UPDATE pi_session SET name = ? WHERE id = ? AND name IS NULL").run(title, row.id);
        console.log(`[title] pi_session ${row.id} → ${title}`);
      })
      .catch((error) => {
        // 标题生成失败不影响会话本身；留 null 下轮再试
        console.error("[title] 生成失败:", error instanceof Error ? error.message : error);
      });
  });

  // GET /api/conversations?workspace=<dir> —— 对话列表
  router.get("/", (req: Request, res: Response) => {
    const workspace = typeof req.query.workspace === "string" ? req.query.workspace : null;
    res.json({ conversations: listConversations(state.db, workspace) });
  });

  // POST /api/conversations —— 开新对话：校验 → 投影 → 建会话 → 落 pi_session 行
  router.post("/", async (req: Request, res: Response) => {
    const body = req.body as {
      spaceId?: number;
      sessionId?: number | null;
      agentsMdId?: number;
      teachStyleId?: number | null;
      enableMakeCard?: boolean;
      reviewTopicId?: number | null;
    };
    const spaceId = body.spaceId;
    if (spaceId !== 0 && spaceId !== 1 && spaceId !== 2) {
      res.status(400).json({ error: "spaceId 必须是 0（助教）/1（学习）/2（复习）" });
      return;
    }

    // 提示词模板必须与本会话类型匹配（agents_md.type 映射 space）
    const template = state.db
      .prepare("SELECT id FROM agents_md WHERE id = ? AND type = ?")
      .get(body.agentsMdId ?? -1, ["ta", "learn", "review"][spaceId]) as { id: number } | undefined;
    if (!template) {
      res.status(400).json({ error: `agentsMdId ${body.agentsMdId} 不存在或不适用于 ${["助教", "学习", "复习"][spaceId]}会话` });
      return;
    }
    if (body.teachStyleId != null) {
      const style = state.db
        .prepare("SELECT id FROM teach_style WHERE id = ?")
        .get(body.teachStyleId) as { id: number } | undefined;
      if (!style) {
        res.status(400).json({ error: `teachStyleId ${body.teachStyleId} 不存在` });
        return;
      }
    }
    if (spaceId === 2 && body.reviewTopicId != null) {
      const topic = state.db
        .prepare("SELECT id FROM topic WHERE id = ?")
        .get(body.reviewTopicId) as { id: number } | undefined;
      if (!topic) {
        res.status(400).json({ error: `reviewTopicId ${body.reviewTopicId} 不存在` });
        return;
      }
    }
    if (spaceId !== 2 && body.reviewTopicId != null) {
      res.status(400).json({ error: "reviewTopicId 仅复习对话可指定" });
      return;
    }
    if (spaceId === 1 && body.sessionId == null) {
      res.status(400).json({ error: "学习对话必须指定 sessionId（工作区）" });
      return;
    }

    const workspaceDir = workspaceDirFor(state, spaceId, body.sessionId ?? null);
    await fs.mkdir(workspaceDir, { recursive: true });

    // 投影先于建会话：AGENTS.md/style.md 落盘后，资源加载器自然读到（ADR-0014）
    await projectAgentsMd(state.db, workspaceDir, template.id);
    await projectTeachStyle(state.db, workspaceDir, body.teachStyleId ?? null);

    const info = state.db
      .prepare(`INSERT INTO pi_session
        (session_id, space_id, name, path, agents_md_id, teach_style_id, enable_make_card, review_topic_id)
        VALUES (?, ?, NULL, ?, ?, ?, ?, ?)`)
      .run(
        spaceId === 1 ? body.sessionId : spaceId === 0 ? 0 : null,
        spaceId,
        "/tmp/pending.jsonl", // 占位：真实 path 由 SessionManager 决定后 UPDATE
        template.id,
        body.teachStyleId ?? null,
        (body.enableMakeCard ?? true) ? 1 : 0,
        body.reviewTopicId ?? null,
      );
    const piSessionDbId = Number(info.lastInsertRowid);

    // 建会话（cwd 契约：双参指工作区目录，PRD 实现要点 1）
    const toolContext = rowToToolContext(state.db, {
      id: piSessionDbId,
      session_id: spaceId === 1 ? body.sessionId! : spaceId === 0 ? 0 : null,
      space_id: spaceId,
      name: null,
      path: "/tmp/pending.jsonl",
      agents_md_id: template.id,
      teach_style_id: body.teachStyleId ?? null,
      enable_make_card: (body.enableMakeCard ?? true) ? 1 : 0,
      review_topic_id: body.reviewTopicId ?? null,
      created_at: "",
    }, state);

    const sessionKey = `pi-teacher-pi-session-id-${piSessionDbId}`; // 先用临时 key 启动
    try {
      const { session, realSessionId } = await startWorkspaceSession(sessionKey, workspaceDir, toolContext);
      const sessionFile = session.inner.sessionFile ?? "";
      // 回填真实 jsonl 路径（数据库设计.md：SessionManager 构造后 getSessionFile() 即得）
      state.db.prepare("UPDATE pi_session SET path = ? WHERE id = ?").run(sessionFile, piSessionDbId);
      res.json({
        success: true,
        conversation: {
          id: piSessionDbId,
          piSessionId: realSessionId,
          sessionKey: sessionFile,
          workspaceDir,
        },
      });
    } catch (error) {
      state.db.prepare("DELETE FROM pi_session WHERE id = ?").run(piSessionDbId);
      res.status(500).json({ error: `会话启动失败：${error instanceof Error ? error.message : String(error)}` });
    }
  });

  // —— 以下按 jsonl 路径寻址（:key 编码为 encodeURIComponent(path)）——
  router.get("/:key/context", async (req: Request, res: Response) => {
    const jsonlPath = decodeURIComponent(String(req.params.key));
    const row = state.db.prepare("SELECT * FROM pi_session WHERE path = ?").get(jsonlPath) as PiSessionRow | undefined;
    if (!row) {
      res.status(404).json({ error: "对话不存在" });
      return;
    }
    const entries = await readSessionEntries(jsonlPath);
    const leafId = typeof req.query.leafId === "string" ? req.query.leafId : null;
    const tail = typeof req.query.tail === "string" ? Number(req.query.tail) : 0;
    res.json(buildSessionContext(entries, leafId, tail));
  });

  // POST /api/conversations/:key/command —— prompt / abort / get_state / …
  router.post("/:key/command", async (req: Request, res: Response) => {
    const jsonlPath = decodeURIComponent(String(req.params.key));
    const wrapper = getSessionWrapper(jsonlPath);
    if (!wrapper?.isAlive()) {
      // 不自动重开：前端被 404 引导重新开对话（或用户刷新列表）。
      res.status(404).json({ error: "会话不在运行（可能已被空闲回收），请重新打开对话" });
      return;
    }
    try {
      const command = req.body as Record<string, unknown>;
      // context 注入：prompt 命令前缀拼上动态状态（哨兵占位，PRD 实现要点 11）
      if (command.type === "prompt" && typeof command.message === "string") {
        command.message = `${buildContextInjection()}\n\n${command.message}`;
      }
      const result = await wrapper.send(command);
      res.json({ success: true, data: result });
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  // GET /api/conversations/:key/events —— SSE 事件流
  router.get("/:key/events", (req: Request, res: Response) => {
    const jsonlPath = decodeURIComponent(String(req.params.key));
    const wrapper = getSessionWrapper(jsonlPath);
    if (!wrapper?.isAlive()) {
      res.status(404).json({ error: "会话不在运行" });
      return;
    }

    // SSE 头先刷出去（客户端先拿到 200 + Content-Type，事件等 agent ready）
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });

    // Express 没有原生 abort signal：res close 桥到 AbortSignal（stream 层语义不变）
    const abortController = new AbortController();
    req.on("close", () => abortController.abort());

    const stream = createAgentEventStream(
      abortController.signal,
      jsonlPath,
      Promise.resolve(wrapper),
    );

    // Web ReadableStream → Node 响应：手动泵
    void (async () => {
      const reader = stream.getReader();
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          res.write(value);
        }
      } catch {
        // 流侧已 cleanup，写失败（客户端断开）静默
      } finally {
        res.end();
      }
    })();
  });

  // POST /api/conversations/:key/close —— 关闭（主动销毁 wrapper，jsonl 保留）
  router.post("/:key/close", async (req: Request, res: Response) => {
    const jsonlPath = decodeURIComponent(String(req.params.key));
    const wrapper = getSessionWrapper(jsonlPath);
    if (wrapper?.isAlive()) {
      await wrapper.shutdown();
    }
    res.json({ success: true });
  });

  return router;
}
