import assert from "node:assert/strict";
import { promises as fs, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createServer } from "node:http";
import type { Agent } from "@earendil-works/pi-agent-core";
import { buildApp } from "../index.ts";
import { closeDatabase } from "../db/connection.ts";
import { initializeSchema } from "../db/schema.ts";
import { getSessionWrapper, shutdownAllSessions } from "../bridge/agent-session-wrapper.ts";
import { getPiSession, sessionKeyFor } from "../session/repository.ts";

/** 真实 Express、SQLite、文件与模型；不写 server/dev-data 或用户的部署数据。 */
let passed = 0;
let skipped = 0;
/** 真实 provider payload 里逐条消息检查信封：只有非 assistant 消息携带才算我们注入的证据。 */
function payloadHasNonAssistantEnvelope(payloadJson: string, envelope: string): boolean {
  let payload: { messages?: Array<{ role?: string; content?: unknown }> };
  try {
    payload = JSON.parse(payloadJson);
  } catch {
    return payloadJson.includes(envelope);
  }
  if (!Array.isArray(payload.messages)) return payloadJson.includes(envelope);
  return payload.messages.some((message) => message.role !== "assistant" && JSON.stringify(message.content ?? "").includes(envelope));
}

/** 失败诊断只看命中点前后的片段：payload 开头永远是系统提示词，截前 300 字看不出泄漏来自哪条消息。 */
function excerptAround(text: string, needle: string, radius = 220): string {
  const at = text.indexOf(needle);
  return at < 0 ? text.slice(0, radius) : text.slice(Math.max(0, at - radius), at + needle.length + radius);
}

function check(name: string, condition: unknown): asserts condition {
  assert.ok(condition, name);
  console.log(`  ✓ ${name}`);
  passed += 1;
}
async function waitFor(condition: () => boolean | Promise<boolean>, label: string, timeout = 180_000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`等待超时：${label}`);
}

