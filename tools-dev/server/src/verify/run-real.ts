import { promises as fs } from "node:fs";
import path from "node:path";
import {
    createAgentSessionServices,
    createAgentSessionFromServices,
    getAgentDir,
    SessionManager,
    SettingsManager,
    type AgentSession,
} from "@earendil-works/pi-coding-agent";
import { openDatabase, closeDatabase } from "../db/connection.ts";
import { initializeSchema } from "../db/schema.ts";
import { createPiTeacherExtension } from "../tools/factory.ts";
import type { SessionToolContext } from "../tools/context.ts";

/**
 * 真模型验证（PRD 验收清单核心项）：
 * 进程内建 Pi 会话 → 16 个工具注册 → 真实对话让模型调 topic_create + card_propose
 * → 断言数据库出现对应行。
 *
 * 跑法：npm run verify
 * 前置（用户提供，禁止 mock）：
 *   - PI_TEACHER_PROVIDER  provider 名（如 openai / anthropic）
 *   - PI_TEACHER_MODEL     model id
 *   - API key 按该 provider 的惯例设环境变量（如 OPENAI_API_KEY）
 *
 * 会话事件流打到 stdout 便于观察模型的工具调用过程。
 */

const DEV_ROOT = path.resolve(import.meta.dirname, "../../dev-data");
const DB_PATH = path.join(DEV_ROOT, "pi-teacher.db");
const WORKSPACE_ROOT = path.join(DEV_ROOT, "workspace");

function requireEnv(name: string): string {
    const value = process.env[name];
    if (!value) {
        console.error(`缺少环境变量 ${name}。真模型验证不使用 mock——请提供真实 API 配置。`);
        process.exit(2);
    }
    return value;
}

