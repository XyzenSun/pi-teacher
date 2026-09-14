import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import type Database from "better-sqlite3";
import { createPiSession, SESSION_FILES_DIR_NAME } from "../session/repository.ts";
import { projectAgentsMd } from "../projection/agents-md.ts";
import {
  AGENTS_MD_TEMPLATES,
  GLOBAL_AGENTS_MD,
  MATERIALS_INDEX_PLACEHOLDER,
  TEACH_STYLE_TEMPLATES,
  USER_PREFERENCES_PLACEHOLDER,
} from "../prompts/defaults.ts";

// 所有出厂文案都在 prompts/defaults.ts；本文件只负责「什么时候写、写到哪」。

/** 只补缺失的文件，已有内容一个字节都不改：用户与模型都可能已经编辑过。 */
function writeIfMissing(filePath: string, content: string): void {
  if (existsSync(filePath)) return;
  writeFileSync(filePath, content, { encoding: "utf8", mode: 0o644 });
}

/**
 * homeDir 下的全局文件与目录：~/pi-teacher/ 下的 AGENTS.md、USER.md、materials/
 * 与 assets/ 等，由本函数幂等补建（只补缺失，不覆盖已有内容）。
 * 全局 AGENTS.md 靠 Pi 的祖先目录发现进入每个会话的 system prompt，
 * 因此它必须在任何会话创建之前就存在于 work_path 的祖先位置。
 */
export function ensureGlobalLayout(homeDir: string): void {
  for (const directory of ["materials/origins", "assets", "llm-text-to-img"]) {
    mkdirSync(path.join(homeDir, directory), { recursive: true });
  }
  writeIfMissing(path.join(homeDir, "AGENTS.md"), GLOBAL_AGENTS_MD);
  writeIfMissing(path.join(homeDir, "USER.md"), USER_PREFERENCES_PLACEHOLDER);
  writeIfMissing(path.join(homeDir, "materials", "index.md"), MATERIALS_INDEX_PLACEHOLDER);
}

/** 默认模板只填充缺失行，绝不覆盖用户在管理面板里编辑过的正文。 */
export function seedApplication(db: Database.Database, homeDir: string): void {
  ensureGlobalLayout(homeDir);
  const { ta, learn, review } = AGENTS_MD_TEMPLATES;
  db.transaction(() => {
    db.prepare("INSERT OR IGNORE INTO space (id, type, name) VALUES (0, 'ta', '助教'), (1, 'review', '复习')").run();
    // 助教固定 id = 0；学习 / 复习按类型补一条，用户已建过同类型模板就不再塞默认的。
    db.prepare("INSERT OR IGNORE INTO agents_md (id, type, name, description, prompt) VALUES (0, 'ta', ?, ?, ?)").run(ta.name, ta.description, ta.prompt);
    const insertTemplate = db.prepare("INSERT INTO agents_md (type, name, description, prompt) VALUES (?, ?, ?, ?)");
    if (!db.prepare("SELECT id FROM agents_md WHERE type = 'learn'").get()) insertTemplate.run("learn", learn.name, learn.description, learn.prompt);
    if (!db.prepare("SELECT id FROM agents_md WHERE type = 'review'").get()) insertTemplate.run("review", review.name, review.description, review.prompt);
    if (!db.prepare("SELECT id FROM teach_style LIMIT 1").get()) {
      const insertStyle = db.prepare("INSERT INTO teach_style (name, description, prompt) VALUES (?, ?, ?)");
      for (const style of TEACH_STYLE_TEMPLATES) insertStyle.run(style.name, style.description, style.prompt);
    }
  }).immediate();
  const taSession = createPiSession(db, homeDir, { spaceId: 0, agentsMdId: 0, enableMakeCard: false }, true);
  mkdirSync(taSession.work_path, { recursive: true });
  mkdirSync(path.join(taSession.work_path, SESSION_FILES_DIR_NAME), { recursive: true });
  // 初始化重入只补缺失文件，已有对话保持创建时的投影，不受模板后续编辑污染。
  if (!existsSync(path.join(taSession.work_path, "AGENTS.md"))) projectAgentsMd(db, taSession.work_path, taSession.agents_md_id);
  // 助教不再有教学风格：旧数据目录里的 style.md 是程序投影而非用户内容，直接删掉。
  rmSync(path.join(taSession.work_path, "style.md"), { force: true });
}
