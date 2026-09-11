import type Database from "better-sqlite3";
import { seedApplication } from "./seed.ts";

/**
 * 建表与初始化数据，schema 以 docs/数据库与目录结构设计.md 为准。
 *
 * 注意：FSRS 的 learning_steps/relearning_steps 由代码固定为 []（关多步学习，
 * 见该文档 topic 表说明），不建列——ts-fsrs 的 Card.learning_steps 恒为 0，
 * 映射层直接丢弃该字段。
 */

const CREATE_TABLES = `
CREATE TABLE IF NOT EXISTS user (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  username      TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS space (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  type       TEXT NOT NULL CHECK (type IN ('learn', 'review', 'ta')),
  name       TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK ((type = 'ta' AND id = 0 AND name = '助教')
      OR (type = 'review' AND id = 1 AND name = '复习')
      OR (type = 'learn' AND id >= 2))
);

CREATE UNIQUE INDEX IF NOT EXISTS space_singleton_type
  ON space(type) WHERE type IN ('review', 'ta');

CREATE TRIGGER IF NOT EXISTS space_protect_fixed_update
  BEFORE UPDATE ON space WHEN OLD.type IN ('review', 'ta')
  BEGIN SELECT RAISE(ABORT, '固定 Space 不可编辑'); END;

CREATE TRIGGER IF NOT EXISTS space_protect_fixed_delete
  BEFORE DELETE ON space WHEN OLD.type IN ('review', 'ta')
  BEGIN SELECT RAISE(ABORT, '固定 Space 不可删除'); END;

CREATE TABLE IF NOT EXISTS agents_md (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  type        TEXT NOT NULL,
  name        TEXT NOT NULL,
  description TEXT,
  prompt      TEXT NOT NULL,

  CHECK (type IN ('learn', 'review', 'ta'))
);

CREATE TABLE IF NOT EXISTS teach_style (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT NOT NULL,
  description TEXT,
  prompt      TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS agents_md_singleton_ta
  ON agents_md(type) WHERE type = 'ta';

CREATE TABLE IF NOT EXISTS pi_session (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  space_id         INTEGER NOT NULL REFERENCES space(id),
  name             TEXT,
  work_path        TEXT NOT NULL UNIQUE,
  path             TEXT NOT NULL UNIQUE,
  agents_md_id     INTEGER NOT NULL REFERENCES agents_md(id),
  teach_style_id   INTEGER REFERENCES teach_style(id),
  enable_make_card INTEGER NOT NULL DEFAULT 1 CHECK (enable_make_card IN (0, 1)),
  review_topic_id  INTEGER REFERENCES topic(id),
  created_at       TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS pi_session_singleton_ta
  ON pi_session(space_id) WHERE space_id = 0;

CREATE INDEX IF NOT EXISTS pi_session_by_space ON pi_session(space_id, id);

CREATE TRIGGER IF NOT EXISTS pi_session_validate_insert
  BEFORE INSERT ON pi_session
  BEGIN
    SELECT CASE WHEN (SELECT type FROM space WHERE id = NEW.space_id)
      != (SELECT type FROM agents_md WHERE id = NEW.agents_md_id)
      THEN RAISE(ABORT, 'Space 与模板类型不匹配') END;
    SELECT CASE WHEN NEW.review_topic_id IS NOT NULL
      AND (SELECT type FROM space WHERE id = NEW.space_id) != 'review'
      THEN RAISE(ABORT, '只有复习对话可以选择 Topic') END;
  END;

CREATE TRIGGER IF NOT EXISTS pi_session_protect_parent
  BEFORE UPDATE OF space_id ON pi_session WHEN NEW.space_id != OLD.space_id
  BEGIN SELECT RAISE(ABORT, 'Pi Session 不可移动到其他 Space'); END;

CREATE TABLE IF NOT EXISTS topic (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  name              TEXT NOT NULL UNIQUE,
  description       TEXT,
  request_retention REAL NOT NULL DEFAULT 0.9,
  maximum_interval  INTEGER NOT NULL DEFAULT 365,
  created_at        TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS card (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  topic_id            INTEGER NOT NULL REFERENCES topic(id),
  front               TEXT NOT NULL,
  back                TEXT NOT NULL,
  status              TEXT NOT NULL DEFAULT 'proposed',
  reason_and_remark   TEXT,
  created_at          TEXT NOT NULL DEFAULT (datetime('now')),

  CHECK (status IN ('proposed', 'normal', 'deleted'))
);

CREATE TABLE IF NOT EXISTS card_schedule (
  card_id        INTEGER PRIMARY KEY REFERENCES card(id) ON DELETE CASCADE,
  state          TEXT NOT NULL DEFAULT 'new',
  due            TEXT NOT NULL,
  stability      REAL NOT NULL,
  difficulty     REAL NOT NULL,
  elapsed_days   INTEGER NOT NULL DEFAULT 0,
  scheduled_days INTEGER NOT NULL DEFAULT 0,
  reps           INTEGER NOT NULL DEFAULT 0,
  lapses         INTEGER NOT NULL DEFAULT 0,
  last_review    TEXT,

  CHECK (state IN ('new', 'learning', 'review', 'relearning'))
);

CREATE TABLE IF NOT EXISTS review_log (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  card_id        INTEGER NOT NULL REFERENCES card(id) ON DELETE CASCADE,
  rating         TEXT NOT NULL,
  state          TEXT NOT NULL,
  due            TEXT NOT NULL,
  stability      REAL NOT NULL,
  difficulty     REAL NOT NULL,
  elapsed_days   INTEGER NOT NULL,
  scheduled_days INTEGER NOT NULL,
  reviewed_at    TEXT NOT NULL DEFAULT (datetime('now')),

  CHECK (rating IN ('Again', 'Hard', 'Good', 'Easy'))
);

CREATE TABLE IF NOT EXISTS glossary (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  term         TEXT NOT NULL UNIQUE,
  definition   TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'proposed',
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),

  CHECK (status IN ('proposed', 'normal', 'deleted'))
);

-- 用户环境变量（ADR-0034）：启动与保存时注入后端 process.env，供模型调用的 skill 子进程继承。
-- 明文存储、明文回显：单用户本机部署，库本身不加密，不再区分隐藏值。
CREATE TABLE IF NOT EXISTS user_env (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- pi-teacher 自己的业务运行设置（ADR-0036 / ADR-0039），与 Pi 的 settings.json 无关。
-- 存维护提醒共用间隔与文案；缺行即取代码默认值，不需要 seed。
CREATE TABLE IF NOT EXISTS setting (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_card_schedule_due
  ON card_schedule (due);

CREATE INDEX IF NOT EXISTS idx_card_topic_status
  ON card (topic_id, status);
`;