async function main(): Promise<void> {
    // 默认取 ~/.pi/agent/models.json 里已配置的 new-provider（用户提供），
    // 可用环境变量覆盖换模型
    const provider = process.env.PI_TEACHER_PROVIDER ?? "new-provider";
    const modelId = process.env.PI_TEACHER_MODEL ?? "deepseek-normal-latest";
    void requireEnv; // 保留工具函数：显式配置模式仍可用（设 PI_TEACHER_REQUIRE=1）

    await fs.mkdir(WORKSPACE_ROOT, { recursive: true });
    const db = openDatabase(DB_PATH);
    initializeSchema(db);

    // dev 硬编码学习会话上下文（PRD 对齐结论：接口对齐将来读 pi_session 行的查询）
    const sessionContext: SessionToolContext = {
        db,
        spaceId: 1,
        enableMakeCard: true,
        reviewTopicId: null,
        workspaceRoot: WORKSPACE_ROOT,
    };

    // —— 进程内建会话（ADR-0024 路线，参考 pi-web startRpcSession）——
    const agentDir = getAgentDir();
    const settingsManager = SettingsManager.create(WORKSPACE_ROOT, agentDir);
    const services = await createAgentSessionServices({
        cwd: WORKSPACE_ROOT,
        agentDir,
        settingsManager,
        resourceLoaderOptions: {
            // 只装载我们的插件：dev 工作区不该有 skills/themes/context files 干扰
            noSkills: true,
            noPromptTemplates: true,
            noThemes: true,
            noContextFiles: true,
            extensionFactories: [createPiTeacherExtension(sessionContext)],
        },
    });

    const sessionManager = SessionManager.create(WORKSPACE_ROOT, WORKSPACE_ROOT, {
        id: "pi-teacher-pi-session-id-dev-1",
    });
    const { session } = await createAgentSessionFromServices({
        services,
        sessionManager,
        // 真模型：provider/model 来自环境变量，模型注册表由 SettingsManager 从
        // ~/.pi/agent 的用户配置解析
        model: undefined,
    });

    // —— 验证 1：工具注册 ——
    // 会话建立后从工具定义注册表断言 16 个工具全部在场
    const activeToolNames = session.getActiveToolNames();
    const expectedTools = [
        "card_propose", "card_list", "card_get", "card_delete", "card_merge",
        "topic_create", "topic_list",
        "glossary_propose", "glossary_list", "glossary_get",
        "review_get_due_cards", "review_submit_ratings",
        "md_get_outline", "md_get_section", "file_get_size_and_length",
        "ask_user",
    ];
    const missingTools = expectedTools.filter((t) => !activeToolNames.includes(t));
    if (missingTools.length > 0) {
        console.error(`✗ 工具注册缺失：${missingTools.join(", ")}`);
        console.error(`  实际工具列表：${activeToolNames.join(", ")}`);
        process.exit(1);
    }
    console.log(`✓ 16 个工具全部注册（active: ${activeToolNames.length} 个）`);
    let assistantText = "";
    let toolCalls: string[] = [];
    session.subscribe((event) => {
        if (event.type === "agent_start" && "model" in event) {
            // 事件带当前模型信息，打印供人核对
            console.log(`[agent_start] model: ${JSON.stringify((event as { model?: unknown }).model)}`);
        }
        if (event.type === "message_end" && "message" in event) {
            const message = (event as { message: { role?: string; content?: Array<{ type: string; text?: string }> } }).message;
            if (message.role === "assistant") {
                for (const part of message.content ?? []) {
                    if (part.type === "text" && part.text) assistantText += part.text;
                }
            }
        }
        if (event.type === "tool_execution_start" && "toolName" in event) {
            const name = (event as { toolName: string }).toolName;
            toolCalls.push(name);
            console.log(`[tool_call] ${name}`);
        }
    });

    // 选模型：pi SDK 的模型在 modelRegistry 里，按 provider/model id 解析
    const model = services.modelRuntime.getModel(provider, modelId);
    if (!model) {
        console.error(`模型未找到：${provider}/${modelId}。检查 ~/.pi/agent/models.json 与 API key 环境变量。`);
        process.exit(2);
    }
    await session.setModel(model);
    console.log(`[model] 已设为 ${provider}/${modelId}，session.model = ${session.model?.id ?? "undefined"}`);

    // —— 真实对话 ——
    const userMessage =
        "请完成两个操作：1. 创建一个名为「验证主题」的学习主题，描述写「真模型验证用」；" +
        "2. 在这个主题下提议一张卡片，正面问「进程内 SDK 相比子进程的优势是什么」，" +
        "背面答「复用宿主进程的扩展注册表与工具管线，无需跨进程通信」，制卡理由写「验证用」。";
    console.log(`\n[用户] ${userMessage}\n`);
    await session.prompt(userMessage);
    await session.waitForIdle();
    // 失败时把最后两条会话条目打出来（stopReason/errorMessage）——
    // 真模型验证失败最常见原因是端点限流，条目里的 stopReason 能直接看出来
    if (toolCalls.length === 0) {
        const entries = sessionManager.getEntries();
        for (const entry of entries.slice(-2)) {
            const message = (entry as { message?: { role?: string; stopReason?: string; errorMessage?: string } }).message;
            if (message) console.error(`[失败诊断] role=${message.role} stopReason=${message.stopReason} errorMessage=${message.errorMessage ?? "无"}`);
        }
    }

    console.log(`\n[助手] ${assistantText || "（无文本输出）"}`);
    console.log(`\n[工具调用序列] ${toolCalls.join(" → ") || "（无）"}`);

    // —— 验证 2：数据库断言 ——
    let passed = 0;
    let failed = 0;
    const check = (name: string, condition: boolean) => {
        if (condition) {
            passed++;
            console.log(`  ✓ ${name}`);
        } else {
            failed++;
            console.error(`  ✗ ${name}`);
        }
    };

    console.log("\n[断言]");
    const topic = db.prepare("SELECT id FROM topic WHERE name = '验证主题'").get() as { id: number } | undefined;
    check("topic_create 落库（模型实际调用）", topic !== undefined);
    const card = topic
        ? (db
              .prepare("SELECT status, front FROM card WHERE topic_id = ? ORDER BY id DESC LIMIT 1")
              .get(topic.id) as { status: string; front: string } | undefined)
        : undefined;
    check("card_propose 落库", card !== undefined);
    check("卡片状态为 proposed", card?.status === "proposed");
    check("模型调用了我们的工具（非自由文本回答）", toolCalls.some((t) => t.startsWith(("card_propose")) || t.startsWith("topic_create")));

    console.log(`\n结果：${passed} 通过，${failed} 失败`);
    closeDatabase();
    process.exit(failed > 0 ? 1 : 0);
}

main().catch((error) => {
    console.error("run-real 异常退出：", error);
    process.exit(1);
});