async function main(): Promise<void> {
  process.env.PI_TEACHER_PROVIDER ??= "agnes";
  process.env.PI_TEACHER_MODEL ??= "agnes-2.5-flash";
  process.env.PI_TEACHER_IDLE_TIMEOUT_MS = "3600000";
  const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-teacher-http-"));
  const { app, db } = await buildApp({ homeDir });
  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  let cookie = "";
  const streamControllers: AbortController[] = [];
  const streamTasks: Promise<void>[] = [];

  // 验证脚本是协议边界，JSON 形状由下面逐条真实断言收窄。
  async function api(method: string, endpoint: string, body?: unknown, authenticated = true) {
    const response = await fetch(`${baseUrl}${endpoint}`, {
      method, headers: { "Content-Type": "application/json", ...(authenticated && cookie ? { Cookie: cookie } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const json = await response.json() as any;
    check(`${method} ${endpoint} 不泄露部署路径`, !JSON.stringify(json).includes(homeDir));
    return { status: response.status, json, headers: response.headers };
  }
  function openEvents(id: number) {
    const events: Array<Record<string, any>> = [];
    const controller = new AbortController();
    streamControllers.push(controller);
    const task = (async () => {
      const response = await fetch(`${baseUrl}/api/conversations/${id}/events`, { headers: { Cookie: cookie }, signal: controller.signal });
      check("SSE 返回真实事件流", response.status === 200 && response.headers.get("content-type")?.includes("text/event-stream"));
      const reader = response.body!.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let end: number;
          while ((end = buffer.indexOf("\n\n")) !== -1) {
            const frame = buffer.slice(0, end);
            buffer = buffer.slice(end + 2);
            if (frame.startsWith("data: ")) events.push(JSON.parse(frame.slice(6)));
          }
        }
      } finally { reader.releaseLock(); }
    })().catch((error: unknown) => {
      if (!controller.signal.aborted) throw error;
    });
    streamTasks.push(task);
    return events;
  }
  async function prompt(id: number, message: string, extras: Record<string, unknown> = {}) {
    const result = await api("POST", `/api/conversations/${id}/command`, { type: "prompt", message, ...extras });
    check("prompt 被真实 preflight 接受", result.status === 200 && result.json.success);
    await waitFor(() => !getSessionWrapper(sessionKeyFor(id))?.isRunning(), "模型完成回复");
    const history = getSessionWrapper(sessionKeyFor(id))!.inner.sessionManager.getEntries();
    const lastAssistant = [...history].reverse().find((entry) => entry.type === "message" && entry.message.role === "assistant");
    check("真模型没有返回错误停止", lastAssistant?.type === "message" && lastAssistant.message.role === "assistant" && lastAssistant.message.stopReason !== "error");
  }

  try {
    console.log("\n[1] Schema 与认证");
    initializeSchema(db, homeDir);
    const spaces = db.prepare("SELECT id,type FROM space ORDER BY id").all() as Array<{ id: number; type: string }>;
    check("固定 Space 唯一且类型正确", spaces.length === 2 && spaces[0].id === 0 && spaces[0].type === "ta" && spaces[1].id === 1 && spaces[1].type === "review");
    check("旧 session 表不存在", !db.prepare("SELECT name FROM sqlite_master WHERE name='session'").get());
    check("旧 session_id 列不存在", !(db.prepare("PRAGMA table_info(pi_session)").all() as Array<{ name: string }>).some((column) => column.name === "session_id"));
    check("重复初始化只产生一条助教", (db.prepare("SELECT COUNT(*) AS n FROM pi_session WHERE space_id=0").get() as { n: number }).n === 1);
    let result = await api("GET", "/api/auth/status");
    check("首次启动要求 setup", result.json.needsSetup === true);
    check("匿名访问受保护 API 返回 401", (await api("GET", "/api/workspaces", undefined, false)).status === 401);
    result = await api("POST", "/api/auth/setup", { username: "验收用户", password: "acceptance-password-123" });
    check("setup 创建真实用户", result.status === 200 && result.json.success);
    const setCookie = result.headers.get("set-cookie") ?? "";
    check("cookie 使用 HttpOnly 与 SameSite", setCookie.includes("HttpOnly") && setCookie.includes("SameSite=Lax"));
    cookie = setCookie.split(";")[0];
    check("setup 幂等保护", (await api("POST", "/api/auth/setup", { username: "第二用户", password: "another-pass" })).status === 409);
    check("错误密码被拒绝", (await api("POST", "/api/auth/login", { username: "验收用户", password: "wrong" })).status === 401);
    result = await api("POST", "/api/auth/login", { username: "验收用户", password: "acceptance-password-123" });
    cookie = (result.headers.get("set-cookie") ?? "").split(";")[0];
    check("真实登录成功", result.status === 200 && (await api("GET", "/api/auth/me")).json.username === "验收用户");

    console.log("\n[2] Space、模板与独立 Pi Session");
    const promptLibrary = (await api("GET", "/api/prompts")).json;
    const learnTemplate = promptLibrary.agentsMd.find((template: any) => template.type === "learn");
    const reviewTemplate = promptLibrary.agentsMd.find((template: any) => template.type === "review");
    check("初始化有三类可用模板与教学风格", learnTemplate?.prompt && reviewTemplate?.prompt && promptLibrary.agentsMd.some((template: any) => template.type === "ta") && promptLibrary.teachStyles.length > 0);
    check("固定助教模板可编辑", (await api("PATCH", "/api/prompts/agents-md/0", { description: "固定助教验收" })).status === 200);
    check("不能创建第二个助教模板", (await api("POST", "/api/prompts/agents-md", { type: "ta", name: "重复", prompt: "重复" })).status === 400);
    check("固定 Space 不可改名", (await api("PATCH", "/api/workspaces/0", { name: "新名称" })).status === 403);
    check("固定 Space 不可删除", (await api("DELETE", "/api/workspaces/1")).status === 403);
    result = await api("POST", "/api/workspaces", { name: "HTTP 验收学习" });
    check("创建学习 Space", result.status === 201 && result.json.space.type === "learn");
    const spaceId = result.json.space.id as number;
    check("学习 Space 身份不占固定 ID", spaceId >= 2);
    check("Space 重名被拒", (await api("POST", "/api/workspaces", { name: "HTTP 验收学习" })).status === 409);
    check("模板类型不匹配被拒", (await api("POST", "/api/conversations", { spaceId, agentsMdId: reviewTemplate.id })).status === 400);
    check("助教不可创建", (await api("POST", "/api/conversations", { spaceId: 0, agentsMdId: 0 })).status === 403);
    check("不存在的复习 Topic 被拒", (await api("POST", "/api/conversations", { spaceId: 1, agentsMdId: reviewTemplate.id, reviewTopicId: 999999 })).status === 400);
    check("学习不能指定 Topic", (await api("POST", "/api/conversations", { spaceId, agentsMdId: learnTemplate.id, reviewTopicId: 1 })).status === 400);
    check("创建不能携带模型", (await api("POST", "/api/conversations", { spaceId, agentsMdId: learnTemplate.id, modelId: "x" })).status === 400);
    result = await api("POST", "/api/conversations", { spaceId, agentsMdId: learnTemplate.id, teachStyleId: promptLibrary.teachStyles[0].id });
    check("创建学习 Pi Session", result.status === 201);
    const id = result.json.conversation.id as number;
    check("客户端只得到稳定数字 ID", Number.isSafeInteger(id) && !("sessionKey" in result.json.conversation) && !("path" in result.json.conversation));
    const firstRow = getPiSession(db, id);
    check("Pi 独立目录符合 ADR0030", firstRow.work_path === path.join(homeDir, "learn", String(spaceId), "pi", String(id)));
    const firstAgents = await fs.readFile(path.join(firstRow.work_path, "AGENTS.md"), "utf8");
    const firstStyle = await fs.readFile(path.join(firstRow.work_path, "style.md"), "utf8");
    check("提示词真实投影", firstAgents === learnTemplate.prompt && firstStyle === promptLibrary.teachStyles[0].prompt);
    check("空对话真实 JSONL header 已落盘", JSON.parse((await fs.readFile(firstRow.path, "utf8")).split("\n")[0]).id === sessionKeyFor(id));
    const second = await api("POST", "/api/conversations", { spaceId, agentsMdId: learnTemplate.id, enableMakeCard: false });
    check("同 Space 可创建第二条 Pi", second.status === 201);
    const secondRow = getPiSession(db, second.json.conversation.id);
    check("两个 Pi 不共享目录和 JSONL", secondRow.work_path !== firstRow.work_path && secondRow.path !== firstRow.path);
    check("新 Pi 未覆盖旧风格", await fs.readFile(path.join(firstRow.work_path, "style.md"), "utf8") === firstStyle);
    const review = await api("POST", "/api/conversations", { spaceId: 1, agentsMdId: reviewTemplate.id, reviewTopicId: null });
    check("全部 Topic 复习创建成功", review.status === 201 && review.json.conversation.reviewTopicId === null);

    console.log("\n[3] 模型与真实附件");
    const models = (await api("GET", "/api/models")).json;
    check("真实模型目录含验收模型", models.models.some((model: any) => model.provider === process.env.PI_TEACHER_PROVIDER && model.id === process.env.PI_TEACHER_MODEL));
    check("模型目录仅公开白名单字段", models.models.every((model: any) => Object.keys(model).every((key) => ["provider", "id", "name"].includes(key))));
    check("默认模型与部署一致", models.defaultModel.provider === process.env.PI_TEACHER_PROVIDER && models.defaultModel.id === process.env.PI_TEACHER_MODEL);
    const fileBytes = Buffer.from("# 验收资料\n\n附件是真实文件。\n", "utf8");
    const upload = () => fetch(`${baseUrl}/api/conversations/${id}/attachments`, { method: "POST", headers: { Cookie: cookie, "Content-Type": "application/octet-stream", "X-File-Name": encodeURIComponent("资料.md") }, body: fileBytes });
    const uploaded = await upload();
    const attachment = (await uploaded.json() as any).attachment;
    check("上传附件成功", uploaded.status === 201 && attachment.relativePath === "attachments/资料.md");
    check("附件真实落盘", (await fs.readFile(path.join(firstRow.work_path, attachment.relativePath))).equals(fileBytes));
    check("上传不覆盖同名文件", (await upload()).status === 409);
    const traversal = await fetch(`${baseUrl}/api/conversations/${id}/attachments`, { method: "POST", headers: { Cookie: cookie, "Content-Type": "application/octet-stream", "X-File-Name": "..%2Fevil.txt" }, body: fileBytes });
    check("上传拒绝路径穿越", traversal.status === 400);
    const download = await fetch(`${baseUrl}/api/conversations/${id}/attachments/${attachment.id}`, { headers: { Cookie: cookie } });
    check("下载真实文件字节一致", Buffer.from(await download.arrayBuffer()).equals(fileBytes));
    check("附件不出现在另一 Pi", (await api("GET", `/api/conversations/${secondRow.id}/attachments`)).json.attachments.length === 0);
    check("@ 文件索引找到真实附件", (await api("GET", `/api/conversations/${id}/file-index?q=${encodeURIComponent("资料")}`)).json.files.includes("attachments/资料.md"));

    console.log("\n[4] SSE 与真实模型制卡");
    const events = openEvents(id);
    await waitFor(() => events.some((event) => event.type === "connected"), "SSE connected", 20_000);
    check("connected 使用业务 ID", events.find((event) => event.type === "connected")?.sessionId === String(id));
    const tools = (await api("POST", `/api/conversations/${id}/command`, { type: "get_tools" })).json.data;
    check("15 个业务工具真实注册", ["card_propose", "card_list", "card_get", "card_delete", "card_merge", "topic_create", "topic_list", "glossary_propose", "glossary_list", "glossary_get", "review_get_due_cards", "review_submit_ratings", "md_get_outline", "md_get_section", "file_get_size_and_length"].every((name) => tools.some((tool: any) => tool.name === name && tool.active)));
    check("set_model 使用已有命令", (await api("POST", `/api/conversations/${id}/command`, { type: "set_model", provider: process.env.PI_TEACHER_PROVIDER, modelId: process.env.PI_TEACHER_MODEL })).status === 200);
    await prompt(id, "请实际调用工具完成：创建名为 HTTP验收主题 的主题；在该主题提议一张卡片，正面 SSE的握手事件是什么，背面 connected，备注 验收用。不要仅用文字描述操作。", { attachmentIds: [attachment.id] });
    await waitFor(() => events.some((event) => event.type === "prompt_done"), "SSE prompt_done");
    for (const type of ["agent_start", "message_start", "message_update", "message_end", "tool_execution_start", "tool_execution_end", "agent_settled", "prompt_done"]) check(`SSE 收到 ${type}`, events.some((event) => event.type === type));
    const topic = db.prepare("SELECT id FROM topic WHERE name='HTTP验收主题'").get() as { id: number } | undefined;
    check("模型实际创建 Topic", topic);
    const card = db.prepare("SELECT id,status FROM card WHERE topic_id=? ORDER BY id DESC LIMIT 1").get(topic.id) as { id: number; status: string } | undefined;
    check("模型实际提议 Card", card?.status === "proposed");
    const context = (await api("GET", `/api/conversations/${id}/context`)).json;
    check("无 leaf 参数能读到权威历史", context.messages.some((message: any) => message.role === "assistant") && context.entryIds.length === context.messages.length);
    const page = (await api("GET", `/api/conversations/${id}/context?tail=2`)).json;
    check("历史分页给出游标", page.hasMore && page.oldestEntryId);
    const older = (await api("GET", `/api/conversations/${id}/context?tail=2&before=${page.oldestEntryId}`)).json;
    check("旧页不重复游标消息", !older.entryIds.includes(page.oldestEntryId));
    check("临时 context 注入不写入 JSONL", !(await fs.readFile(firstRow.path, "utf8")).includes("<pi-teacher-context>"));

    console.log("\n[5] 真实 CRUD 与调度保留");
    check("确认提议卡", (await api("POST", `/api/cards/${card!.id}/confirm`)).status === 200);
    check("确认建立真实调度", db.prepare("SELECT card_id FROM card_schedule WHERE card_id=?").get(card!.id));
    db.prepare("UPDATE card_schedule SET reps=5 WHERE card_id=?").run(card!.id);
    check("编辑卡片", (await api("PATCH", `/api/cards/${card!.id}`, { front: "已编辑的卡面", reasonAndRemark: "真实编辑" })).status === 200);
    await api("POST", `/api/cards/${card!.id}/delete`);
    result = await api("POST", `/api/cards/${card!.id}/restore`);
    check("正常卡恢复原进度", result.json.restoredStatus === "normal" && (db.prepare("SELECT reps FROM card_schedule WHERE card_id=?").get(card!.id) as { reps: number }).reps === 5);
    result = await api("POST", "/api/cards", { topicId: topic.id, front: "手动卡", back: "手动答案" });
    check("手动新建直接正常卡", result.json.card.status === "normal");
    result = await api("POST", "/api/glossary", { term: "验收术语", definition: "用真实 API 管理" });
    const termId = result.json.term.id;
    check("术语手动创建真实可读", result.json.term.status === "normal");
    await api("PATCH", `/api/glossary/${termId}`, { definition: "已修改" });
    await api("POST", `/api/glossary/${termId}/delete`);
    check("术语回收站真实显示", (await api("GET", "/api/glossary?status=deleted")).json.terms.some((term: any) => term.id === termId));
    check("术语可恢复", (await api("POST", `/api/glossary/${termId}/restore`)).json.term.definition === "已修改");
    check("FSRS 参数可编辑", (await api("PATCH", `/api/topics/${topic.id}`, { requestRetention: 0.92, maximumInterval: 180 })).status === 200);
    check("非法 FSRS 参数被拒", (await api("PATCH", `/api/topics/${topic.id}`, { requestRetention: 0.3 })).status === 400);
    check("被使用模板不可删除", (await api("DELETE", `/api/prompts/agents-md/${learnTemplate.id}`)).status === 409);
    check("被使用风格不可删除", (await api("DELETE", `/api/prompts/teach-style/${promptLibrary.teachStyles[0].id}`)).status === 409);
    check("模板编辑成功", (await api("PATCH", `/api/prompts/agents-md/${learnTemplate.id}`, { prompt: `${learnTemplate.prompt}\n新增约定。` })).status === 200);
    check("编辑模板不覆盖已建 Pi 投影", await fs.readFile(path.join(firstRow.work_path, "AGENTS.md"), "utf8") === firstAgents);

    console.log("\n[6] 运行期制卡开关与教学风格切换");
    const secondId = secondRow.id;
    check("创建时关闭制卡真实落库", second.json.conversation.enableMakeCard === false && getPiSession(db, secondId).enable_make_card === 0);
    result = await api("PATCH", `/api/conversations/${secondId}/options`, { enableMakeCard: true });
    check("运行期开启制卡返回新状态", result.status === 200 && result.json.conversation.enableMakeCard === true);
    check("制卡开关真实落库", getPiSession(db, secondId).enable_make_card === 1);
    check("制卡开关非布尔被拒", (await api("PATCH", `/api/conversations/${secondId}/options`, { enableMakeCard: "yes" })).status === 400);
    check("options 拒绝额外字段", (await api("PATCH", `/api/conversations/${secondId}/options`, { enableMakeCard: true, spaceId: 1 })).status === 400);
    const taSessionId = (await api("GET", "/api/workspaces")).json.taSessionId as number;
    check("助教会话拒绝改制卡", (await api("PATCH", `/api/conversations/${taSessionId}/options`, { enableMakeCard: true })).status === 403);
    check("助教制卡仍为关闭", getPiSession(db, taSessionId).enable_make_card === 0);

    // 教学风格切换要经过「落库 → 重投影 style.md → 按稳定 ID 重开」，
    // 这里断言重开没有换文件、没有丢历史、没有换模型（ADR-0031 的核心风险）。
    await prompt(secondId, "只回复“记住了”，不调用工具。");
    const secondPathBefore = getPiSession(db, secondId).path;
    const secondMessages = (await api("GET", `/api/conversations/${secondId}/context`)).json.messages.length;
    const secondModelBefore = (await api("GET", `/api/conversations/${secondId}/status`)).json.model;
    const styleForSwitch = promptLibrary.teachStyles[promptLibrary.teachStyles.length - 1];
    check("切换到不存在的教学风格被拒", (await api("PATCH", `/api/conversations/${secondId}/teach-style`, { teachStyleId: 999999 })).status === 400);
    check("teach-style 拒绝额外字段", (await api("PATCH", `/api/conversations/${secondId}/teach-style`, { teachStyleId: styleForSwitch.id, enableMakeCard: true })).status === 400);
    check("助教会话拒绝改教学风格", (await api("PATCH", `/api/conversations/${taSessionId}/teach-style`, { teachStyleId: styleForSwitch.id })).status === 403);
    result = await api("PATCH", `/api/conversations/${secondId}/teach-style`, { teachStyleId: styleForSwitch.id });
    check("运行期切换教学风格成功并重载会话", result.status === 200 && result.json.reloaded === true && result.json.conversation.teachStyleId === styleForSwitch.id);
    check("style.md 已重投影为新风格", await fs.readFile(path.join(secondRow.work_path, "style.md"), "utf8") === styleForSwitch.prompt);
    check("重载没有换 JSONL 文件", getPiSession(db, secondId).path === secondPathBefore);
    check("重载保留历史条数", (await api("GET", `/api/conversations/${secondId}/context`)).json.messages.length === secondMessages);
    const secondModelAfter = (await api("GET", `/api/conversations/${secondId}/status`)).json.model;
    check("重载保留已选模型", secondModelAfter.provider === secondModelBefore.provider && secondModelAfter.id === secondModelBefore.id);
    // 风格是通过 appendSystemPrompt 进入会话的，只有重建后的 agent 系统提示里
    // 真的出现新风格文本，才说明切换不是「只改了库和文件」。
    const reloadedSystemPrompt = getSessionWrapper(sessionKeyFor(secondId))!.inner.agent.state?.systemPrompt ?? "";
    check("新风格真实进入重建后的系统提示", reloadedSystemPrompt.includes(styleForSwitch.prompt.trim()));
    result = await api("PATCH", `/api/conversations/${secondId}/teach-style`, { teachStyleId: null });
    check("可清空教学风格", result.status === 200 && result.json.conversation.teachStyleId === null
      && (await fs.readFile(path.join(secondRow.work_path, "style.md"), "utf8")) === "");

    console.log("\n[7] 固定助教与一次性简介（真实 payload）");
    const taId = taSessionId;
    await api("POST", `/api/conversations/${id}/command`, { type: "set_session_name", name: "主会话专属简介标记-HTTP" });
    await api("POST", `/api/conversations/${taId}/open`);
    const taAgent = getSessionWrapper(sessionKeyFor(taId))!.inner.agent as unknown as Agent;
    const payloads: string[] = [];
    const originalOnPayload = taAgent.onPayload;
    taAgent.onPayload = async (payload, model) => { payloads.push(JSON.stringify(payload)); return originalOnPayload?.(payload, model); };
    await prompt(taId, "只回复“准备好了”，不调用工具。");
    // 断言注入信封本身而不是简介里的字样，且只看非 assistant 消息：真模型可能在回答里
    // 复述主会话名甚至照抄 <pi-teacher-context> 标签，这段文字会随历史进入后续每轮 payload，
    // 属于模型输出而不是我们的注入；我们的信封总以 custom→user 侧消息出现。
    const injectedPayloads = () => payloads.filter((payload) => payloadHasNonAssistantEnvelope(payload, "<pi-teacher-context>"));
    check("助教默认没有注入主会话上下文", injectedPayloads().length === 0);
    payloads.length = 0;
    await prompt(taId, "若当前输入有授权简介，只回复“已读取”，不复述简介，不调用工具。", { injectMainSessionId: id });
    check("显式点击的该轮携带主会话简介", injectedPayloads().length > 0 && payloads.some((payload) => payload.includes("主会话专属简介标记-HTTP")));
    payloads.length = 0;
    await prompt(taId, "这轮只回复“完成”，不调用工具。");
    const leakedPayloads = injectedPayloads();
    check(
      `下一轮不再注入主会话简介${leakedPayloads.length ? `（意外命中片段：${excerptAround(leakedPayloads[0], "<pi-teacher-context>")}）` : ""}`,
      leakedPayloads.length === 0,
    );
    // 注入是 context 钩子里临时拼进请求 payload 的，不该写进 JSONL。逐条解析而不是整文件
    // 搜字符串：失败时要能立刻区分「我们真的持久化了注入」和「真模型在回答里复述了标签名」。
    // 覆盖两条真实泄漏路径：落成 custom 条目，或把信封拼进非 assistant 消息；assistant
    // 文本属于模型输出，复述标签名不构成持久化缺陷。
    const taHistoryLines = (await fs.readFile(getPiSession(db, taId).path, "utf8")).split("\n").filter((line) => line.trim());
    const persistedContextEntries = taHistoryLines
      .map((line) => { try { return JSON.parse(line) as Record<string, any>; } catch { return null; } })
      .filter((entry): entry is Record<string, any> => entry !== null)
      .filter((entry) => entry.type === "custom" || entry.customType === "pi-teacher-context"
        || entry.message?.customType === "pi-teacher-context"
        || (entry.message?.role !== "assistant" && JSON.stringify(entry).includes("<pi-teacher-context>")));
    check(
      `助教简介不落历史${persistedContextEntries.length ? `（命中条目：${JSON.stringify(persistedContextEntries[0]).slice(0, 300)}）` : ""}`,
      persistedContextEntries.length === 0,
    );

    console.log("\n[8] 账号、模型配置与学习日历 HTTP 契约");
    result = await api("GET", "/api/review-schedule?upcomingDays=14&historyDays=14");
    check("学习日历声明 UTC 与真实查询范围", result.status === 200 && result.json.timezone === "UTC"
      && result.json.range.upcomingDays === 14 && result.json.range.historyDays === 14);
    check("学习日历只返回可复算聚合", ["normalCards", "proposedCards", "dueNow", "overdue", "withoutSchedule"]
      .every((key) => Number.isInteger(result.json.totals[key])) && Array.isArray(result.json.upcoming) && Array.isArray(result.json.history));
    check("学习日历拒绝不存在 Topic", (await api("GET", "/api/review-schedule?topicId=999999")).status === 404);
    check("学习日历拒绝超大范围", (await api("GET", "/api/review-schedule?upcomingDays=366")).status === 400);

    result = await api("GET", "/api/config/models");
    check("模型配置公开 Known API 与默认来源", Array.isArray(result.json.knownApis) && result.json.knownApis.includes("anthropic-messages")
      && result.json.defaultModel.source === "env" && result.json.defaultModel.editable === false);
    const configText = JSON.stringify(result.json);
    check("模型配置出口只有凭据布尔与固定掩码", result.json.providers.every((provider: any) => typeof provider.apiKeyConfigured === "boolean"
      && Array.isArray(provider.headerNames) && !Object.prototype.hasOwnProperty.call(provider, "apiKey") && !Object.prototype.hasOwnProperty.call(provider, "headers")));
    check("模型配置不泄漏环境引用或命令引用", !configText.includes("$VAR") && !configText.includes("${VAR}") && !configText.includes("!command"));
    check("环境变量固定时默认模型写入被拒", (await api("PATCH", "/api/config/default-model", {
      provider: process.env.PI_TEACHER_PROVIDER, modelId: process.env.PI_TEACHER_MODEL,
    })).status === 409);
    result = await api("GET", "/api/config/settings");
    check("运行设置只公开受控字段", result.status === 200
      && ["defaultProvider", "defaultModel", "retryEnabled", "retry"].every((key) => Object.prototype.hasOwnProperty.call(result.json.settings, key)));
    const toggledRetry = !result.json.settings.retryEnabled;
    result = await api("PATCH", "/api/config/settings", { retryEnabled: toggledRetry });
    check("重试开关可真实写入并读回", result.status === 200 && result.json.settings.retryEnabled === toggledRetry
      && (await api("GET", "/api/config/settings")).json.settings.retryEnabled === toggledRetry);
    check("运行设置拒绝白名单外字段", (await api("PATCH", "/api/config/settings", { theme: "dark" })).status === 400);

    check("改用户名要求当前密码", (await api("PATCH", "/api/auth/username", { username: "HTTP新用户名", currentPassword: "wrong" })).status === 401);
    result = await api("PATCH", "/api/auth/username", { username: "HTTP新用户名", currentPassword: "acceptance-password-123" });
    check("改用户名同步当前登录态", result.status === 200 && (await api("GET", "/api/auth/me")).json.username === "HTTP新用户名");
    check("改密码要求当前密码", (await api("PATCH", "/api/auth/password", { currentPassword: "wrong", newPassword: "changed-password-456" })).status === 401);
    result = await api("PATCH", "/api/auth/password", { currentPassword: "acceptance-password-123", newPassword: "changed-password-456" });
    cookie = (result.headers.get("set-cookie") ?? "").split(";")[0];
    check("改密码为当前浏览器换发新 cookie", result.status === 200 && cookie.length > 20
      && (await api("GET", "/api/auth/me")).json.username === "HTTP新用户名");
    check("旧密码已失效", (await api("POST", "/api/auth/login", { username: "HTTP新用户名", password: "acceptance-password-123" })).status === 401);
    check("新密码可以登录", (await api("POST", "/api/auth/login", { username: "HTTP新用户名", password: "changed-password-456" })).status === 200);

    console.log("\n[9] 回收、稳定身份恢复、SPA 与登出");
    const previousPath = getPiSession(db, id).path;
    const messageCount = (await api("GET", `/api/conversations/${id}/context`)).json.messages.length;
    await api("POST", `/api/conversations/${id}/close`);
    await waitFor(() => events.some((event) => event.type === "session_recycled"), "回收事件", 5000);
    result = await api("POST", `/api/conversations/${id}/command`, { type: "get_state" });
    check("回收后 command 404 且不自动创建", result.status === 404 && result.json.error === "Pi Session 已回收，请重新打开");
    check("回收后 events 404", (await api("GET", `/api/conversations/${id}/events`)).status === 404);
    const reopened = await api("POST", `/api/conversations/${id}/open`);
    check("稳定 ID 恢复原会话", reopened.json.conversation.id === id && getPiSession(db, id).path === previousPath);
    check("恢复保留历史", (await api("GET", `/api/conversations/${id}/context`)).json.messages.length === messageCount);
    check("恢复保留所选模型", reopened.json.runtime.model.provider === process.env.PI_TEACHER_PROVIDER && reopened.json.runtime.model.id === process.env.PI_TEACHER_MODEL);
    const reconnected = openEvents(id);
    await waitFor(() => reconnected.some((event) => event.type === "connected"), "恢复后的 SSE", 10_000);
    check("重新连接收到握手", reconnected[0].type === "connected");
    if (existsSync(path.resolve(import.meta.dirname, "../../../web/dist/index.html"))) {
      // 设置改为 /app 之上的覆盖层路径后，这些新路径必须能被直接访问和刷新。
      for (const spaPath of ["/settings", "/app/settings?tab=models", `/app/c/${id}/settings?tab=account`, "/app/calendar", `/app/c/${id}/help`]) {
        const page = await fetch(`${baseUrl}${spaPath}`);
        check(`SPA fallback 支持直接访问 ${spaPath}`, page.status === 200 && (await page.text()).includes('id="root"'));
      }
    } else { skipped += 1; console.log("  - 跳过 SPA 检查：web/dist 尚未构建，前端构建后必须重跑"); }
    check("未知 API 仍返回 JSON 404", (await api("GET", "/api/nonexistent")).status === 404);
    check("登出成功", (await api("POST", "/api/auth/logout")).status === 200);
    check("登出后的旧 cookie 已失效", (await api("GET", "/api/workspaces")).status === 401);
    console.log(`\nHTTP 验收：${passed} 通过，0 失败，${skipped} 跳过`);
  } finally {
    for (const controller of streamControllers) controller.abort();
    await Promise.allSettled(streamTasks);
    await shutdownAllSessions();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    closeDatabase();
    await fs.rm(homeDir, { recursive: true, force: true });
  }
}
main().catch((error) => { console.error("HTTP 验收失败：", error instanceof Error ? error.message : "未知错误"); process.exitCode = 1; });
