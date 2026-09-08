import type Database from "better-sqlite3";

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
  id       INTEGER PRIMARY KEY,
  name     TEXT NOT NULL,
  version  INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS session (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT NOT NULL,
  work_path  TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

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

CREATE TABLE IF NOT EXISTS pi_session (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id       INTEGER REFERENCES session(id),
  space_id         INTEGER NOT NULL REFERENCES space(id),
  name             TEXT,
  path             TEXT NOT NULL UNIQUE,
  agents_md_id     INTEGER NOT NULL REFERENCES agents_md(id),
  teach_style_id   INTEGER REFERENCES teach_style(id),
  enable_make_card INTEGER NOT NULL DEFAULT 1,
  review_topic_id  INTEGER REFERENCES topic(id),
  created_at       TEXT NOT NULL DEFAULT (datetime('now')),

  CHECK (space_id = 2 OR review_topic_id IS NULL),
  CHECK (space_id = 1 OR session_id IS NULL OR session_id = 0)
);

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
 * 初始化固定数据。幂等：重复执行不产生重复行。
 * user 表刻意不插行：首启动表空 → 认证层返回 needs-setup → 强制设密码页。
 *
 * - space 三行固定，id 与 agents_md.type 的映射见数据库设计.md
 * - session 0 号行是全局唯一助教工作区，AUTOINCREMENT 从 1 开始所以必须显式插 id=0
 */
export function initializeSchema(db: Database.Database): void {
    db.exec(CREATE_TABLES);

    db.prepare(
        "INSERT OR IGNORE INTO space (id, name) VALUES (0, '助教'), (1, '学习'), (2, '复习')",
    ).run();

    db.prepare(
        "INSERT OR IGNORE INTO session (id, name, work_path) VALUES (0, '助教', '~/pi-teacher/ta')",
    ).run();
}
