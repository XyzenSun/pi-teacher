/**
 * schema-check：ADR-0030 新 Schema 的结构性验证（真 SQLite 文件 + 真目录，无 mock）。
 *
 * 与 smoke.ts 的分工：smoke 验证工具行为，本脚本验证「数据库和文件布局本身」的
 * 不变量——这些不变量由建表约束、触发器、唯一索引和 createPiSession 的事务共同
 * 保证，一旦被改坏，业务层的报错会离现场很远，所以单独立一层验证。
 *
 * 覆盖：
 *   1. initializeSchema 幂等（重复初始化不重复建固定行、不覆盖已有投影文件）
 *   2. 旧 session 表拒绝启动（不提供迁移）
 *   3. 固定单例：space(review/ta)、agents_md(ta)、pi_session(ta) 三个唯一索引
 *   4. 固定 Space 保护触发器（不可改名、不可删除）
 *   5. 同一 Space 下两条 Pi Session 的 work_path / AGENTS.md / style.md / JSONL 互不干扰
 *   6. 类型与模板匹配、review_topic_id 归属校验（触发器 + 仓储层双保险）
 *
 * 跑法：npx tsx src/verify/schema-check.ts
 */
import Database from "better-sqlite3";
import { promises as fs, mkdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { initializeSchema } from "../db/schema.ts";
import { createPiSession, getPiSession, sessionKeyFor } from "../session/repository.ts";
import type { PiSessionRow } from "../db/types.ts";

let passed = 0;
let failed = 0;

function check(name: string, condition: boolean, detail?: unknown): void {
  if (condition) {
    passed += 1;
    console.log(`  ✓ ${name}`);
  } else {
    failed += 1;
    console.error(`  ✗ ${name}`);
    if (detail !== undefined) console.error(`      ${String(JSON.stringify(detail)).slice(0, 400)}`);
  }
}

/** 断言一段真实数据库操作被拒绝，并且拒绝原因里带上我们自己的约束语义。 */
function checkRejected(name: string, operation: () => unknown, expectedMessagePart: string): void {
  try {
    operation();
    check(name, false, "未被拒绝（约束或触发器失效）");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    check(name, message.includes(expectedMessagePart), message);
  }
}

function openTempDatabase(homeDir: string): Database.Database {
  // 不用 db/connection.ts 的单例：本脚本要在一个进程里开多个独立数据库
  // （幂等重入、旧 Schema 拒绝各需要一个干净库），单例会直接抛「已打开」。
  const db = new Database(path.join(homeDir, "pi-teacher.db"));
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");
  return db;
}

async function exists(target: string): Promise<boolean> {
  return fs.stat(target).then(() => true).catch(() => false);
}

/** 建一个 learn Space（名字唯一），返回 space_id。 */
function createLearnSpace(db: Database.Database, name: string): number {
  return Number(db.prepare("INSERT INTO space (type, name) VALUES ('learn', ?)").run(name).lastInsertRowid);
}

async function main(): Promise<void> {
  const roots: string[] = [];
  const databases: Database.Database[] = [];
  try {
    // ================= [1] 初始化与幂等 =================
    console.log("\n[1] initializeSchema 幂等与固定数据");
    const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-teacher-schema-"));
    roots.push(homeDir);
    const db = openTempDatabase(homeDir);
    databases.push(db);
    initializeSchema(db, homeDir);

    const BUSINESS_TABLES = [
      "agents_md", "card", "card_schedule", "glossary", "pi_session",
      "review_log", "space", "teach_style", "topic", "user",
    ];
    const tableNames = (db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as Array<{ name: string }>)
      .map((row) => row.name)
      .filter((name) => !name.startsWith("sqlite_"));
    check(
      `业务表集合与 ADR-0030 一致（${BUSINESS_TABLES.length} 张，无 session 表）`,
      tableNames.length === BUSINESS_TABLES.length && BUSINESS_TABLES.every((t) => tableNames.includes(t)),
      tableNames,
    );
    check("旧 session 表已彻底移除", !tableNames.includes("session"), tableNames);

    const spaces = db.prepare("SELECT id, type, name FROM space ORDER BY id").all() as Array<{ id: number; type: string; name: string }>;
    check(
      "固定 Space 两行：0=助教(ta) / 1=复习(review)",
      spaces.length === 2
        && spaces[0].id === 0 && spaces[0].type === "ta" && spaces[0].name === "助教"
        && spaces[1].id === 1 && spaces[1].type === "review" && spaces[1].name === "复习",
      spaces,
    );
    check("user 表初始为空（等 setup 建账号）", (db.prepare("SELECT COUNT(*) AS n FROM user").get() as { n: number }).n === 0);

    const taRow = db.prepare("SELECT * FROM pi_session WHERE space_id = 0").get() as PiSessionRow | undefined;
    check("固定助教 Pi Session 已建（唯一一条，name=助教）", taRow?.name === "助教", taRow);
    check("助教 Pi Session 默认关制卡", taRow?.enable_make_card === 0, taRow?.enable_make_card);
    check(
      "助教工作目录落在 ta/pi/<id>（不与 Space 目录共用）",
      taRow !== undefined && path.resolve(taRow.work_path) === path.resolve(homeDir, "ta", "pi", String(taRow.id)),
      taRow?.work_path,
    );
    check("助教目录已建 AGENTS.md", await exists(path.join(taRow!.work_path, "AGENTS.md")));
    check("助教目录已建 style.md", await exists(path.join(taRow!.work_path, "style.md")));
    check("助教目录已建 attachments/", await exists(path.join(taRow!.work_path, "attachments")));
    const taJsonl = await fs.readFile(taRow!.path, "utf8");
    const taHeader = JSON.parse(taJsonl.trim().split("\n")[0]) as { type: string; id: string; cwd: string };
    check(
      "助教 JSONL 首行是真实 SDK header（稳定 id + cwd 指向 pi 目录）",
      taHeader.type === "session"
        && taHeader.id === sessionKeyFor(taRow!.id)
        && path.resolve(taHeader.cwd) === path.resolve(taRow!.work_path),
      taHeader,
    );
    const taTemplatePrompt = (db.prepare("SELECT prompt FROM agents_md WHERE id = ?").get(taRow!.agents_md_id) as { prompt: string }).prompt;
    check(
      "助教 AGENTS.md 是数据库模板的单向投影",
      (await fs.readFile(path.join(taRow!.work_path, "AGENTS.md"), "utf8")) === taTemplatePrompt,
    );

    // 幂等：重入不得再建一条助教、不得覆盖用户已编辑的投影文件
    const editedMarker = "# 用户手工编辑过的助教提示词\n";
    await fs.writeFile(path.join(taRow!.work_path, "AGENTS.md"), editedMarker, "utf8");
    const beforeCounts = {
      space: (db.prepare("SELECT COUNT(*) AS n FROM space").get() as { n: number }).n,
      pi: (db.prepare("SELECT COUNT(*) AS n FROM pi_session").get() as { n: number }).n,
      agentsMd: (db.prepare("SELECT COUNT(*) AS n FROM agents_md").get() as { n: number }).n,
      style: (db.prepare("SELECT COUNT(*) AS n FROM teach_style").get() as { n: number }).n,
    };
    initializeSchema(db, homeDir);
    initializeSchema(db, homeDir);
    const afterCounts = {
      space: (db.prepare("SELECT COUNT(*) AS n FROM space").get() as { n: number }).n,
      pi: (db.prepare("SELECT COUNT(*) AS n FROM pi_session").get() as { n: number }).n,
      agentsMd: (db.prepare("SELECT COUNT(*) AS n FROM agents_md").get() as { n: number }).n,
      style: (db.prepare("SELECT COUNT(*) AS n FROM teach_style").get() as { n: number }).n,
    };
    check("重复初始化行数完全不变（幂等）", JSON.stringify(beforeCounts) === JSON.stringify(afterCounts), { beforeCounts, afterCounts });
    check(
      "重入不覆盖已存在的投影文件（用户编辑不被模板污染）",
      (await fs.readFile(path.join(taRow!.work_path, "AGENTS.md"), "utf8")) === editedMarker,
    );
    check("重入后助教 JSONL 未被重写", (await fs.readFile(taRow!.path, "utf8")) === taJsonl);

    // ================= [2] 旧 Schema 拒绝启动 =================
    console.log("\n[2] 旧 session Schema 拒绝启动（不提供迁移）");
    const legacyHome = await fs.mkdtemp(path.join(os.tmpdir(), "pi-teacher-legacy-"));
    roots.push(legacyHome);
    const legacyDb = openTempDatabase(legacyHome);
    databases.push(legacyDb);
    legacyDb.exec("CREATE TABLE session (id INTEGER PRIMARY KEY, name TEXT, work_path TEXT)");
    checkRejected("检测到旧 session 表时拒绝初始化", () => initializeSchema(legacyDb, legacyHome), "检测到旧 session Schema");
    check(
      "拒绝时不建任何新表（旧数据原样保留，不静默丢弃）",
      (legacyDb.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name='pi_session'").get() as { n: number }).n === 0,
    );

    // ================= [3] 固定单例唯一索引 =================
    console.log("\n[3] 固定单例约束");
    // 固定 Space 有两道防线：CHECK 把 (type, id, name) 三者钉死，唯一索引再拦
    // 同类型第二行。CHECK 先触发，所以这里按「任何 id 都插不进去」来断言，
    // 并单独确认唯一索引确实存在（它是绕过 CHECK 的并发路径的最后一道防线）。
    checkRejected(
      "第二个 ta Space 用普通 id 被 CHECK 拒绝",
      () => db.prepare("INSERT INTO space (id, type, name) VALUES (100, 'ta', '助教')").run(),
      "CHECK constraint failed",
    );
    checkRejected(
      "第二个 ta Space 用固定 id 被主键拒绝",
      () => db.prepare("INSERT INTO space (id, type, name) VALUES (0, 'ta', '助教')").run(),
      "UNIQUE constraint failed: space.id",
    );
    checkRejected(
      "第二个 review Space 用普通 id 被 CHECK 拒绝",
      () => db.prepare("INSERT INTO space (id, type, name) VALUES (101, 'review', '复习')").run(),
      "CHECK constraint failed",
    );
    checkRejected(
      "第二个 review Space 用固定 id 被主键拒绝",
      () => db.prepare("INSERT INTO space (id, type, name) VALUES (1, 'review', '复习')").run(),
      "UNIQUE constraint failed: space.id",
    );
    checkRejected(
      "learn Space 不能占用固定 id（CHECK 要求 id >= 2）",
      () => db.prepare("INSERT INTO space (id, type, name) VALUES (1, 'learn', '想篡位的学习空间')").run(),
      "CHECK constraint failed",
    );
    const singletonIndex = db.prepare(
      "SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'space_singleton_type'",
    ).get() as { sql: string } | undefined;
    check(
      "space_singleton_type 唯一索引存在且限定 review/ta",
      singletonIndex !== undefined && singletonIndex.sql.includes("review") && singletonIndex.sql.includes("ta"),
      singletonIndex?.sql,
    );
    check("固定 Space 依然只有两行", (db.prepare("SELECT COUNT(*) AS n FROM space").get() as { n: number }).n === 2);
    checkRejected(
      "第二个 ta 提示词模板被唯一索引拒绝（助教模板全局唯一）",
      () => db.prepare("INSERT INTO agents_md (type, name, prompt) VALUES ('ta', '助教模板2', 'x')").run(),
      "UNIQUE",
    );
    checkRejected(
      "第二条助教 Pi Session 被唯一索引拒绝",
      () => db.prepare(`INSERT INTO pi_session (space_id, work_path, path, agents_md_id)
        VALUES (0, ?, ?, 0)`).run(path.join(homeDir, "ta", "pi", "999"), path.join(homeDir, "ta", "pi", "999", "x.jsonl")),
      "UNIQUE",
    );
    checkRejected(
      "createPiSession 不允许业务代码新建助教对话（复用固定那条）",
      () => createPiSession(db, homeDir, { spaceId: 0, agentsMdId: 0 }),
      "助教 Pi Session 全局唯一",
    );
    // 初始化专用入口（allowFixedTa）必须复用同一条，而不是再建
    const reusedTa = createPiSession(db, homeDir, { spaceId: 0, agentsMdId: 0 }, true);
    check("固定助教入口幂等复用同一条记录", reusedTa.id === taRow!.id, { reused: reusedTa.id, original: taRow!.id });
    check("空间类型非法值被 CHECK 拒绝", (() => {
      try {
        db.prepare("INSERT INTO space (type, name) VALUES ('other', 'x')").run();
        return false;
      } catch { return true; }
    })());

    // ================= [4] 固定 Space 保护触发器 =================
    console.log("\n[4] 固定 Space 保护");
    checkRejected(
      "固定助教 Space 不可改名",
      () => db.prepare("UPDATE space SET name = '改名助教' WHERE id = 0").run(),
      "固定 Space 不可编辑",
    );
    checkRejected(
      "固定复习 Space 不可改名",
      () => db.prepare("UPDATE space SET name = '改名复习' WHERE id = 1").run(),
      "固定 Space 不可编辑",
    );
    checkRejected(
      "固定助教 Space 不可删除",
      () => db.prepare("DELETE FROM space WHERE id = 0").run(),
      "固定 Space 不可删除",
    );
    checkRejected(
      "固定复习 Space 不可删除",
      () => db.prepare("DELETE FROM space WHERE id = 1").run(),
      "固定 Space 不可删除",
    );
    const fixedStillThere = db.prepare("SELECT COUNT(*) AS n FROM space WHERE id IN (0, 1)").get() as { n: number };
    check("两个固定 Space 仍在", fixedStillThere.n === 2);
    // learn Space 是用户资产：可以改名、可以删除，别被保护触发器误伤
    const disposableId = createLearnSpace(db, "可删除的学习空间");
    db.prepare("UPDATE space SET name = '改过名的学习空间' WHERE id = ?").run(disposableId);
    check("learn Space 可以改名", (db.prepare("SELECT name FROM space WHERE id = ?").get(disposableId) as { name: string }).name === "改过名的学习空间");
    db.prepare("DELETE FROM space WHERE id = ?").run(disposableId);
    check("learn Space 可以删除", db.prepare("SELECT id FROM space WHERE id = ?").get(disposableId) === undefined);

    // ================= [5] 同 Space 下两条 Pi Session 完全独立 =================
    console.log("\n[5] 同一 Space 两条 Pi Session 互不干扰（ADR-0030 核心）");
    const learnSpaceId = createLearnSpace(db, "机器学习");
    // 两套不同的模板与风格：只要投影串了，内容断言立刻能发现
    const javaAgentsId = Number(db.prepare(
      "INSERT INTO agents_md (type, name, description, prompt) VALUES ('learn', 'Java 模板', 'x', ?)",
    ).run("# Java 学习模板\n只讲 JVM。").lastInsertRowid);
    const redisAgentsId = Number(db.prepare(
      "INSERT INTO agents_md (type, name, description, prompt) VALUES ('learn', 'Redis 模板', 'x', ?)",
    ).run("# Redis 学习模板\n只讲缓存。").lastInsertRowid);
    const directStyleId = Number(db.prepare(
      "INSERT INTO teach_style (name, description, prompt) VALUES ('直给', 'x', ?)",
    ).run("先结论后解释。").lastInsertRowid);
    const socraticStyleId = Number(db.prepare(
      "INSERT INTO teach_style (name, description, prompt) VALUES ('苏格拉底', 'x', ?)",
    ).run("只反问不给答案。").lastInsertRowid);

    const javaSession = createPiSession(db, homeDir, {
      spaceId: learnSpaceId, agentsMdId: javaAgentsId, teachStyleId: directStyleId, enableMakeCard: true,
    });
    const redisSession = createPiSession(db, homeDir, {
      spaceId: learnSpaceId, agentsMdId: redisAgentsId, teachStyleId: socraticStyleId, enableMakeCard: false,
    });

    check("两条 Pi Session 归属同一个 Space", javaSession.space_id === learnSpaceId && redisSession.space_id === learnSpaceId);
    check("work_path 各自独立", javaSession.work_path !== redisSession.work_path, [javaSession.work_path, redisSession.work_path]);
    check(
      "work_path 布局为 learn/<space-id>/pi/<pi-session-id>",
      path.resolve(javaSession.work_path) === path.resolve(homeDir, "learn", String(learnSpaceId), "pi", String(javaSession.id))
        && path.resolve(redisSession.work_path) === path.resolve(homeDir, "learn", String(learnSpaceId), "pi", String(redisSession.id)),
      [javaSession.work_path, redisSession.work_path],
    );
    check(
      "Space 目录本身不是任何 Pi 的 cwd（Space 只是收纳容器）",
      path.resolve(javaSession.work_path) !== path.resolve(homeDir, "learn", String(learnSpaceId))
        && path.resolve(redisSession.work_path) !== path.resolve(homeDir, "learn", String(learnSpaceId)),
    );

    const javaAgentsFile = await fs.readFile(path.join(javaSession.work_path, "AGENTS.md"), "utf8");
    const redisAgentsFile = await fs.readFile(path.join(redisSession.work_path, "AGENTS.md"), "utf8");
    check("AGENTS.md 各自投影且互不覆盖", javaAgentsFile.includes("只讲 JVM") && redisAgentsFile.includes("只讲缓存"), { javaAgentsFile, redisAgentsFile });
    const javaStyleFile = await fs.readFile(path.join(javaSession.work_path, "style.md"), "utf8");
    const redisStyleFile = await fs.readFile(path.join(redisSession.work_path, "style.md"), "utf8");
    check("style.md 各自投影且互不覆盖", javaStyleFile.includes("先结论") && redisStyleFile.includes("只反问"), { javaStyleFile, redisStyleFile });
    check("JSONL 路径各自独立", javaSession.path !== redisSession.path, [javaSession.path, redisSession.path]);
    check(
      "两条 JSONL 都在自己的 pi 目录内",
      path.dirname(path.resolve(javaSession.path)) === path.resolve(javaSession.work_path)
        && path.dirname(path.resolve(redisSession.path)) === path.resolve(redisSession.work_path),
    );
    const javaHeader = JSON.parse((await fs.readFile(javaSession.path, "utf8")).trim().split("\n")[0]) as { id: string; cwd: string };
    const redisHeader = JSON.parse((await fs.readFile(redisSession.path, "utf8")).trim().split("\n")[0]) as { id: string; cwd: string };
    check(
      "两条 JSONL header 的稳定 id 与 cwd 各自对应自己的 Pi Session",
      javaHeader.id === sessionKeyFor(javaSession.id) && redisHeader.id === sessionKeyFor(redisSession.id)
        && path.resolve(javaHeader.cwd) === path.resolve(javaSession.work_path)
        && path.resolve(redisHeader.cwd) === path.resolve(redisSession.work_path),
      { javaHeader, redisHeader },
    );
    check("attachments/ 每条对话各自一份",
      await exists(path.join(javaSession.work_path, "attachments")) && await exists(path.join(redisSession.work_path, "attachments")));
    check("制卡开关按对话独立存储", javaSession.enable_make_card === 1 && redisSession.enable_make_card === 0);

    // 一条对话往自己目录写私有文件，不出现在另一条对话目录里
    await fs.writeFile(path.join(javaSession.work_path, "MISSION.md"), "# 学 JVM", "utf8");
    check(
      "私有文件不泄漏到同 Space 的另一条对话",
      await exists(path.join(javaSession.work_path, "MISSION.md"))
        && !(await exists(path.join(redisSession.work_path, "MISSION.md"))),
    );

    checkRejected(
      "work_path 唯一（同一目录不能挂两条对话）",
      () => db.prepare("INSERT INTO pi_session (space_id, work_path, path, agents_md_id) VALUES (?, ?, ?, ?)")
        .run(learnSpaceId, javaSession.work_path, path.join(javaSession.work_path, "other.jsonl"), javaAgentsId),
      "UNIQUE",
    );
    checkRejected(
      "JSONL 路径唯一（同一会话文件不能挂两条对话）",
      () => db.prepare("INSERT INTO pi_session (space_id, work_path, path, agents_md_id) VALUES (?, ?, ?, ?)")
        .run(learnSpaceId, path.join(homeDir, "learn", String(learnSpaceId), "pi", "888"), javaSession.path, javaAgentsId),
      "UNIQUE",
    );
    checkRejected(
      "Pi Session 不可移动到其他 Space",
      () => db.prepare("UPDATE pi_session SET space_id = ? WHERE id = ?").run(1, javaSession.id),
      "不可移动到其他 Space",
    );
    check("目标目录已存在时拒绝建对话（不覆盖磁盘上已有内容）", (() => {
      const nextId = (db.prepare(`SELECT MAX(
        COALESCE((SELECT seq FROM sqlite_sequence WHERE name = 'pi_session'), 0),
        COALESCE((SELECT MAX(id) FROM pi_session), 0)) + 1 AS next_id`).get() as { next_id: number }).next_id;
      const squatted = path.join(homeDir, "learn", String(learnSpaceId), "pi", String(nextId));
      mkdirSync(squatted, { recursive: true });
      try {
        createPiSession(db, homeDir, { spaceId: learnSpaceId, agentsMdId: javaAgentsId });
        return false;
      } catch (error) {
        return error instanceof Error && error.message.includes("目标目录已存在");
      } finally {
        rmSync(squatted, { recursive: true, force: true });
      }
    })());

    // ================= [6] 类型模板与 Topic 归属校验 =================
    console.log("\n[6] 类型模板匹配与复习 Topic 校验");
    const reviewAgentsId = (db.prepare("SELECT id FROM agents_md WHERE type = 'review'").get() as { id: number }).id;
    checkRejected(
      "learn Space 配 review 模板被仓储层拒绝",
      () => createPiSession(db, homeDir, { spaceId: learnSpaceId, agentsMdId: reviewAgentsId }),
      "与 Space 类型不匹配",
    );
    checkRejected(
      "review Space 配 learn 模板被仓储层拒绝",
      () => createPiSession(db, homeDir, { spaceId: 1, agentsMdId: javaAgentsId }),
      "与 Space 类型不匹配",
    );
    checkRejected(
      "不存在的模板 id 被拒绝",
      () => createPiSession(db, homeDir, { spaceId: learnSpaceId, agentsMdId: 99999 }),
      "Agents Md 不存在",
    );
    checkRejected(
      "不存在的教学风格被拒绝",
      () => createPiSession(db, homeDir, { spaceId: learnSpaceId, agentsMdId: javaAgentsId, teachStyleId: 99999 }),
      "Teach Style 不存在",
    );
    // 触发器是数据库层的兜底：绕过仓储层直接插也必须被拦
    checkRejected(
      "绕过仓储层直插类型不匹配也被触发器拦下",
      () => db.prepare("INSERT INTO pi_session (space_id, work_path, path, agents_md_id) VALUES (?, ?, ?, ?)")
        .run(learnSpaceId, path.join(homeDir, "bypass-1"), path.join(homeDir, "bypass-1.jsonl"), reviewAgentsId),
      "Space 与模板类型不匹配",
    );

    const topicId = Number(db.prepare("INSERT INTO topic (name, description) VALUES ('JVM', '造数')").run().lastInsertRowid);
    checkRejected(
      "learn 对话选复习 Topic 被仓储层拒绝",
      () => createPiSession(db, homeDir, { spaceId: learnSpaceId, agentsMdId: javaAgentsId, reviewTopicId: topicId }),
      "只有复习 Pi Session 可以选择 Topic",
    );
    checkRejected(
      "绕过仓储层给 learn 对话塞 review_topic_id 也被触发器拦下",
      () => db.prepare("INSERT INTO pi_session (space_id, work_path, path, agents_md_id, review_topic_id) VALUES (?, ?, ?, ?, ?)")
        .run(learnSpaceId, path.join(homeDir, "bypass-2"), path.join(homeDir, "bypass-2.jsonl"), javaAgentsId, topicId),
      "只有复习对话可以选择 Topic",
    );
    checkRejected(
      "复习对话选不存在的 Topic 被拒绝",
      () => createPiSession(db, homeDir, { spaceId: 1, agentsMdId: reviewAgentsId, reviewTopicId: 99999 }),
      "复习 Topic 不存在",
    );

    const reviewSession = createPiSession(db, homeDir, {
      spaceId: 1, agentsMdId: reviewAgentsId, reviewTopicId: topicId,
    });
    check("复习对话可以绑定 Topic", reviewSession.review_topic_id === topicId, reviewSession.review_topic_id);
    check(
      "复习对话目录布局为 review/pi/<pi-session-id>",
      path.resolve(reviewSession.work_path) === path.resolve(homeDir, "review", "pi", String(reviewSession.id)),
      reviewSession.work_path,
    );
    const reviewSessionAgain = createPiSession(db, homeDir, { spaceId: 1, agentsMdId: reviewAgentsId });
    check("固定复习 Space 允许多条复习对话", reviewSessionAgain.id !== reviewSession.id);
    check(
      "getPiSession 带出 space_type（工具上下文靠它裁决权限）",
      getPiSession(db, reviewSession.id).space_type === "review" && getPiSession(db, javaSession.id).space_type === "learn",
    );

    // 失败路径不留垃圾目录：上面那些被拒绝的 createPiSession 不应留下空目录
    const learnPiDir = path.join(homeDir, "learn", String(learnSpaceId), "pi");
    const learnPiDirs = (await fs.readdir(learnPiDir)).sort();
    const expectedLearnPiDirs = [String(javaSession.id), String(redisSession.id)].sort();
    check(
      "被拒绝的建对话请求不残留目录（文件系统与数据库一致）",
      JSON.stringify(learnPiDirs) === JSON.stringify(expectedLearnPiDirs),
      { learnPiDirs, expectedLearnPiDirs },
    );
    const dbPiIds = (db.prepare("SELECT id FROM pi_session WHERE space_id = ? ORDER BY id").all(learnSpaceId) as Array<{ id: number }>).map((r) => r.id);
    check("数据库里该 Space 也只有这两条对话", JSON.stringify(dbPiIds) === JSON.stringify([javaSession.id, redisSession.id]), dbPiIds);

    console.log(`\n结果：${passed} 通过，${failed} 失败`);
  } finally {
    for (const db of databases) {
      try { db.close(); } catch { /* 已关闭 */ }
    }
    for (const root of roots) {
      await fs.rm(root, { recursive: true, force: true }).catch(() => {});
    }
  }
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((error) => {
  console.error("schema-check 异常退出：", error);
  process.exit(1);
});
