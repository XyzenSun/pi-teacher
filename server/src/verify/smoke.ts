import Database from "better-sqlite3";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { initializeSchema } from "../db/schema.ts";
import { createInitialSchedule } from "../fsrs/service.ts";
import { createPiSession } from "../session/repository.ts";
import { createPiTeacherExtension } from "../tools/factory.ts";
import { createCardTopicTools } from "../tools/cards.ts";
import { createGlossaryTools } from "../tools/glossary.ts";
import { createReviewTools } from "../tools/review.ts";
import { createFileTools } from "../tools/files.ts";
import { createImageTools } from "../tools/images.ts";
import { toolContextFor, type SessionToolContext } from "../tools/context.ts";

/**
 * 直调冒烟测试：不起模型，直接调工具的 execute，覆盖全部 16 个工具的
 * 正常路径与关键拒绝路径（PRD 验收清单「工具直调冒烟」项）。
 * 测的是真数据库、真文件系统，不涉及 mock；模型驱动路径由 run-real.ts 验证。
 *
 * ADR-0030 适配要点：
 * - 工具上下文由真实 pi_session 行经 toolContextFor 构造，不再手写 spaceId：
 *   权限裁决读的是 space.type，手写字面量测不到「类型从数据库来」这件事。
 * - 每条 Pi Session 独占 work_path，文件工具的相对路径基于它解析。
 * - 临时 home 目录 + 临时 SQLite 文件，跑完清理，不再写 server/dev-data
 *   （那是旧用户数据目录）。
 *
 * 工具集变更注记：ask_user 已废弃删除（PRD backend-host-mvp 需求对齐结论——
 * Web 上选择框与文字问答语义等价，出题走正文）。
 *
 * 跑法：npm run smoke
 * 断言失败不中断（跑完全貌再汇总），最终按失败数退出非 0。
 */

let passed = 0;
let failed = 0;

function check(name: string, condition: boolean, detail?: unknown): void {
    if (condition) {
        passed++;
        console.log(`  ✓ ${name}`);
    } else {
        failed++;
        console.error(`  ✗ ${name}`);
        if (detail !== undefined) console.error(`    ${String(JSON.stringify(detail)).slice(0, 400)}`);
    }
}

/**
 * 工具 execute 的直调桥：ctx 传 {}。
 * ToolDefinition 的 execute 参数签名严格，冒烟脚本只关心名字与返回文本，
 * 通过 cast 桥接——这层类型放松只存在于测试代码。
 */
async function callTool(tool: unknown, params: unknown): Promise<string> {
    const execute = (tool as {
        execute: (...args: unknown[]) => Promise<{ content: Array<{ type: string; text?: string }> }>;
    }).execute;
    const result = await execute("smoke-call", params, undefined, undefined, {});
    const first = result.content[0];
    return first?.type === "text" ? (first.text ?? "") : "";
}

/** 直调但返回完整结果：img_display 的展示指令在 details 里，只看文本会漏掉。 */
async function callToolFull(tool: unknown, params: unknown): Promise<{ content: Array<{ type: string; text?: string }>; details: unknown }> {
    const execute = (tool as {
        execute: (...args: unknown[]) => Promise<{ content: Array<{ type: string; text?: string }> ; details: unknown }>;
    }).execute;
    return execute("smoke-call", params, undefined, undefined, {});
}

function byName(tools: ToolDefinition[], name: string): ToolDefinition {
    const tool = tools.find((t) => t.name === name);
    if (!tool) throw new Error(`工具 ${name} 不在组内（工具实现与冒烟测试不同步）`);
    return tool;
}

/** 模拟用户审批：卡确认（proposed → normal）+ 创建初始调度行。
 * 生产走 WebUI 确认流，dev 直接改库——卡状态机本身是 UI 层职责，不在工具层。 */
function confirmCard(db: Database.Database, cardId: number): void {
    db.prepare("UPDATE card SET status = 'normal' WHERE id = ?").run(cardId);
    createInitialSchedule(db, cardId, 0.9, 365);
}

/** 造卡：propose 后取回 card_id（供后续确认 / 合并 / 删除用）。 */
async function proposeCard(cardTools: ToolDefinition[], topicName: string, front: string): Promise<number> {
    const text = await callTool(byName(cardTools, "card_propose"), {
        topic_name: topicName,
        front,
        back: `「${front}」的参考答案`,
        reason_and_remark: "冒烟测试造数",
    });
    const id = /card_id=(\d+)/.exec(text)?.[1];
    if (!id) throw new Error(`card_propose 造数失败：${text}`);
    return Number(id);
}

/** review_get_due_cards 的返回是「头部一行说明 + JSON 数组」，取 JSON 部分解析。 */
function parseDueCardsJson(raw: string): Array<{ card_id: number; front: string }> {
    return JSON.parse(raw.split("\n").slice(1).join("\n")) as Array<{ card_id: number; front: string }>;
}