/**
 * ADR-0030 不兼容更早的 session 表模型，仍要求显式重建；当前 schema 的独立字段
 * 变更在建表后幂等迁移，不重建卡片或删除文件。user 表保持空表直到 setup。
 */
export function initializeSchema(db: Database.Database, homeDir: string): void {
  if (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'session'").get()) {
    throw new Error("检测到旧 session Schema，无法启动；请备份后使用新的 PI_TEACHER_HOME 数据目录重建，不提供迁移");
  }
  db.pragma("foreign_keys = ON");
  db.exec(CREATE_TABLES);
  dropUserEnvSecretColumn(db);
  dropCardSourceEssencePath(db);
  seedApplication(db, homeDir);
}

/**
 * user_env 曾短暂带过 secret 列（隐藏值），在正式发布前取消。已建过表的数据目录
 * 靠这条幂等迁移去掉该列，行数据不动；CREATE TABLE IF NOT EXISTS 对已有表不生效。
 */
function dropUserEnvSecretColumn(db: Database.Database): void {
  const columns = db.prepare("PRAGMA table_info(user_env)").all() as Array<{ name: string }>;
  if (columns.some((column) => column.name === "secret")) db.exec("ALTER TABLE user_env DROP COLUMN secret");
}

/** 卡片与精华解耦（ADR-0039）：仅删旧来源列，卡片、调度、复习日志及精华文件都保留。 */
function dropCardSourceEssencePath(db: Database.Database): void {
  const columns = db.prepare("PRAGMA table_info(card)").all() as Array<{ name: string }>;
  if (columns.some((column) => column.name === "source_essence_path")) db.exec("ALTER TABLE card DROP COLUMN source_essence_path");
}

