/**
 * 提示词库路由：agents_md 与 teach_style 的增删改查（管理面板两个子页）。
 *
 * 两库正交（数据库与目录结构设计.md）：agents_md 定「做什么」并用 type 区分适用会话类型，
 * teach_style 定「怎么说话」。它们是文件的源，不是文件的镜像——改这里的 prompt
 * 只影响**后续新建**的 Pi Session：投影发生在开对话那一刻（projection/agents-md.ts），
 * 已有对话的 work_path/AGENTS.md、style.md 不回写、不重投影，历史对话当时用的是
 * 哪套提示词由 pi_session.agents_md_id 这个外键追溯。接口在响应里如实告知这一点，
 * 避免前端把「保存成功」讲成「当前对话已切换」。
 *
 * ta 模板是全局唯一的一行（数据库与目录结构设计.md「type 字段」）：助教对话直接取它，不给
 * 用户选，因此本路由不允许新建 ta 模板、不允许删除 ta 模板、也不允许把任何模板的
 * type 改成 ta 或把 ta 改成别的类型——它的 type 就是它的身份。
 */
import { Router } from "express";
import type { Request, Response } from "express";
import type Database from "better-sqlite3";
import type { AppState } from "./app-state.ts";
import { HttpError, readBody, readId, readNullableText, readText } from "./http.ts";

/** 用户可自建的模板类型。ta 不在其中：见文件头说明。 */
const USER_CREATABLE_TYPES = new Set(["learn", "review"]);
const ALL_AGENTS_MD_TYPES = new Set(["learn", "review", "ta"]);

/** 前端管理面板要编辑正文，所以 prompt 一起返回；两库都没有敏感列。 */
const AGENTS_MD_COLUMNS = "id, type, name, description, prompt";
const TEACH_STYLE_COLUMNS = "id, name, description, prompt";

interface AgentsMdRow {
  id: number;
  type: string;
  name: string;
  description: string | null;
  prompt: string;
}

interface TeachStyleRow {
  id: number;
  name: string;
  description: string | null;
  prompt: string;
}

/** 改 prompt 不动已有对话的文件，接口统一带这句提示，前端照抄即可。 */
const PROJECTION_NOTICE = "已保存。新内容在下次新建对话时生效，已有对话的 AGENTS.md / style.md 不会被改写。";

function selectAgentsMd(db: Database.Database, id: number): AgentsMdRow {
  const row = db
    .prepare(`SELECT ${AGENTS_MD_COLUMNS} FROM agents_md WHERE id = ?`)
    .get(id) as AgentsMdRow | undefined;
  if (!row) throw new HttpError(404, "提示词模板不存在");
  return row;
}

function selectTeachStyle(db: Database.Database, id: number): TeachStyleRow {
  const row = db
    .prepare(`SELECT ${TEACH_STYLE_COLUMNS} FROM teach_style WHERE id = ?`)
    .get(id) as TeachStyleRow | undefined;
  if (!row) throw new HttpError(404, "教学风格不存在");
  return row;
}

function countSessionsUsingAgentsMd(db: Database.Database, id: number): number {
  return (db.prepare("SELECT COUNT(*) AS n FROM pi_session WHERE agents_md_id = ?").get(id) as { n: number }).n;
}

function countSessionsUsingTeachStyle(db: Database.Database, id: number): number {
  return (db.prepare("SELECT COUNT(*) AS n FROM pi_session WHERE teach_style_id = ?").get(id) as { n: number }).n;
}

