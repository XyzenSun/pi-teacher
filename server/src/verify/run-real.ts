import { promises as fs } from "node:fs";
import path from "node:path";
import { openDatabase, closeDatabase } from "../db/connection.ts";
import { initializeSchema } from "../db/schema.ts";
import { startWorkspaceSession } from "../bridge/agent-session-wrapper.ts";
import type { SessionToolContext } from "../tools/context.ts";

/**
 * 真模型验证（PRD 验收清单核心项）：
 * 进程内走 bridge 层建 Pi 会话（startWorkspaceSession）→ 15 个工具注册
 * → 真实对话让模型调 topic_create + card_propose → 断言数据库出现对应行。
 *
 * 走 wrapper（而非裸 session）的意义：这层是后端宿主的对外门面，事件转发、
 * 命令表、生命周期都在这里。真模型验证同时覆盖 bridge 事件可达性。
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

async function main(): Promise<void> {
    // 默认取 ~/.pi/agent/models.json 里已配置的 new-provider（用户提供），
    // 可用环境变量覆盖换模型
    const provider = process.env.PI_TEACHER_PROVIDER ?? "new-provider";
    const modelId = process.env.PI_TEACHER_MODEL ?? "deepseek-normal-latest";

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

    // —— 进程内走 bridge 建会话（cwd 契约：双参指工作区目录，PRD 实现要点 1）——
    const { session: wrapper, realSessionId } = await startWorkspaceSession(
        "pi-teacher-pi-session-id-dev-1",
        WORKSPACE_ROOT,
        sessionContext,
    );

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

    // —— 选模型并验证命令表 get_tools ——
    const toolsResult = await wrapper.send({ type: "get_tools" }) as Array<{ name: string; active: boolean }>;
    const activeToolNames = toolsResult.filter((t) => t.active).map((t) => t.name);
    const expectedTools = [
        "card_propose", "card_list", "card_get", "card_delete", "card_merge",
        "topic_create", "topic_list",
        "glossary_propose", "glossary_list", "glossary_get",
        "review_get_due_cards", "review_submit_ratings",
        "md_get_outline", "md_get_section", "file_get_size_and_length",
    ];
    const missingTools = expectedTools.filter((t) => !activeToolNames.includes(t));
    if (missingTools.length > 0) {
        console.error(`✗ 工具注册缺失：${missingTools.join(", ")}`);
        console.error(`  实际工具列表：${activeToolNames.join(", ")}`);
        process.exit(1);
    }
    console.log(`✓ 15 个工具全部注册（active: ${activeToolNames.length} 个）`);

    await wrapper.send({ type: "set_model", provider, modelId });
    console.log(`[model] 已设为 ${provider}/${modelId}`);

    // —— 真实对话 ——
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

    // —— 验证：数据库断言 + bridge 事件可达性 ——
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
    check("模型调用了我们的工具（非自由文本回答）", toolCalls.some((t) => t.startsWith("card_propose") || t.startsWith("topic_create")));

    // bridge 事件可达性：wrapper 转发的事件应覆盖一轮完整对话的生命周期
    const eventNames = Array.from(eventTypesSeen);
    check("wrapper 转发 agent_start（run 开始）", eventNames.includes("agent_start"));
    check("wrapper 转发 message_end（助手消息完整）", eventNames.includes("message_end"));
    check("wrapper 转发 agent_settled（run 置空闲）", eventNames.includes("agent_settled"));

    console.log(`\n结果：${passed} 通过，${failed} 失败`);

    // 回收会话，避免 verify 结束把会话挂着
    if (wrapper.isAlive()) await wrapper.shutdown();
    closeDatabase();
    process.exit(failed > 0 ? 1 : 0);
}

main().catch((error) => {
    console.error("run-real 异常退出：", error);
    process.exit(1);
});