async function main(): Promise<void> {
    // 干净环境：临时 home + 临时 SQLite 文件（冒烟测试要求可重复跑，
    // 且绝不碰用户真实数据目录）
    const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-teacher-smoke-"));
    // 不走 db/connection.ts 单例：脚本自持句柄，结束时确定性关闭并删目录
    const db = new Database(path.join(homeDir, "pi-teacher.db"));
    db.pragma("journal_mode = WAL");
    db.pragma("foreign_keys = ON");
    db.pragma("busy_timeout = 5000");

    try {
        console.log("\n[1] 建库与真实 Pi Session 记录");
        initializeSchema(db, homeDir);
        const tables = db
            .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
            .all() as Array<{ name: string }>;
        const tableNames = tables.map((t) => t.name).filter((n) => !n.startsWith("sqlite_"));
        const EXPECTED_TABLES = [
            "agents_md", "card", "card_schedule", "glossary", "pi_session",
            "review_log", "setting", "space", "teach_style", "topic", "user", "user_env",
        ];
        check(
            `${EXPECTED_TABLES.length} 张业务表存在（ADR-0030：无 session 表；ADR-0034：user_env；ADR-0036：setting）`,
            tableNames.length === EXPECTED_TABLES.length && EXPECTED_TABLES.every((t) => tableNames.includes(t)),
            tableNames,
        );
        const spaces = db.prepare("SELECT id, type, name FROM space ORDER BY id").all() as Array<{ id: number; type: string; name: string }>;
        check(
            "固定 Space 两行（0 助教 / 1 复习）",
            spaces.length === 2 && spaces[0].type === "ta" && spaces[0].name === "助教"
                && spaces[1].type === "review" && spaces[1].name === "复习",
            spaces,
        );
        const taRow = db.prepare(`SELECT p.*, s.type AS space_type FROM pi_session p
            JOIN space s ON s.id = p.space_id WHERE p.space_id = 0`).get() as never;
        check("固定助教 Pi Session 已由初始化建好", taRow !== undefined);

        // 学习 Space 与两条对话：全量上下文（制卡开、无主题限定）从数据库行构造
        const learnSpaceId = Number(db.prepare("INSERT INTO space (type, name) VALUES ('learn', '冒烟学习空间')").run().lastInsertRowid);
        const learnAgentsMdId = (db.prepare("SELECT id FROM agents_md WHERE type = 'learn'").get() as { id: number }).id;
        const learnRow = createPiSession(db, homeDir, {
            spaceId: learnSpaceId, agentsMdId: learnAgentsMdId, enableMakeCard: true,
        });
        check("学习 Pi Session 落库且独占 work_path", learnRow.work_path.includes(path.join("learn", String(learnSpaceId), "pi")), learnRow.work_path);

        console.log("\n[2] 工具完整性");
        const learnCtx: SessionToolContext = toolContextFor(db, learnRow);
        check(
            "toolContextFor 从数据库行构造上下文（spaceType/开关/workPath 都来自记录）",
            learnCtx.spaceType === "learn" && learnCtx.isMakeCardEnabled() === true
                && learnCtx.reviewTopicId === null && learnCtx.workPath === learnRow.work_path,
            learnCtx.spaceType,
        );
        const cardTools = createCardTopicTools(learnCtx);
        const glossaryTools = createGlossaryTools(learnCtx);
        const reviewTools = createReviewTools(learnCtx);
        const fileTools = createFileTools(learnCtx);
        const imageTools = createImageTools(learnCtx);
        const allTools = [...cardTools, ...glossaryTools, ...reviewTools, ...fileTools, ...imageTools];
        // 工厂本身不暴露工具列表（它把工具注册进 pi API），这里只验证构造不抛；
        // 注册正确性由 run-real 的会话工具列表断言负责
        createPiTeacherExtension(learnCtx);
        const EXPECTED_TOOLS = [
            "card_propose", "card_list", "card_get", "card_delete", "card_merge",
            "topic_create", "topic_list",
            "glossary_propose", "glossary_list", "glossary_get",
            "review_get_due_cards", "review_submit_ratings",
            "md_get_outline", "md_get_section", "file_get_size_and_length",
            "img_display",
        ];
        check(
            "16 个工具名单与设计定稿一致",
            allTools.length === 16 && EXPECTED_TOOLS.every((n) => allTools.some((t) => t.name === n)),
            allTools.map((t) => t.name),
        );
        check("工具名无重复", new Set(allTools.map((t) => t.name)).size === 16);
        const cardProposeSchema = byName(cardTools, "card_propose").parameters as { properties: Record<string, unknown> };
        check("card_propose 只接受四个业务参数，不再有精华来源路径", JSON.stringify(Object.keys(cardProposeSchema.properties).sort())
            === JSON.stringify(["back", "front", "reason_and_remark", "topic_name"]));
        // Anthropic API 只认 ^[a-zA-Z0-9_-]{1,128}$（点号会被拒）——固定约束做回归
        check(
            "工具名符合 API 字符约束",
            allTools.every((t) => /^[a-zA-Z0-9_-]{1,128}$/.test(t.name)),
            allTools.map((t) => t.name),
        );

        console.log("\n[3] 学习会话：topic/card 增删查改");
        const topicCreateResult = await callTool(byName(cardTools, "topic_create"), { name: "Java", description: "Java 语言核心" });
        check("topic_create 成功", topicCreateResult.includes("已创建主题「Java」"), topicCreateResult);
        const javaTopicId = (db.prepare("SELECT id FROM topic WHERE name = 'Java'").get() as { id: number }).id;

        const dupTopic = await callTool(byName(cardTools, "topic_create"), { name: "Java" });
        check("topic_create 重名拒绝并附现有 id", dupTopic.includes("拒绝") && dupTopic.includes(`topic_id=${javaTopicId}`), dupTopic);

        const cardId = await proposeCard(cardTools, "Java", "JVM 的垃圾回收基本算法有哪些？");
        const cardRow = db.prepare("SELECT status, topic_id FROM card WHERE id = ?").get(cardId) as { status: string; topic_id: number };
        check("card_propose 落库为 proposed", cardRow.status === "proposed" && cardRow.topic_id === javaTopicId, cardRow);

        const dupCard = await callTool(byName(cardTools, "card_propose"), {
            topic_name: "Java",
            front: "JVM的垃圾回收基本算法有哪些？", // 无空格变体，测归一化去重
            back: "x",
            reason_and_remark: "dup",
        });
        check("card_propose 归一化去重拒绝（附现有 front 列表）", dupCard.includes("拒绝") && dupCard.includes("已存在正面高度相似的卡"), dupCard);

        const noTopic = await callTool(byName(cardTools, "card_propose"), {
            topic_name: "不存在的主题", front: "x", back: "x", reason_and_remark: "x",
        });
        check("card_propose 主题不存在拒绝", noTopic.includes("主题「不存在的主题」不存在"));

        const topicList = JSON.parse(await callTool(byName(cardTools, "topic_list"), {})) as Array<{
            id: number; name: string; card_count: number; due_count: number;
        }>;
        const javaRow = topicList.find((t) => t.name === "Java");
        check("topic_list 带 card_count（proposed 不计入）", javaRow !== undefined && javaRow.card_count === 0, topicList);

        const cardListText = await callTool(byName(cardTools, "card_list"), {});
        check("card_list 无正式卡时为空列表", (JSON.parse(cardListText) as unknown[]).length === 0, cardListText);

        const cardGet = JSON.parse(await callTool(byName(cardTools, "card_get"), { card_id: cardId })) as {
            id: number; topic_name: string; front: string; status: string;
        };
        check("card_get 全字段（含 topic_name）", cardGet.id === cardId && cardGet.topic_name === "Java" && cardGet.status === "proposed", cardGet);
        check("card_get 不再返回精华来源路径", !Object.hasOwn(cardGet, "source_essence_path") && !Object.hasOwn(cardGet, "has_source_essence"));
        const cardGetMissing = await callTool(byName(cardTools, "card_get"), { card_id: 99999 });
        check("card_get 不存在拒绝", cardGetMissing.includes("拒绝"));

        console.log("\n[4] 助教会话：写入类硬拒、查询类放行（上下文来自固定助教记录）");
        const taCtx: SessionToolContext = toolContextFor(db, taRow);
        check("助教上下文 spaceType 来自数据库（type='ta'）", taCtx.spaceType === "ta", taCtx.spaceType);
        const taCardTools = createCardTopicTools(taCtx);
        const taReviewTools = createReviewTools(taCtx);
        const taGlossaryTools = createGlossaryTools(taCtx);
        // 空参数即可：可见性裁决在参数使用之前，硬拒路径不会碰到 params
        for (const name of ["card_propose", "topic_create", "card_delete", "card_merge"]) {
            const rejected = await callTool(byName(taCardTools, name), {});
            check(`助教调 ${name} 被拒`, rejected.includes("本会话是助教对话"), rejected);
        }
        const taReview = await callTool(byName(taReviewTools, "review_get_due_cards"), { nums: 1 });
        check("助教调 review_get_due_cards 被拒", taReview.includes("本会话是助教对话"), taReview);
        const taSubmit = await callTool(byName(taReviewTools, "review_submit_ratings"), { ratings: [] });
        check("助教调 review_submit_ratings 被拒", taSubmit.includes("本会话是助教对话"), taSubmit);
        const taGlossary = await callTool(byName(taGlossaryTools, "glossary_propose"), { term: "闭包", definition: "x" });
        check("助教调 glossary_propose 被拒", taGlossary.includes("本会话是助教对话"), taGlossary);

        const taQuery = await callTool(byName(taCardTools, "card_get"), { card_id: cardId });
        check("助教查询类（card_get）可用", taQuery.includes("topic_name"), taQuery);
        const taTopicList = await callTool(byName(taCardTools, "topic_list"), {});
        check("助教调 topic_list 可用", !taTopicList.includes("拒绝"));
        const taGlossaryList = await callTool(byName(taGlossaryTools, "glossary_list"), {});
        check("助教调 glossary_list 可用", !taGlossaryList.includes("拒绝"));

        console.log("\n[5] 制卡开关关闭（enable_make_card = 0）");
        // 同一个学习 Space 下再开一条关掉制卡的对话：开关是对话级属性
        const noMakeRow = createPiSession(db, homeDir, {
            spaceId: learnSpaceId, agentsMdId: learnAgentsMdId, enableMakeCard: false,
        });
        const noMakeCtx: SessionToolContext = toolContextFor(db, noMakeRow);
        check("同 Space 第二条对话独占 work_path", noMakeCtx.workPath !== learnCtx.workPath, [learnCtx.workPath, noMakeCtx.workPath]);
        check("关掉制卡的对话上下文 isMakeCardEnabled()=false", noMakeCtx.isMakeCardEnabled() === false);
        const noMakeTools = createCardTopicTools(noMakeCtx);
        const offPropose = await callTool(byName(noMakeTools, "card_propose"), { topic_name: "Java", front: "开关关闭的卡", back: "x", reason_and_remark: "x" });
        check("card_propose 被拒（开关）", offPropose.includes("已关闭制卡"), offPropose);
        const offTopic = await callTool(byName(noMakeTools, "topic_create"), { name: "开关关闭的主题" });
        check("topic_create 被拒（开关）", offTopic.includes("已关闭制卡"), offTopic);
        const offQuery = await callTool(byName(noMakeTools, "card_list"), {});
        check("查询类不受开关影响（card_list 可用）", !offQuery.includes("拒绝"));

        // 运行期切换：上下文与工具都是会话启动时构造的，改库后必须立刻改变裁决，
        // 否则界面上的开关就是假的（这正是第二阶段 PATCH /options 的核心保证）。
        db.prepare("UPDATE pi_session SET enable_make_card = 1 WHERE id = ?").run(noMakeRow.id);
        check("运行期开启后同一上下文实时反映（无需重建）", noMakeCtx.isMakeCardEnabled() === true);
        const reopenedTopic = await callTool(byName(noMakeTools, "topic_create"), { name: "运行期开启的主题" });
        check("同一工具实例改库后放行 topic_create", reopenedTopic.includes("已创建主题「运行期开启的主题」"), reopenedTopic);
        db.prepare("UPDATE pi_session SET enable_make_card = 0 WHERE id = ?").run(noMakeRow.id);
        const reclosedTopic = await callTool(byName(noMakeTools, "topic_create"), { name: "运行期再次关闭的主题" });
        check("同一工具实例改库后重新拒绝 topic_create", reclosedTopic.includes("已关闭制卡"), reclosedTopic);
        const reclosedTopicCount = db.prepare("SELECT COUNT(*) AS count FROM topic WHERE name = '运行期再次关闭的主题'")
            .get() as { count: number };
        check("运行期被拒的主题没有落库", reclosedTopicCount.count === 0, reclosedTopicCount);

        console.log("\n[6] 术语组");
        const proposeTerm = await callTool(byName(glossaryTools, "glossary_propose"), { term: "闭包", definition: "函数与其词法环境的组合" });
        check("glossary_propose 成功", proposeTerm.includes("已提议术语「闭包」"), proposeTerm);
        const glossaryId = Number(/glossary_id=(\d+)/.exec(proposeTerm)?.[1]);

        const dupTerm = await callTool(byName(glossaryTools, "glossary_propose"), { term: "闭包", definition: "重复提议" });
        check("glossary_propose 重名拒绝并附现有定义", dupTerm.includes("拒绝") && dupTerm.includes("函数与其词法环境的组合"), dupTerm);

        const getProposed = await callTool(byName(glossaryTools, "glossary_get"), { term_id: glossaryId });
        check("glossary_get 拒绝未确认（proposed）", getProposed.includes("不存在或未确认"), getProposed);

        db.prepare("UPDATE glossary SET status = 'normal' WHERE term = '闭包'").run();
        const glossaryList = JSON.parse(await callTool(byName(glossaryTools, "glossary_list"), {})) as Array<{ id: number; term: string }>;
        check("glossary_list 确认后才可见", glossaryList.some((g) => g.id === glossaryId && g.term === "闭包"), glossaryList);

        const glossaryGet = JSON.parse(await callTool(byName(glossaryTools, "glossary_get"), { term_id: glossaryId })) as { term: string; definition: string };
        check("glossary_get 全字段", glossaryGet.term === "闭包" && glossaryGet.definition === "函数与其词法环境的组合", glossaryGet);

        const glossaryGetMissing = await callTool(byName(glossaryTools, "glossary_get"), { term_id: 99999 });
        check("glossary_get 不存在拒绝", glossaryGetMissing.includes("拒绝"));

        console.log("\n[7] 复习组：取卡与 FSRS 判定");
        const emptyDue = await callTool(byName(reviewTools, "review_get_due_cards"), { nums: 10 });
        check("无已确认卡时取到 0 张", emptyDue.includes("本次取到 0 张") && emptyDue.includes("全部到期 0 张"), emptyDue.split("\n")[0]);

        confirmCard(db, cardId);
        const dueOne = await callTool(byName(reviewTools, "review_get_due_cards"), { nums: 10 });
        check("取到 1 张到期卡（含 front 与复习历史）", dueOne.includes("本次取到 1 张") && dueOne.includes("垃圾回收"), dueOne.split("\n")[0]);
        const dueCards = parseDueCardsJson(dueOne);
        check("复习取卡保留卡面与进度字段，不再带精华来源", dueCards.length === 1 && dueCards.every((card) =>
            "back" in card && "reps" in card && "last_review" in card
            && !Object.hasOwn(card, "source_essence_path") && !Object.hasOwn(card, "has_source_essence")));
        const dueByTopic = await callTool(byName(reviewTools, "review_get_due_cards"), { nums: 10, topic_id: javaTopicId });
        check("topic_id 显式过滤取卡", dueByTopic.includes("本次取到 1 张"));
        const dueByWrongTopic = await callTool(byName(reviewTools, "review_get_due_cards"), { nums: 10, topic_id: 99999 });
        check("其他 topic 过滤为空", dueByWrongTopic.includes("本次取到 0 张"));

        // 复习对话绑定 Topic 时，不传 topic_id 也只能看到本主题的卡（review_topic_id 生效）
        const reviewAgentsMdId = (db.prepare("SELECT id FROM agents_md WHERE type = 'review'").get() as { id: number }).id;
        const otherTopicId = Number(db.prepare("INSERT INTO topic (name, description) VALUES ('无关主题', '造数')").run().lastInsertRowid);
        const boundReviewRow = createPiSession(db, homeDir, {
            spaceId: 1, agentsMdId: reviewAgentsMdId, reviewTopicId: otherTopicId,
        });
        const boundReviewCtx = toolContextFor(db, boundReviewRow);
        check("复习对话上下文带出 reviewTopicId", boundReviewCtx.reviewTopicId === otherTopicId, boundReviewCtx.reviewTopicId);
        const boundDue = await callTool(byName(createReviewTools(boundReviewCtx), "review_get_due_cards"), { nums: 10 });
        check("绑定 Topic 的复习对话默认只取本主题（Java 卡不出现）", boundDue.includes("本次取到 0 张"), boundDue.split("\n")[0]);

        const emptyRatings = await callTool(byName(reviewTools, "review_submit_ratings"), { ratings: [] });
        check("空判定列表拒绝", emptyRatings.includes("ratings 为空列表"), emptyRatings);
        const invalidRating = await callTool(byName(reviewTools, "review_submit_ratings"), { ratings: [{ card_id: 99999, rating: "Good" }] });
        check("不存在卡的判定被拒", invalidRating.includes("拒绝"), invalidRating);
        const cardP = await proposeCard(cardTools, "Java", "什么是双亲委派模型？");
        const proposedRating = await callTool(byName(reviewTools, "review_submit_ratings"), { ratings: [{ card_id: cardP, rating: "Good" }] });
        check("未确认卡（proposed）的判定被拒", proposedRating.includes("状态为 proposed"), proposedRating);

        const goodRating = await callTool(byName(reviewTools, "review_submit_ratings"), { ratings: [{ card_id: cardId, rating: "Good" }] });
        check("判定提交成功（附下次到期时间）", goodRating.includes("已提交 1 张判定") && goodRating.includes("下次到期"), goodRating);
        const schedule = db.prepare("SELECT state, due, reps FROM card_schedule WHERE card_id = ?").get(cardId) as { state: string; due: string; reps: number };
        check("调度行更新（reps=1, state=review）", schedule.reps === 1 && schedule.state === "review", schedule);
        check("关 steps 语义：最短间隔 24h", new Date(schedule.due).getTime() - Date.now() >= 20 * 3600 * 1000, schedule.due);
        const logRow = db.prepare("SELECT COUNT(*) AS n FROM review_log").get() as { n: number };
        check("review_log 写入 1 条（判定前快照）", logRow.n === 1);

        const noneDue = await callTool(byName(reviewTools, "review_get_due_cards"), { nums: 10 });
        check("判定后不再到期", noneDue.includes("本次取到 0 张"), noneDue.split("\n")[0]);
        const cardListJava = JSON.parse(await callTool(byName(cardTools, "card_list"), { topic_id: javaTopicId })) as Array<{ id: number }>;
        check("card_list 按 topic 过滤", cardListJava.length === 1 && cardListJava[0].id === cardId, cardListJava);

        console.log("\n[8] card_merge：合并与调度继承");
        // 造数：B/C 确认并设不同 stability（测继承最低者）；cardD 是另一主题的正式卡（测跨主题拒绝）
        const cardB = await proposeCard(cardTools, "Java", "什么是 happens-before 原则？");
        const cardC = await proposeCard(cardTools, "Java", "什么是 JIT 编译？");
        confirmCard(db, cardB);
        confirmCard(db, cardC);
        db.prepare("UPDATE card_schedule SET stability = 3 WHERE card_id = ?").run(cardB);
        db.prepare("UPDATE card_schedule SET stability = 5 WHERE card_id = ?").run(cardC);
        const cardBDue = (db.prepare("SELECT due FROM card_schedule WHERE card_id = ?").get(cardB) as { due: string }).due;

        await callTool(byName(cardTools, "topic_create"), { name: "Python", description: "Python 语言" });
        const cardD = await proposeCard(cardTools, "Python", "什么是 GIL？");
        confirmCard(db, cardD);

        const mergeSingle = await callTool(byName(cardTools, "card_merge"), { target_front: "x", target_back: "x", merged_card_ids: [cardB], reason_and_remark: "x" });
        check("单卡合并拒绝", mergeSingle.includes("至少需要两张卡"), mergeSingle);
        const mergeMissing = await callTool(byName(cardTools, "card_merge"), { target_front: "x", target_back: "x", merged_card_ids: [99999, cardB], reason_and_remark: "x" });
        check("含不存在 id 的合并拒绝", mergeMissing.includes("有不存在的 card_id"), mergeMissing);
        const mergeCross = await callTool(byName(cardTools, "card_merge"), { target_front: "x", target_back: "x", merged_card_ids: [cardB, cardD], reason_and_remark: "x" });
        check("跨主题合并拒绝", mergeCross.includes("必须属于同一个主题"), mergeCross);

        const mergeOk = await callTool(byName(cardTools, "card_merge"), {
            target_front: "JVM 的内存可见性与即时编译",
            target_back: "合并后的参考答案",
            merged_card_ids: [cardB, cardC],
            reason_and_remark: "两卡都讲 JMM 底层",
        });
        check("合并成功", mergeOk.includes("已合并：新卡 card_id="), mergeOk);
        const mergedId = Number(/card_id=(\d+)/.exec(mergeOk)?.[1]);
        const mergedCard = db.prepare("SELECT status, topic_id FROM card WHERE id = ?").get(mergedId) as { status: string; topic_id: number };
        check("新卡直接 normal（跳过审批）", mergedCard.status === "normal" && mergedCard.topic_id === javaTopicId, mergedCard);
        const oldB = db.prepare("SELECT status FROM card WHERE id = ?").get(cardB) as { status: string };
        const oldC = db.prepare("SELECT status FROM card WHERE id = ?").get(cardC) as { status: string };
        check("旧卡全部软删", oldB.status === "deleted" && oldC.status === "deleted");
        const mergedSchedule = db.prepare("SELECT stability, due FROM card_schedule WHERE card_id = ?").get(mergedId) as { stability: number; due: string };
        check("调度继承 stability 最低的旧卡（B=3）", mergedSchedule.stability === 3, mergedSchedule);
        check("due 一并从旧卡复制", mergedSchedule.due === cardBDue, mergedSchedule);

        // 两张 proposed 卡（无调度行）合并 → 新卡用空卡初始调度，due=now 立刻进队列
        const cardE = await proposeCard(cardTools, "Java", "什么是 ABA 问题？");
        const cardF = await proposeCard(cardTools, "Java", "什么是 CAS 操作？");
        const mergeNoSchedule = await callTool(byName(cardTools, "card_merge"), {
            target_front: "CAS 与 ABA 问题",
            target_back: "原子操作的坑",
            merged_card_ids: [cardE, cardF],
            reason_and_remark: "同源概念",
        });
        const mergedNoScheduleId = Number(/card_id=(\d+)/.exec(mergeNoSchedule)?.[1]);
        const freshSchedule = db.prepare("SELECT state, due FROM card_schedule WHERE card_id = ?").get(mergedNoScheduleId) as { state: string; due: string } | undefined;
        check("无调度的旧卡合并 → 新卡初始调度（state=new）", freshSchedule !== undefined && freshSchedule.state === "new", freshSchedule);
        const mergedDueNow = await callTool(byName(reviewTools, "review_get_due_cards"), { nums: 10, topic_id: javaTopicId });
        check("合并出的新卡立刻出现在到期队列", parseDueCardsJson(mergedDueNow).some((c) => c.card_id === mergedNoScheduleId), mergedDueNow.split("\n")[0]);

        console.log("\n[9] card_delete：软删与回收站语义");
        const deleteMissing = await callTool(byName(cardTools, "card_delete"), { card_id: 99999 });
        check("不存在卡删除拒绝", deleteMissing.includes("拒绝"), deleteMissing);

        const beforeRemark = (db.prepare("SELECT reason_and_remark FROM card WHERE id = ?").get(cardId) as { reason_and_remark: string | null }).reason_and_remark;
        const deleteOk = await callTool(byName(cardTools, "card_delete"), { card_id: cardId, reason: "表述过时，回收待重写" });
        check("软删成功", deleteOk.includes(`已软删除 card_id=${cardId}`), deleteOk);
        const deletedCard = db.prepare("SELECT status, reason_and_remark FROM card WHERE id = ?").get(cardId) as { status: string; reason_and_remark: string | null };
        check("状态置 deleted 且原因追加", deletedCard.status === "deleted" && deletedCard.reason_and_remark?.includes("[删除原因] 表述过时，回收待重写") === true, deletedCard);
        check("原 remark 保留", deletedCard.reason_and_remark?.includes(beforeRemark ?? "") === true, deletedCard);
        const scheduleKept = db.prepare("SELECT COUNT(*) AS n FROM card_schedule WHERE card_id = ?").get(cardId) as { n: number };
        check("调度行保留（软删不清复习历史）", scheduleKept.n === 1);
        const deleteAgain = await callTool(byName(cardTools, "card_delete"), { card_id: cardId });
        check("重复删除幂等提示", deleteAgain.includes("已在回收站，无需重复删除"), deleteAgain);

        // 删一张正在到期的卡：软删应立即退出复习队列
        await callTool(byName(cardTools, "card_delete"), { card_id: cardD, reason: "退出队列验证" });
        const dueAfterDelete = await callTool(byName(reviewTools, "review_get_due_cards"), { nums: 100 });
        check("已删卡不再进到期队列", !parseDueCardsJson(dueAfterDelete).some((c) => c.card_id === cardD));

        // 收尾计数：Java 正式卡 = 2（两张合并产物），均在到期中
        const finalTopicList = JSON.parse(await callTool(byName(cardTools, "topic_list"), {})) as Array<{
            name: string; card_count: number; due_count: number;
        }>;
        const finalJava = finalTopicList.find((t) => t.name === "Java");
        check("topic_list 最终计数（card_count=2, due_count=2）", finalJava?.card_count === 2 && finalJava?.due_count === 2, finalTopicList);

        console.log("\n[10] md/file 工具（真实文件，相对路径基于本对话 work_path）");
        const mdPath = path.join(learnCtx.workPath, "lesson.md");
        await fs.writeFile(mdPath, [
            "# 梯度下降课程",
            "",
            "## 什么是梯度下降",
            "用负梯度方向迭代更新参数。",
            "",
            "### 数学定义",
            "θ ← θ − η∇J(θ)",
            "",
            "### 重点回顾",
            "梯度方向是上升最快的方向。",
            "",
            "### 收敛性",
            "学习率足够小时收敛到局部极小。",
            "",
            "### 重点回顾",
            "负梯度方向是下降最快的方向。",
            "",
            "## 总结",
            "梯度下降是优化基石。",
            "",
        ].join("\n"), "utf-8");

        const outline = await callTool(byName(fileTools, "md_get_outline"), { path: "lesson.md" });
        check("outline 含行号", outline.includes("3: ## 什么是梯度下降") && outline.includes("6: ### 数学定义"), outline);
        const outlineLevel3 = await callTool(byName(fileTools, "md_get_outline"), { path: "lesson.md", level: 3 });
        check("level 过滤", outlineLevel3.includes("数学定义") && outlineLevel3.includes("重点回顾") && !outlineLevel3.includes("什么是梯度下降"), outlineLevel3);

        const section = await callTool(byName(fileTools, "md_get_section"), { path: "lesson.md", heading: "什么是梯度下降" });
        check("section 到下一个同级标题为止（含子标题不含「总结」）", section.includes("数学定义") && section.includes("收敛性") && !section.includes("优化基石"), section);
        const dupSection = await callTool(byName(fileTools, "md_get_section"), { path: "lesson.md", heading: "重点回顾" });
        check("重名标题全部返回（两段各自带行号）", dupSection.split("--- 第").length - 1 === 2 && dupSection.includes("上升最快") && dupSection.includes("下降最快"), dupSection);
        const noHit = await callTool(byName(fileTools, "md_get_section"), { path: "lesson.md", heading: "梯度下降" });
        check("未命中标题给相近标题线索", noHit.includes("未找到标题") && noHit.includes("相近标题"), noHit);

        const sizeResult = await callTool(byName(fileTools, "file_get_size_and_length"), { path: "lesson.md" });
        const size = JSON.parse(sizeResult) as { characters: number; lines: number; bytes: number };
        const rawText = await fs.readFile(mdPath, "utf-8");
        const expectedLines = rawText === "" ? 0 : rawText.split("\n").length;
        const expectedChars = [...rawText].length;
        check(
            "文件探查三值一致（码点/行/字节）",
            size.lines === expectedLines && size.characters === expectedChars && size.bytes === Buffer.byteLength(rawText, "utf-8"),
            { size, expectedLines, expectedChars },
        );

        // ADR-0030：不做应用级文件沙箱（用户明确取消 AI 沙箱）。文件工具能读到
        // work_path 之外的真实文件——系统边界交给 Docker 与远程执行 skill，
        // HTTP 附件接口的路径防护由 attachments-check.ts 单独验证。
        const outsideDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-teacher-outside-"));
        const outsideFile = path.join(outsideDir, "outside.md");
        await fs.writeFile(outsideFile, "# 工作路径之外的资料\n共享资料库里的内容。\n", "utf-8");
        try {
            const outsideByAbsolute = await callTool(byName(fileTools, "md_get_outline"), { path: outsideFile });
            check(
                "文件工具允许访问本工作路径外的真实文件（绝对路径，无应用级沙箱）",
                outsideByAbsolute.includes("工作路径之外的资料") && !outsideByAbsolute.includes("拒绝"),
                outsideByAbsolute,
            );
            const outsideByRelative = await callTool(byName(fileTools, "file_get_size_and_length"), {
                path: path.relative(learnCtx.workPath, outsideFile),
            });
            const outsideSize = JSON.parse(outsideByRelative) as { bytes: number };
            check(
                "文件工具允许上跳相对路径（../ 不再被拒绝）",
                outsideSize.bytes === Buffer.byteLength(await fs.readFile(outsideFile, "utf-8"), "utf-8"),
                outsideByRelative,
            );
            // 越界不再拒绝，但相对路径的基准必须仍是本对话 work_path——
            // 否则多对话会互相读到对方的私有文件
            const siblingLesson = await callTool(byName(fileTools, "md_get_outline"), { path: "lesson.md" });
            const siblingFromOther = await callTool(byName(createFileTools(noMakeCtx), "md_get_outline"), { path: "lesson.md" });
            check(
                "相对路径基准是本对话 work_path（同 Space 另一对话看不到 lesson.md）",
                siblingLesson.includes("梯度下降") && siblingFromOther.includes("文件不存在或不可读"),
                siblingFromOther,
            );
        } finally {
            await fs.rm(outsideDir, { recursive: true, force: true }).catch(() => {});
        }

        const missingFile = await callTool(byName(fileTools, "md_get_outline"), { path: "不存在.md" });
        check("文件不存在拒绝", missingFile.includes("文件不存在或不可读"), missingFile);

        console.log("\n[11] 取卡截断（超上限标注剩余）");
        // SQL 直插 105 张到期卡（走工具造数太慢），单独 topic 避免污染前面的计数断言
        const stressTopic = db.prepare("INSERT INTO topic (name, description) VALUES ('压测', '截断分支造数')").run();
        const stressTopicId = Number(stressTopic.lastInsertRowid);
        const insertCard = db.prepare("INSERT INTO card (topic_id, front, back, status, reason_and_remark) VALUES (?, ?, 'x', 'normal', 'x')");
        const insertSchedule = db.prepare(
            `INSERT INTO card_schedule (card_id, state, due, stability, difficulty, elapsed_days, scheduled_days, reps, lapses, last_review)
             VALUES (?, 'new', datetime('now', '-1 day'), 1, 5, 0, 0, 0, 0, NULL)`,
        );
        db.transaction(() => {
            for (let i = 0; i < 105; i++) {
                insertSchedule.run(Number(insertCard.run(stressTopicId, `压测卡 ${i}`).lastInsertRowid));
            }
        })();
        const truncated = await callTool(byName(reviewTools, "review_get_due_cards"), { nums: 10, topic_id: stressTopicId });
        check("只取 10 张且标注剩余", truncated.includes("本次取到 10 张") && /剩余 \d+ 张未取/.test(truncated), truncated.split("\n")[0]);
        const truncatedOverMax = await callTool(byName(reviewTools, "review_get_due_cards"), { nums: 200, topic_id: stressTopicId });
        check("nums 超 100 上限被截到 100", truncatedOverMax.includes("本次取到 100 张"), truncatedOverMax.split("\n")[0]);

        console.log("\n[12] 图片展示（img_display，ADR-0044）");
        // PNG 魔数开头即可：工具只做 magic 判定，不解析完整图片结构
        const pngHead = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d]);
        await fs.writeFile(path.join(learnCtx.workPath, "展示图.png"), pngHead);
        const displayOk = await callToolFull(byName(imageTools, "img_display"), { path: "展示图.png" });
        const displayOkText = displayOk.content[0]?.type === "text" ? (displayOk.content[0].text ?? "") : "";
        check(
            "位图成功：文本确认 + details 带展示指令",
            displayOkText.includes("已向用户展示图片 展示图.png")
                && (displayOk.details as { displayImage?: { url?: string } })?.displayImage?.url
                    === `/api/images?p=${encodeURIComponent(path.join(learnCtx.workPath, "展示图.png"))}`,
            displayOk,
        );
        const displayMissing = await callToolFull(byName(imageTools, "img_display"), { path: "不存在.png" });
        check("文件不存在拒绝且无展示指令", ((displayMissing.content[0] as { text?: string } | undefined)?.text ?? "").includes("文件不存在或不可读")
            && (displayMissing.details as { displayImage?: unknown } | null) === null, displayMissing);
        const displayTextFile = await callToolFull(byName(imageTools, "img_display"), { path: "lesson.md" });
        check("非位图拒绝（magic 不认，扩展名说了不算）", ((displayTextFile.content[0] as { text?: string } | undefined)?.text ?? "").includes("不是可展示的位图")
            && (displayTextFile.details as { displayImage?: unknown } | null) === null, displayTextFile);
        // 核心决策回归：不限制来源目录，工作区外的绝对路径照常展示
        const imgOutsideDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-teacher-img-smoke-"));
        try {
            const outsidePng = path.join(imgOutsideDir, "外部图.png");
            await fs.writeFile(outsidePng, pngHead);
            const displayOutside = await callToolFull(byName(imageTools, "img_display"), { path: outsidePng });
            check(
                "工作区外绝对路径照常展示（不限制目录）",
                (displayOutside.details as { displayImage?: { url?: string } })?.displayImage?.url
                    === `/api/images?p=${encodeURIComponent(outsidePng)}`,
                displayOutside,
            );
        } finally {
            await fs.rm(imgOutsideDir, { recursive: true, force: true }).catch(() => {});
        }
        await fs.writeFile(path.join(learnCtx.workPath, "假图.svg"), "<svg xmlns=\"http://www.w3.org/2000/svg\"></svg>");
        check("SVG 拒绝（能执行的图片格式不进展示通道）", (await callTool(byName(imageTools, "img_display"), { path: "假图.svg" })).includes("不是可展示的位图"));

        console.log(`\n结果：${passed} 通过，${failed} 失败`);
    } finally {
        db.close();
        await fs.rm(homeDir, { recursive: true, force: true }).catch(() => {});
    }
    if (failed > 0) process.exit(1);
}

main().catch((error) => {
    console.error("冒烟测试异常退出：", error);
    process.exit(1);
});
