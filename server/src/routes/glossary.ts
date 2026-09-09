/**
 * 术语路由：全局术语库的三态管理（管理面板 Glossary 子页）。
 *
 * 孤立表，无外键（数据库设计.md）：term 全局唯一，status 与 card 完全同构
 * （proposed / normal / deleted）。删除一律软删——错删一条术语会持续扭曲
 * 讲解（AI 以为用户懂了就跳过），所以要留恢复余地。
 *
 * 唯一约束冲突（同名 term）不在这里逐个查重，交给中央错误中间件把
 * SQLITE_CONSTRAINT_UNIQUE 翻成 409，少一次查询也少一处竞态。
 */
import { Router } from "express";
import type { Request, Response } from "express";
import type Database from "better-sqlite3";
import type { AppState } from "./app-state.ts";
import { readTriStateFilter } from "./cards.ts";
import { HttpError, readBody, readId, readText } from "./http.ts";

interface GlossaryRow {
  id: number;
  term: string;
  definition: string;
  status: string;
  created_at: string;
}

/** 列名写全而不用 SELECT *：表结构变化时接口契约不跟着漂。 */
const GLOSSARY_COLUMNS = "id, term, definition, status, created_at";

function selectTerm(db: Database.Database, termId: number): GlossaryRow {
  const row = db
    .prepare(`SELECT ${GLOSSARY_COLUMNS} FROM glossary WHERE id = ?`)
    .get(termId) as GlossaryRow | undefined;
  if (!row) throw new HttpError(404, "术语不存在");
  return row;
}

export function createGlossaryRouter(state: AppState): Router {
  const router = Router();
  const db = state.db;

  // GET /api/glossary?status=proposed|normal|deleted|all（缺省 = proposed + normal）
  router.get("/", (req: Request, res: Response) => {
    const status = readTriStateFilter(req.query.status);
    let where = "WHERE status != 'deleted'";
    const params: unknown[] = [];
    if (status === "all") {
      where = "";
    } else if (status !== null) {
      where = "WHERE status = ?";
      params.push(status);
    }
    const terms = db
      .prepare(`SELECT ${GLOSSARY_COLUMNS} FROM glossary ${where} ORDER BY id DESC`)
      .all(...params) as GlossaryRow[];
    res.json({ terms });
  });

  // POST /api/glossary —— 用户手动添加：直接 normal（手动录入即确认，见 ADR-0005）
  router.post("/", (req: Request, res: Response) => {
    const body = readBody(req.body);
    // term 是唯一键，长度给紧一点：它是一个术语名，不是一段定义
    const term = readText(body.term, "term", 200);
    const definition = readText(body.definition, "definition");
    const info = db
      .prepare("INSERT INTO glossary (term, definition, status) VALUES (?, ?, 'normal')")
      .run(term, definition);
    res.json({ success: true, term: selectTerm(db, Number(info.lastInsertRowid)) });
  });

  // PATCH /api/glossary/:id —— 改术语名或定义（状态流转走下面的动作路由）
  router.patch("/:id", (req: Request, res: Response) => {
    const termId = readId(req.params.id, "id");
    const body = readBody(req.body);
    const current = selectTerm(db, termId);
    const term = body.term === undefined ? null : readText(body.term, "term", 200);
    const definition = body.definition === undefined ? null : readText(body.definition, "definition");
    if (term === null && definition === null) {
      throw new HttpError(400, "至少要提供 term 或 definition");
    }
    db.prepare("UPDATE glossary SET term = ?, definition = ? WHERE id = ?").run(
      term ?? current.term,
      definition ?? current.definition,
      termId,
    );
    res.json({ success: true, term: selectTerm(db, termId) });
  });

  // POST /api/glossary/:id/confirm —— proposed → normal（幂等）
  router.post("/:id/confirm", (req: Request, res: Response) => {
    const termId = readId(req.params.id, "id");
    const current = selectTerm(db, termId);
    if (current.status === "deleted") throw new HttpError(409, "已删除的术语不能确认，请先恢复");
    const changed = current.status !== "normal";
    if (changed) db.prepare("UPDATE glossary SET status = 'normal' WHERE id = ?").run(termId);
    res.json({ success: true, changed, term: selectTerm(db, termId) });
  });

  // POST /api/glossary/:id/reject —— proposed → deleted（未确认的提议被否）
  router.post("/:id/reject", (req: Request, res: Response) => {
    const termId = readId(req.params.id, "id");
    const current = selectTerm(db, termId);
    if (current.status === "deleted") {
      res.json({ success: true, changed: false, term: current }); // 幂等
      return;
    }
    if (current.status !== "proposed") {
      throw new HttpError(409, "只有待确认的提议术语可以拒绝，已确认的请用删除");
    }
    db.prepare("UPDATE glossary SET status = 'deleted' WHERE id = ?").run(termId);
    res.json({ success: true, changed: true, term: selectTerm(db, termId) });
  });

  // POST /api/glossary/:id/delete —— 软删（用户其实没懂，或定义要重写）
  router.post("/:id/delete", (req: Request, res: Response) => {
    const termId = readId(req.params.id, "id");
    const current = selectTerm(db, termId);
    const changed = current.status !== "deleted";
    if (changed) db.prepare("UPDATE glossary SET status = 'deleted' WHERE id = ?").run(termId);
    res.json({ success: true, changed, term: selectTerm(db, termId) });
  });

  /**
   * POST /api/glossary/:id/restore —— 回收站恢复。
   *
   * 恢复到 normal 而不是 proposed：术语表没有调度这类附属状态，能判断来路的
   * 信息也不存在；用户从回收站主动捞回来，意图就是「这条我确实掌握」。
   */
  router.post("/:id/restore", (req: Request, res: Response) => {
    const termId = readId(req.params.id, "id");
    const current = selectTerm(db, termId);
    if (current.status !== "deleted") throw new HttpError(409, "只有已删除的术语可以恢复");
    db.prepare("UPDATE glossary SET status = 'normal' WHERE id = ?").run(termId);
    res.json({ success: true, restoredStatus: "normal", term: selectTerm(db, termId) });
  });

  return router;
}