export function createPromptsRouter(state: AppState): Router {
  const router = Router();
  const db = state.db;

  /**
   * GET /api/prompts?type=learn|review|ta
   *
   * 两库并列返回，管理面板一屏管理；新建对话面板传 type 只取该类型的候选。
   * usage_count 让界面能提前解释「为什么不能删」，不必等 409。
   */
  router.get("/", (req: Request, res: Response) => {
    const type = req.query.type;
    if (type !== undefined && (typeof type !== "string" || !ALL_AGENTS_MD_TYPES.has(type))) {
      throw new HttpError(400, "type 只能是 learn / review / ta");
    }
    const agentsMd = db
      .prepare(
        `SELECT a.id, a.type, a.name, a.description, a.prompt,
                (SELECT COUNT(*) FROM pi_session s WHERE s.agents_md_id = a.id) AS usage_count
         FROM agents_md a
         ${type === undefined ? "" : "WHERE a.type = ?"}
         ORDER BY a.type, a.id`,
      )
      .all(...(type === undefined ? [] : [type]));
    const teachStyles = db
      .prepare(
        `SELECT t.id, t.name, t.description, t.prompt,
                (SELECT COUNT(*) FROM pi_session s WHERE s.teach_style_id = t.id) AS usage_count
         FROM teach_style t ORDER BY t.id`,
      )
      .all();
    res.json({ agentsMd, teachStyles });
  });

  // —— agents_md ——

  // POST /api/prompts/agents-md —— 只能建 learn / review，ta 由初始化种入
  router.post("/agents-md", (req: Request, res: Response) => {
    const body = readBody(req.body);
    const type = body.type;
    if (typeof type !== "string" || !USER_CREATABLE_TYPES.has(type)) {
      throw new HttpError(
        400,
        type === "ta"
          ? "助教模板全局唯一，由系统初始化维护，不能新建；请直接编辑现有助教模板"
          : "type 必须是 learn（学习）或 review（复习）",
      );
    }
    const name = readText(body.name, "name", 200);
    const description = readNullableText(body.description ?? null, "description");
    const prompt = readText(body.prompt, "prompt");

    const info = db
      .prepare("INSERT INTO agents_md (type, name, description, prompt) VALUES (?, ?, ?, ?)")
      .run(type, name, description, prompt);
    res.json({ success: true, agentsMd: selectAgentsMd(db, Number(info.lastInsertRowid)) });
  });

  // PATCH /api/prompts/agents-md/:id —— 名称、简介、正文；type 改动受限（见文件头）
  router.patch("/agents-md/:id", (req: Request, res: Response) => {
    const id = readId(req.params.id, "id", true);
    const body = readBody(req.body);
    const current = selectAgentsMd(db, id);

    const name = body.name === undefined ? null : readText(body.name, "name", 200);
    const description =
      body.description === undefined ? undefined : readNullableText(body.description, "description");
    const prompt = body.prompt === undefined ? null : readText(body.prompt, "prompt");

    let nextType = current.type;
    if (body.type !== undefined) {
      const requestedType = body.type;
      if (typeof requestedType !== "string" || !ALL_AGENTS_MD_TYPES.has(requestedType)) {
        throw new HttpError(400, "type 只能是 learn / review / ta");
      }
      if (requestedType !== current.type) {
        // ta 的 type 就是它的身份：既不能被改走，也不能让别的模板改成 ta
        if (current.type === "ta" || requestedType === "ta") {
          throw new HttpError(409, "助教模板的类型不可更改，其他模板也不能改成助教类型");
        }
        // 已被对话引用时换类型会让历史 pi_session 的「模板类型 = Space 类型」失配，
        // 而这个外键是事后追溯凭据（数据库与目录结构设计.md）：要换类型请另建一个模板
        const usageCount = countSessionsUsingAgentsMd(db, id);
        if (usageCount > 0) {
          throw new HttpError(
            409,
            `该模板已被 ${usageCount} 个对话使用，类型不能再改（会与历史对话的会话类型失配）；请新建一个模板`,
          );
        }
        nextType = requestedType;
      }
    }

    if (name === null && description === undefined && prompt === null && nextType === current.type) {
      throw new HttpError(400, "至少要提供 type / name / description / prompt 之一");
    }

    db.prepare("UPDATE agents_md SET type = ?, name = ?, description = ?, prompt = ? WHERE id = ?").run(
      nextType,
      name ?? current.name,
      description === undefined ? current.description : description,
      prompt ?? current.prompt,
      id,
    );
    res.json({ success: true, notice: PROJECTION_NOTICE, agentsMd: selectAgentsMd(db, id) });
  });

  // DELETE /api/prompts/agents-md/:id —— ta 不可删；被引用不可删（外键即追溯凭据）
  router.delete("/agents-md/:id", (req: Request, res: Response) => {
    const id = readId(req.params.id, "id", true);
    const current = selectAgentsMd(db, id);
    if (current.type === "ta") {
      throw new HttpError(409, "助教模板全局唯一且被固定助教对话使用，不能删除；需要调整请编辑正文");
    }
    const usageCount = countSessionsUsingAgentsMd(db, id);
    if (usageCount > 0) {
      throw new HttpError(409, `该模板被 ${usageCount} 个对话引用，不能删除（历史追溯凭据，见数据库与目录结构设计.md）`);
    }
    db.prepare("DELETE FROM agents_md WHERE id = ?").run(id);
    res.json({ success: true });
  });

  // —— teach_style（同构三路由；无 type 概念，风格可用于任何会话）——

  router.post("/teach-style", (req: Request, res: Response) => {
    const body = readBody(req.body);
    const name = readText(body.name, "name", 200);
    const description = readNullableText(body.description ?? null, "description");
    const prompt = readText(body.prompt, "prompt");
    const info = db
      .prepare("INSERT INTO teach_style (name, description, prompt) VALUES (?, ?, ?)")
      .run(name, description, prompt);
    res.json({ success: true, teachStyle: selectTeachStyle(db, Number(info.lastInsertRowid)) });
  });

  router.patch("/teach-style/:id", (req: Request, res: Response) => {
    const id = readId(req.params.id, "id", true);
    const body = readBody(req.body);
    const current = selectTeachStyle(db, id);

    const name = body.name === undefined ? null : readText(body.name, "name", 200);
    const description =
      body.description === undefined ? undefined : readNullableText(body.description, "description");
    const prompt = body.prompt === undefined ? null : readText(body.prompt, "prompt");
    if (name === null && description === undefined && prompt === null) {
      throw new HttpError(400, "至少要提供 name / description / prompt 之一");
    }

    db.prepare("UPDATE teach_style SET name = ?, description = ?, prompt = ? WHERE id = ?").run(
      name ?? current.name,
      description === undefined ? current.description : description,
      prompt ?? current.prompt,
      id,
    );
    res.json({ success: true, notice: PROJECTION_NOTICE, teachStyle: selectTeachStyle(db, id) });
  });

  // DELETE /api/prompts/teach-style/:id —— 被对话引用时必须报 409，不能假成功
  router.delete("/teach-style/:id", (req: Request, res: Response) => {
    const id = readId(req.params.id, "id", true);
    selectTeachStyle(db, id); // 不存在 → 404，避免删除操作静默返回成功
    const usageCount = countSessionsUsingTeachStyle(db, id);
    if (usageCount > 0) {
      throw new HttpError(409, `该风格被 ${usageCount} 个对话引用，不能删除（历史追溯凭据）`);
    }
    db.prepare("DELETE FROM teach_style WHERE id = ?").run(id);
    res.json({ success: true });
  });

  return router;
}
