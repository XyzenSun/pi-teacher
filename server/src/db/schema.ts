import type Database from "better-sqlite3";
import { seedApplication } from "./seed.ts";

/**
 * 建表与初始化数据，schema 以 ../../../../数据库设计.md 为准。
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
  source_essence_path TEXT,
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

CREATE INDEX IF NOT EXISTS idx_card_schedule_due
  ON card_schedule (due);

CREATE INDEX IF NOT EXISTS idx_card_topic_status
  ON card (topic_id, status);
`;

/**
 * 新 Schema 不迁移、不兼容旧 session 模型。旧部署必须显式重建数据，不能在
 * 普通启动中悄悄丢弃文件；验证总是使用真实临时数据库。user 表保持空表直到 setup。
 */
export function initializeSchema(db: Database.Database, homeDir: string): void {
  if (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'session'").get()) {
    throw new Error("检测到旧 session Schema，无法启动；请备份后使用新的 PI_TEACHER_HOME 数据目录重建，不提供迁移");
  }
  db.pragma("foreign_keys = ON");
  db.exec(CREATE_TABLES);
  seedApplication(db, homeDir);
}

