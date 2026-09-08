/**
 * http-smoke：全链路 HTTP 冒烟（PRD 验收核心项）。
 *
 * 起真实 Express（buildApp + 随机端口）+ 临时 DB + 临时 home 目录，
 * 用原生 fetch 走完整用户旅程：
 *   setup → login → me → 建工作区 → 提示词库 CRUD → 开对话（投影落盘）
 *   → 15 工具注册（get_tools）→ SSE 订阅 → 发消息（真模型）→ 收事件
 *   → 卡片确认 → 术语/topic → 登出 401。
 *
 * 真模型真数据库真文件，禁止 mock。模型配置与 run-real 同源：
 *   PI_TEACHER_PROVIDER / PI_TEACHER_MODEL + provider 惯例 API key 环境变量。
 *
 * 跑法：npm run http-smoke
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildApp } from "../index.ts";
import { closeDatabase } from "../db/connection.ts";
import type Database from "better-sqlite3";

const PORT = 39871 + Math.floor(Math.random() * 1000);

let passed = 0;
let failed = 0;
function check(name: string, condition: boolean, detail?: unknown): void {
    if (condition) {
        passed++;
        console.log(`  ✓ ${name}`);
    } else {
        failed++;
        console.error(`  ✗ ${name}`);
        if (detail !== undefined) console.error(`    ${JSON.stringify(detail)}`);
    }
}

interface TestContext {
    baseUrl: string;
    cookie: string;
    conversationKey: string;
    db: Database.Database;
}

async function api(
    ctx: Pick<TestContext, "baseUrl" | "cookie">,
    method: string,
    pathname: string,
    body?: unknown,
): Promise<{ status: number; json: any; headers: Headers }> {
    const response = await fetch(`${ctx.baseUrl}${pathname}`, {
        method,
        headers: {
            "Content-Type": "application/json",
            ...(ctx.cookie ? { Cookie: ctx.cookie } : {}),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
    });
    let json: any = null;
    try {
        json = await response.json();
    } catch {
        // 非 JSON 响应（SSE 等）不解析
    }
    return { status: response.status, json, headers: response.headers };
}

async function main(): Promise<void> {
    // —— 环境：临时 home 目录（不碰 ~/pi-teacher）——
    const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-teacher-http-smoke-"));
    process.env.PI_TEACHER_IDLE_TIMEOUT_MS = String(60 * 60 * 1000); // 测试期间不回收

    const { app, db } = await buildApp({ homeDir, port: PORT });

    // —— 起 HTTP ——
    const { createServer } = await import("node:http");
    const server = createServer(app);
    await new Promise<void>((resolve) => server.listen(PORT, "127.0.0.1", resolve));
    const ctx: TestContext = {
        baseUrl: `http://127.0.0.1:${PORT}`,
        cookie: "",
        conversationKey: "",
        db,
    };

    try {
        // ============ 1. 认证流：status → setup → me ============
        console.log("\n[1] 首启动认证流");
        let r = await api(ctx, "GET", "/api/auth/status");
        check("user 表空时 status 返回 needsSetup", r.status === 200 && r.json.needsSetup === true, r.json);

        r = await api(ctx, "POST", "/api/auth/setup", { username: "xyzen", password: "test-password-123" });
        check("setup 成功并种 cookie", r.status === 200 && r.json.success === true, r.json);
        const setCookie = r.headers.get("set-cookie") ?? "";
        check("cookie 是 HttpOnly + SameSite", /HttpOnly/i.test(setCookie) && /SameSite=Lax/i.test(setCookie), setCookie);
        ctx.cookie = setCookie.split(";")[0];

        r = await api(ctx, "GET", "/api/auth/status");
        check("setup 后 status 不再 needsSetup", r.json.needsSetup === false, r.json);

        r = await api(ctx, "POST", "/api/auth/setup", { username: "hacker", password: "evil-pass-123" });
        check("setup 二次调用被拒（409）", r.status === 409, r.status);

        r = await api(ctx, "POST", "/api/auth/login", { username: "xyzen", password: "wrong-password" });
        check("错误密码 401", r.status === 401, r.status);

        r = await api(ctx, "POST", "/api/auth/login", { username: "xyzen", password: "test-password-123" });
        check("正确密码登录成功", r.status === 200 && r.json.username === "xyzen", r.json);
        ctx.cookie = (r.headers.get("set-cookie") ?? "").split(";")[0] || ctx.cookie;

        r = await api(ctx, "GET", "/api/auth/me");
        check("me 返回用户名", r.json.username === "xyzen", r.json);

        // 未登录访问受保护路由 → 401
        const anon = await api({ baseUrl: ctx.baseUrl, cookie: "" }, "GET", "/api/workspaces");
        check("未登录访问工作区 401", anon.status === 401, anon.status);

        // ============ 2. 提示词库 CRUD ============
        console.log("\n[2] 提示词库");
        r = await api(ctx, "POST", "/api/prompts/agents-md", {
            type: "learn", name: "新学模板", description: "默认学习提示词", prompt: "你是学习助教，引导学生理解新知识。",
        });
        check("建 learn 模板", r.status === 200 && r.json.success === true, r.json);
        const learnTemplateId = r.json.id;

        r = await api(ctx, "POST", "/api/prompts/teach-style", {
            name: "苏格拉底式", description: "只提问不告知", prompt: "永远用反问引导，不直接给答案。",
        });
        check("建教学风格", r.status === 200 && r.json.success === true, r.json);
        const styleId = r.json.id;

        r = await api(ctx, "GET", "/api/prompts");
        check("列表返回两库", r.json.agentsMd.length >= 1 && r.json.teachStyles.length >= 1, r.json);

        r = await api(ctx, "PATCH", `/api/prompts/agents-md/${learnTemplateId}`, { name: "新学模板（v2）" });
        check("PATCH 模板名", r.status === 200);
        r = await api(ctx, "GET", "/api/prompts");
        check("PATCH 生效", r.json.agentsMd.some((t: any) => t.id === learnTemplateId && t.name === "新学模板（v2）"));

        r = await api(ctx, "POST", "/api/prompts/agents-md", { type: "invalid", name: "x", prompt: "y" });
        check("非法 type 400", r.status === 400, r.status);

        // ============ 3. 工作区 ============
        console.log("\n[3] 工作区");
        r = await api(ctx, "POST", "/api/workspaces", { name: "机器学习" });
        check("建学习工作区", r.status === 200 && r.json.success === true, r.json);
        const workspaceId = r.json.workspace.id;

        r = await api(ctx, "GET", "/api/workspaces");
        check("列表含新建工作区", r.json.workspaces.some((w: any) => w.id === workspaceId && w.name === "机器学习"), r.json);

        const workspaceDir = path.join(homeDir, "learn", String(workspaceId));
        check("工作区目录已建", await fs.stat(workspaceDir).then(() => true).catch(() => false));

        // ============ 4. 开对话（投影 + 会话）============
        console.log("\n[4] 开对话");
        r = await api(ctx, "POST", "/api/conversations", {
            spaceId: 1, sessionId: workspaceId,
            agentsMdId: learnTemplateId, teachStyleId: styleId,
            enableMakeCard: true,
        });
        check("开学习对话", r.status === 200 && r.json.success === true, r.json);
        ctx.conversationKey = r.json.conversation?.sessionKey ?? "";
        check("返回 sessionKey（jsonl 路径）", ctx.conversationKey.endsWith(".jsonl"), ctx.conversationKey);

        const agentsMdFile = await fs.readFile(path.join(workspaceDir, "AGENTS.md"), "utf8");
        check("AGENTS.md 投影落盘", agentsMdFile.includes("学习助教"), agentsMdFile.slice(0, 60));
        const styleFile = await fs.readFile(path.join(workspaceDir, "style.md"), "utf8");
        check("style.md 投影落盘", styleFile.includes("反问"), styleFile.slice(0, 60));

        const piRow = db.prepare("SELECT * FROM pi_session WHERE path = ?").get(ctx.conversationKey) as any;
        check("pi_session 行落库（path 回填真实 jsonl）", !!piRow && piRow.space_id === 1, piRow);

        // 类型不匹配的模板 → 400
        r = await api(ctx, "POST", "/api/prompts/agents-md", { type: "ta", name: "助教模板", prompt: "你是助教" });
        const taTemplateId = r.json.id;
        r = await api(ctx, "POST", "/api/conversations", {
            spaceId: 1, sessionId: workspaceId, agentsMdId: taTemplateId,
        });
        check("ta 模板开学习对话被拒（400）", r.status === 400, r.json);

        // ============ 5. SSE 订阅 + 发消息（真模型）============
        console.log("\n[5] SSE + 真模型对话");
        const sseEvents: any[] = [];
        const sseController = new AbortController();
        const ssePromise = (async () => {
            const response = await fetch(`http://127.0.0.1:${PORT}/api/conversations/${encodeURIComponent(ctx.conversationKey)}/events`, {
                headers: { Cookie: ctx.cookie },
                signal: sseController.signal,
            });
            if (!response.ok || !response.body) throw new Error(`SSE 连接失败: ${response.status}`);
            const reader = response.body.getReader();
            const decoder = new TextDecoder();
            let buffer = "";
            for (;;) {
                const { done, value } = await reader.read();
                if (done) break;
                buffer += decoder.decode(value, { stream: true });
                // SSE 帧：data: {json}\n\n；注释帧 ：\n\n 忽略
                for (;;) {
                    const idx = buffer.indexOf("\n\n");
                    if (idx === -1) break;
                    const frame = buffer.slice(0, idx);
                    buffer = buffer.slice(idx + 2);
                    if (frame.startsWith(":")) continue;
                    if (frame.startsWith("data: ")) {
                        try {
                            sseEvents.push(JSON.parse(frame.slice(6)));
                        } catch {
                            // 半帧丢弃
                        }
                    }
                }
            }
        })().catch((error) => {
            if (error.name !== "AbortError") console.error("[sse] 错误:", error.message);
        });

        // 等 connected 事件到
        await new Promise<void>((resolve) => {
            const timer = setInterval(() => {
                if (sseEvents.some((e) => e.type === "connected")) {
                    clearInterval(timer);
                    resolve();
                }
            }, 100);
            setTimeout(() => { clearInterval(timer); resolve(); }, 10_000);
        });
        check("SSE 握手收到 connected", sseEvents.some((e) => e.type === "connected"), sseEvents.map((e) => e.type));

        r = await api(ctx, "POST", `/api/conversations/${encodeURIComponent(ctx.conversationKey)}/command`, {
            type: "get_tools",
        });
        const toolNames = (r.json.data ?? []).map((t: any) => t.name);
        check("15 个 pi-teacher 工具注册", [
            "card_propose", "card_list", "card_get", "card_delete", "card_merge",
            "topic_create", "topic_list", "glossary_propose", "glossary_list", "glossary_get",
            "review_get_due_cards", "review_submit_ratings", "md_get_outline", "md_get_section", "file_get_size_and_length",
        ].every((n) => toolNames.includes(n)), toolNames);

        // 真模型发消息：创建主题 + 提议卡片（与 run-real 同款指令）
        r = await api(ctx, "POST", `/api/conversations/${encodeURIComponent(ctx.conversationKey)}/command`, {
            type: "prompt",
            message: "请完成两个操作：1. 创建一个名为「HTTP冒烟主题」的学习主题，描述写「http-smoke 验证用」；2. 在这个主题下提议一张卡片，正面问「SSE 握手事件名是什么」，背面答「connected」，制卡理由写「验证用」。",
        });
        check("prompt 被 preflight 接受", r.status === 200, r.json);

        // 等消息流结束（prompt_done 或 agent_settled）
        const runDeadline = Date.now() + 180_000;
        while (Date.now() < runDeadline) {
            if (sseEvents.some((e) => e.type === "prompt_done")) break;
            await new Promise((resolve) => setTimeout(resolve, 500));
        }
        const eventTypes = sseEvents.map((e) => e.type);
        check("SSE 收到 message_start", eventTypes.includes("message_start"), eventTypes);
        check("SSE 收到 message_update（流式增量）", eventTypes.includes("message_update"));
        check("SSE 收到 prompt_done", eventTypes.includes("prompt_done"));
        check("SSE 收到 agent_settled", eventTypes.includes("agent_settled"));

        // context 哨兵注入：消息前缀应含 marker
        const jsonlContent = await fs.readFile(ctx.conversationKey, "utf8");
        check("context 哨兵注入进消息", jsonlContent.includes("PI-TEACHER-CONTEXT-INJECT-MARKER"));

        // 数据库落库
        const smokeTopic = db.prepare("SELECT id FROM topic WHERE name = 'HTTP冒烟主题'").get() as any;
        check("模型经工具建了主题", !!smokeTopic);
        if (smokeTopic) {
            const proposedCard = db.prepare("SELECT * FROM card WHERE topic_id = ? ORDER BY id DESC LIMIT 1").get(smokeTopic.id) as any;
            check("模型经工具提议了卡片", !!proposedCard && proposedCard.status === "proposed", proposedCard);
        }

        // ============ 6. 卡片/术语/topic 路由 ============
        console.log("\n[6] CRUD 路由");
        if (smokeTopic) {
            const card = db.prepare("SELECT * FROM card WHERE topic_id = ? ORDER BY id DESC LIMIT 1").get(smokeTopic.id) as any;
            r = await api(ctx, "POST", `/api/cards/${card.id}/confirm`);
            check("卡片确认 proposed→normal", r.status === 200 && r.json.success === true, r.json);
            const schedule = db.prepare("SELECT * FROM card_schedule WHERE card_id = ?").get(card.id) as any;
            check("确认后 card_schedule 行出现（FSRS 初始调度）", !!schedule && schedule.state === "new", schedule);

            r = await api(ctx, "PATCH", `/api/cards/${card.id}`, { front: "改过的正面" });
            check("卡片编辑", r.status === 200);
            const edited = db.prepare("SELECT front FROM card WHERE id = ?").get(card.id) as any;
            check("编辑落库", edited.front === "改过的正面");

            r = await api(ctx, "POST", `/api/cards/${card.id}/delete`);
            check("卡片软删", r.status === 200);
            const deleted = db.prepare("SELECT status FROM card WHERE id = ?").get(card.id) as any;
            check("软删保留调度行", deleted.status === "deleted" && !!db.prepare("SELECT card_id FROM card_schedule WHERE card_id = ?").get(card.id));

            r = await api(ctx, "POST", `/api/cards/${card.id}/restore`);
            check("卡片恢复", r.status === 200);
        }

        // 术语：直接落一行 proposed 再走路由
        const termInfo = db.prepare("INSERT INTO glossary (term, definition) VALUES ('SSE', 'Server-Sent Events')").run();
        r = await api(ctx, "POST", `/api/glossary/${termInfo.lastInsertRowid}/confirm`);
        check("术语确认 proposed→normal", r.status === 200 && r.json.success === true, r.json);
        r = await api(ctx, "GET", "/api/glossary");
        check("术语列表", r.json.terms.some((t: any) => t.term === "SSE" && t.status === "normal"));

        // topic 参数编辑
        if (smokeTopic) {
            r = await api(ctx, "PATCH", `/api/topics/${smokeTopic.id}`, { requestRetention: 0.92, maximumInterval: 180 });
            check("topic FSRS 参数编辑", r.status === 200, r.json);
            const edited = db.prepare("SELECT request_retention, maximum_interval FROM topic WHERE id = ?").get(smokeTopic.id) as any;
            check("参数落库", edited.request_retention === 0.92 && edited.maximum_interval === 180, edited);

            r = await api(ctx, "PATCH", `/api/topics/${smokeTopic.id}`, { requestRetention: 0.3 });
            check("非法 retention 400", r.status === 400);
        }

        // 模板被引用时不可删
        r = await api(ctx, "DELETE", `/api/prompts/agents-md/${learnTemplateId}`);
        check("被引用模板删除被拒（409）", r.status === 409, r.json);

        // ============ 7. abort + 标题 ============
        console.log("\n[7] abort 与标题生成");
        r = await api(ctx, "POST", `/api/conversations/${encodeURIComponent(ctx.conversationKey)}/command`, {
            type: "prompt",
            message: "再讲一个长故事，越长越好。",
        });
        // 立刻 abort（不等结束）
        await new Promise((resolve) => setTimeout(resolve, 300));
        r = await api(ctx, "POST", `/api/conversations/${encodeURIComponent(ctx.conversationKey)}/command`, { type: "abort" });
        check("abort 命令成功", r.status === 200, r.json);
        await new Promise((resolve) => setTimeout(resolve, 2000));

        // 标题生成：等 hub 触发（轮次空闲后异步生成）
        let titleSet = false;
        for (let i = 0; i < 30; i++) {
            await new Promise((resolve) => setTimeout(resolve, 1000));
            const row = db.prepare("SELECT name FROM pi_session WHERE path = ?").get(ctx.conversationKey) as any;
            if (row?.name) { titleSet = true; break; }
        }
        check("标题自动生成并写回 pi_session.name", titleSet,
            db.prepare("SELECT name FROM pi_session WHERE path = ?").get(ctx.conversationKey));

        sseController.abort();
        await ssePromise;

        // ============ 8. 登出 ============
        console.log("\n[8] 登出");
        r = await api(ctx, "POST", "/api/auth/logout");
        check("logout 成功", r.status === 200);
        ctx.cookie = "";
        r = await api(ctx, "GET", "/api/workspaces");
        check("登出后 401", r.status === 401, r.status);

        console.log(`\n结果：${passed} 通过，${failed} 失败`);
    } finally {
        server.close();
        closeDatabase();
        await fs.rm(homeDir, { recursive: true, force: true }).catch(() => {});
    }
    process.exit(failed > 0 ? 1 : 0);
}

main().catch((error) => {
    console.error("http-smoke 异常退出：", error);
    process.exit(1);
});
