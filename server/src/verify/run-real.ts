import Database from "better-sqlite3";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { initializeSchema } from "../db/schema.ts";
import { createPiSession, sessionKeyFor } from "../session/repository.ts";
import { startWorkspaceSession } from "../bridge/agent-session-wrapper.ts";
import { toolContextFor } from "../tools/context.ts";

/**
 * 真模型验证（PRD 验收清单核心项）：
 * 真实临时 SQLite + 真实目录 → 数据库建 Space/Pi Session 记录 → 进程内走
 * bridge 层建 Pi 会话（startWorkspaceSession）→ 15 个工具注册 → 真实对话让
 * 模型调 topic_create + card_propose → 断言数据库出现对应行、JSONL 落盘、
 * bridge 事件可达。
 *
 * 走 wrapper（而非裸 session）的意义：这层是后端宿主的对外门面，事件转发、
 * 命令表、生命周期都在这里。真模型验证同时覆盖 bridge 事件可达性。
 *
 * ADR-0030 适配要点：
 * - 不再写 server/dev-data（那是旧用户数据目录）：每次跑用 mkdtemp 临时 home，
 *   成功或失败都清理 wrapper 与数据库句柄，验证之间零残留。
 * - 会话身份完全来自数据库：稳定 key 用 sessionKeyFor(row.id)，cwd 与
 *   sessionDir 都是该 Pi Session 独占的 work_path，JSONL 复用建行时的 path。
 * - 工具上下文由 toolContextFor(db, row) 构造，权限读 space.type。
 *
 * 跑法：npm run verify
 * 前置（用户提供，禁止 mock）：
 *   - PI_TEACHER_PROVIDER  provider 名（默认 agnes）
 *   - PI_TEACHER_MODEL     model id（默认 agnes-2.5-flash）
 *   - API key 按该 provider 的惯例配置（~/.pi/agent/models.json 或环境变量）
 *
 * 会话事件流打到 stdout 便于观察模型的工具调用过程。
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

const EXPECTED_TOOLS = [
    "card_propose", "card_list", "card_get", "card_delete", "card_merge",
    "topic_create", "topic_list",
    "glossary_propose", "glossary_list", "glossary_get",
    "review_get_due_cards", "review_submit_ratings",
    "md_get_outline", "md_get_section", "file_get_size_and_length",
];

async function main(): Promise<void> {
    // 部署默认模型环境；只打印 provider/model 名，绝不打印凭据
    const provider = process.env.PI_TEACHER_PROVIDER ?? "agnes";
    const modelId = process.env.PI_TEACHER_MODEL ?? "agnes-2.5-flash";
    process.env.PI_TEACHER_PROVIDER = provider;
    process.env.PI_TEACHER_MODEL = modelId;

    const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-teacher-verify-"));
    // 自持句柄而非 db/connection.ts 单例：结束时确定性关闭并删除临时目录
    const db = new Database(path.join(homeDir, "pi-teacher.db"));
    db.pragma("journal_mode = WAL");
    db.pragma("foreign_keys = ON");
    db.pragma("busy_timeout = 5000");

    let wrapper: Awaited<ReturnType<typeof startWorkspaceSession>>["session"] | undefined;
    try {
        console.log("\n[1] 真实数据库与 Pi Session 记录");
        initializeSchema(db, homeDir);
        const spaceId = Number(db.prepare("INSERT INTO space (type, name) VALUES ('learn', '真模型验证空间')").run().lastInsertRowid);
        const agentsMdId = (db.prepare("SELECT id FROM agents_md WHERE type = 'learn'").get() as { id: number }).id;
        const teachStyleId = (db.prepare("SELECT id FROM teach_style ORDER BY id LIMIT 1").get() as { id: number }).id;
        const piRow = createPiSession(db, homeDir, {
            spaceId, agentsMdId, teachStyleId, enableMakeCard: true,
        });
        check("学习 Space 与 Pi Session 均由数据库建出", piRow.space_id === spaceId && piRow.space_type === "learn", {
            spaceId, piId: piRow.id,
        });
        check("AGENTS.md 已投影到本对话目录", await fs.stat(path.join(piRow.work_path, "AGENTS.md")).then(() => true).catch(() => false));
        check("style.md 已投影到本对话目录", await fs.stat(path.join(piRow.work_path, "style.md")).then(() => true).catch(() => false));
        const headerBefore = await fs.readFile(piRow.path, "utf8");
        check("建行时 JSONL 已写入 SDK header", headerBefore.includes("\"type\":\"session\""), headerBefore.slice(0, 120));

        const sessionContext = toolContextFor(db, piRow);
        check(
            "工具上下文由数据库记录构造",
            sessionContext.spaceType === "learn" && sessionContext.isMakeCardEnabled() === true
                && sessionContext.workPath === piRow.work_path,
            sessionContext.spaceType,
        );

        // —— 进程内走 bridge 建会话（cwd/sessionDir 都是本 Pi Session 的 work_path）——
        console.log("\n[2] bridge 建真实会话");
        const stableKey = sessionKeyFor(piRow.id);
        const started = await startWorkspaceSession(stableKey, piRow.work_path, sessionContext, {
            sessionFile: piRow.path,
            homeDir,
        });
        wrapper = started.session;
        const { realSessionId } = started;
        check("wrapper 的 cwd 是本 Pi Session 的 work_path", path.resolve(wrapper.cwd) === path.resolve(piRow.work_path), wrapper.cwd);
        check("wrapper 复用数据库里的 JSONL 路径（不另开文件）", path.resolve(wrapper.sessionFile) === path.resolve(piRow.path), wrapper.sessionFile);
        check("realSessionId 是稳定业务 key（重启后身份不变）", realSessionId === stableKey, { realSessionId, stableKey });

        // —— 订阅 wrapper 事件（bridge 事件在 wrapper 层转发，这里是验证点）——
        let assistantText = "";
        const toolCalls: string[] = [];
        const eventTypesSeen = new Set<string>();
        wrapper.onEvent((event) => {
            eventTypesSeen.add(event.type);
            if (event.type === "message_end" && "message" in event) {
                // AgentEvent 是 unknown 值字典：in 窄化后用局部变量访问，不跨形状强转
                const message = event.message as { role?: string; content?: Array<{ type: string; text?: string }> } | undefined;
                if (message?.role === "assistant") {
                    for (const part of message.content ?? []) {
                        if (part.type === "text" && part.text) assistantText += part.text;
                    }
                }
            }
            if (event.type === "tool_execution_start" && "toolName" in event) {
                const name = event.toolName as string;
                toolCalls.push(name);
                console.log(`[tool_call] ${name}`);
            }
        });

        // —— 命令表 get_tools：15 工具必须全部注册且 active ——
        const toolsResult = await wrapper.send({ type: "get_tools" }) as Array<{ name: string; active: boolean }>;
        const activeToolNames = toolsResult.filter((t) => t.active).map((t) => t.name);
        const missingTools = EXPECTED_TOOLS.filter((t) => !activeToolNames.includes(t));
        check(`15 个 pi-teacher 工具全部注册且 active（共 ${activeToolNames.length} 个可用）`, missingTools.length === 0, {
            missingTools, activeToolNames,
        });

        await wrapper.send({ type: "set_model", provider, modelId });
        // 只回显 provider/model 名；凭据不出现在任何输出里
        console.log(`[model] 已设为 ${provider}/${modelId}`);
        const state = await wrapper.send({ type: "get_state" }) as { model?: { id: string; provider: string } };
        check("模型已就位（真实 SDK 模型运行时）", state.model?.provider === provider && state.model?.id === modelId, state.model);

        // —— 真实对话：模型必须实际调工具落库 ——
        console.log("\n[3] 真模型对话");
        const userMessage =
            "请完成两个操作：1. 创建一个名为「验证主题」的学习主题，描述写「真模型验证用」；" +
            "2. 在这个主题下提议一张卡片，正面问「进程内 SDK 相比子进程的优势是什么」，" +
            "背面答「复用宿主进程的扩展注册表与工具管线，无需跨进程通信」，制卡理由写「验证用」。";
        console.log(`\n[用户] ${userMessage}\n`);
        await wrapper.send({ type: "prompt", message: userMessage });

        // 等运行结束：wrapper.isRunning() 直到空闲（prompt_done/agent_settled 已发）
        const deadline = Date.now() + 180_000;
        while (Date.now() < deadline && wrapper.isRunning()) {
            await new Promise((resolve) => setTimeout(resolve, 500));
        }
        if (toolCalls.length === 0) {
            // 失败时把最后两条会话条目打出来（stopReason/errorMessage）——
            // 真模型验证失败最常见原因是端点限流，条目里的 stopReason 能直接看出来
            const entries = wrapper.inner.sessionManager.getEntries();
            for (const entry of entries.slice(-2)) {
                const message = (entry as { message?: { role?: string; stopReason?: string; errorMessage?: string } }).message;
                if (message) console.error(`[失败诊断] role=${message.role} stopReason=${message.stopReason} errorMessage=${message.errorMessage ?? "无"}`);
            }
        }

        console.log(`\n[助手] ${assistantText || "（无文本输出）"}`);
        console.log(`\n[工具调用序列] ${toolCalls.join(" → ") || "（无）"}`);

        // —— 验证：数据库断言 + JSONL + bridge 事件可达性 ——
        console.log("\n[4] 断言：模型实际调工具并落库");
        const topic = db.prepare("SELECT id, description FROM topic WHERE name = '验证主题'").get() as { id: number; description: string | null } | undefined;
        check("topic_create 落库（模型实际调用）", topic !== undefined);
        const card = topic
            ? (db
                  .prepare("SELECT status, front, reason_and_remark FROM card WHERE topic_id = ? ORDER BY id DESC LIMIT 1")
                  .get(topic.id) as { status: string; front: string; reason_and_remark: string | null } | undefined)
            : undefined;
        check("card_propose 落库", card !== undefined);
        check("卡片状态为 proposed（模型只有提案权）", card?.status === "proposed", card?.status);
        check("模型调用了我们的工具（非自由文本回答）", toolCalls.some((t) => t === "card_propose" || t === "topic_create"), toolCalls);

        console.log("\n[5] 断言：JSONL 与事件");
        const jsonl = await fs.readFile(piRow.path, "utf8");
        const jsonlLines = jsonl.trim().split("\n");
        check("JSONL 落在本 Pi Session 目录且已追加对话条目", jsonlLines.length > 1, { file: piRow.path, lines: jsonlLines.length });
        check("JSONL 首行仍是稳定 header（未被会话重写）", jsonl.startsWith(headerBefore.trim().split("\n")[0]));
        const jsonlRoles = jsonlLines
            .map((line) => { try { return JSON.parse(line) as { message?: { role?: string } }; } catch { return {}; } })
            .map((entry) => entry.message?.role)
            .filter((role): role is string => typeof role === "string");
        check("JSONL 含用户与助手消息", jsonlRoles.includes("user") && jsonlRoles.includes("assistant"), [...new Set(jsonlRoles)]);

        // bridge 事件可达性：wrapper 转发的事件应覆盖一轮完整对话的生命周期
        const eventNames = Array.from(eventTypesSeen);
        check("wrapper 转发 agent_start（run 开始）", eventNames.includes("agent_start"), eventNames);
        check("wrapper 转发 message_end（助手消息完整）", eventNames.includes("message_end"));
        check("wrapper 转发 tool_execution_start/end（工具真的跑了）",
            eventNames.includes("tool_execution_start") && eventNames.includes("tool_execution_end"));
        check("wrapper 转发 agent_settled（run 置空闲）", eventNames.includes("agent_settled"));
        check("wrapper 转发 prompt_done（一轮结束）", eventNames.includes("prompt_done"));

        // —— 会话级偏好只靠引导句：模型要能分清「本次对话的要求」与「全局偏好」——
        console.log("\n[6] 真模型：会话级偏好文件由模型自行维护");
        const systemPrompt = wrapper.inner.agent.state?.systemPrompt ?? "";
        check("系统提示含全局 AGENTS.md（Pi 祖先遍历自动发现）", systemPrompt.includes("Pi Teacher 全局规则"));
        check("系统提示含会话级偏好引导句", systemPrompt.includes("<会话级用户偏好>") && systemPrompt.includes("pi-session-user.md"));
        const sessionPreferencePath = path.join(piRow.work_path, "pi-session-user.md");
        const waitIdle = async () => {
            const until = Date.now() + 180_000;
            while (Date.now() < until && wrapper!.isRunning()) await new Promise((resolve) => setTimeout(resolve, 500));
        };
        await wrapper.send({ type: "prompt", message: "这次对话里所有代码示例都用 Rust 写。记住这个要求，回复一句「好」即可。" });
        await waitIdle();
        const sessionPreference = await fs.readFile(sessionPreferencePath, "utf8").catch(() => "");
        check("模型为本会话要求创建了 pi-session-user.md", sessionPreference.length > 0, toolCalls.slice(-4));
        check("文件内容包含该要求", /rust/i.test(sessionPreference), sessionPreference.slice(0, 200));
        await wrapper.send({ type: "prompt", message: "以后所有对话都少用类比。回复一句话即可。" });
        await waitIdle();
        const sessionPreferenceAfter = await fs.readFile(sessionPreferencePath, "utf8").catch(() => "");
        check("全局性偏好没有被写进 pi-session-user.md", !sessionPreferenceAfter.includes("类比"), sessionPreferenceAfter.slice(0, 200));
        check("程序侧未创建或读取会话级偏好文件之外的 USER.md 副本", !(await fs.stat(path.join(piRow.work_path, "USER.md")).then(() => true).catch(() => false)));

        console.log(`\n结果：${passed} 通过，${failed} 失败`);
    } finally {
        // 成功或失败都清理：先回收会话再关库删目录，别把 wrapper 挂在进程里
        if (wrapper?.isAlive()) await wrapper.shutdown().catch(() => {});
        db.close();
        await fs.rm(homeDir, { recursive: true, force: true }).catch(() => {});
    }
    process.exit(failed > 0 ? 1 : 0);
}

main().catch((error) => {
    console.error("run-real 异常退出：", error);
    process.exit(1);
});
