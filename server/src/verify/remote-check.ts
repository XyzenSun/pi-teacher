/**
 * remote-check：对一个**已经在运行**的 Pi Teacher 实例做 HTTP 面验收（PRD preproduction-readiness §3.6）。
 *
 * 与 http-smoke 的区别：这里不 buildApp、不开数据库、不读实例的数据目录，只凭网络上看得到的东西下断言——
 * 容器化部署后能否登录、助教在不在、真模型能不能走完一轮、skill 挂载对不对，全部以对方的 HTTP 响应
 * 与 SSE 事件为准。脚本自己创建的 Space 在结束时删除（工作目录按 ADR-0037 保留在实例的数据目录里）。
 *
 * 环境变量：
 *   PI_TEACHER_BASE_URL          必填，例如 http://127.0.0.1:39871
 *   PI_TEACHER_VERIFY_USERNAME   可选；实例已有账号时必填
 *   PI_TEACHER_VERIFY_PASSWORD   可选；同上。实例尚未 setup 且两者都没设时，脚本自己 setup 一个账号并在结尾打印一次
 *
 * 跑法：PI_TEACHER_BASE_URL=http://127.0.0.1:39871 npm run verify:remote
 */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";

let passed = 0;

function check(name: string, condition: unknown): asserts condition {
  assert.ok(condition, name);
  console.log(`  ✓ ${name}`);
  passed += 1;
}

async function waitFor(condition: () => boolean, label: string, timeout: number): Promise<void> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`等待超时：${label}`);
}

interface ContextMessage {
  role: string;
  toolName?: string;
  stopReason?: string;
  content: unknown;
}

/** 消息内容里的纯文本；content 可能是字符串或 `{type:"text"}` 块数组。 */
function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.flatMap((part) => (part && typeof part === "object" && (part as { type?: string }).type === "text" ? [String((part as { text?: string }).text ?? "")] : [])).join("\n");
}

async function main(): Promise<void> {
  const baseUrl = process.env.PI_TEACHER_BASE_URL?.replace(/\/+$/, "");
  if (!baseUrl) throw new Error("请设置 PI_TEACHER_BASE_URL，例如 http://127.0.0.1:39871");
  const envUsername = process.env.PI_TEACHER_VERIFY_USERNAME?.trim() || "";
  const envPassword = process.env.PI_TEACHER_VERIFY_PASSWORD || "";
  console.log(`目标实例：${baseUrl}`);

  let cookie = "";
  const streamControllers: AbortController[] = [];
  const streamTasks: Promise<void>[] = [];
  let createdSpaceId: number | null = null;
  let createdAccount: { username: string; password: string } | null = null;

  async function api(method: string, endpoint: string, body?: unknown) {
    const response = await fetch(`${baseUrl}${endpoint}`, {
      method,
      headers: { "Content-Type": "application/json", ...(cookie ? { Cookie: cookie } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const raw = await response.text();
    let json: any = null;
    try {
      json = raw ? JSON.parse(raw) : null;
    } catch {
      throw new Error(`${method} ${endpoint} 返回的不是 JSON（HTTP ${response.status}）：${raw.slice(0, 200)}`);
    }
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

  async function contextMessages(id: number): Promise<ContextMessage[]> {
    const result = await api("GET", `/api/conversations/${id}/context?tail=200`);
    check("读取会话历史成功", result.status === 200 && Array.isArray(result.json.messages));
    return result.json.messages as ContextMessage[];
  }

  /** 发一轮真模型 prompt，等 SSE 的 prompt_done，再确认最后一条 assistant 不是错误停止。 */
  async function prompt(id: number, events: Array<Record<string, any>>, message: string): Promise<ContextMessage[]> {
    const doneBefore = events.filter((event) => event.type === "prompt_done").length;
    const result = await api("POST", `/api/conversations/${id}/command`, { type: "prompt", message });
    check("prompt 被真实 preflight 接受", result.status === 200 && result.json.success === true);
    await waitFor(() => events.filter((event) => event.type === "prompt_done").length > doneBefore, "SSE prompt_done（真模型完成回复）", 240_000);
    const messages = await contextMessages(id);
    const lastAssistant = [...messages].reverse().find((entry) => entry.role === "assistant");
    check("真模型没有返回错误停止", lastAssistant !== undefined && lastAssistant.stopReason !== "error");
    return messages;
  }

  try {
    console.log("\n[1] 可达性与认证");
    const statusResponse = await fetch(`${baseUrl}/api/auth/status`);
    if (statusResponse.status === 403) {
      throw new Error(`实例拒绝了 Host「${new URL(baseUrl).host}」：非 localhost / IP 的域名要在实例上设置 PI_TEACHER_HOSTNAME 或 PI_TEACHER_ALLOWED_HOSTS`);
    }
    const status = await statusResponse.json() as { needsSetup?: boolean };
    check("GET /api/auth/status 可达且给出 needsSetup", statusResponse.status === 200 && typeof status.needsSetup === "boolean");
    check("API 响应带 Cache-Control: no-store", statusResponse.headers.get("cache-control") === "no-store");
    check("匿名访问受保护 API 返回 401", (await api("GET", "/api/workspaces")).status === 401);
    let username = envUsername;
    let password = envPassword;
    if (status.needsSetup) {
      if (!username || !password) {
        username = "verify-remote";
        password = randomBytes(12).toString("base64url");
        createdAccount = { username, password };
      }
      const setup = await api("POST", "/api/auth/setup", { username, password });
      check("实例尚未初始化：setup 创建账号成功", setup.status === 200 && setup.json.success === true);
    } else if (!username || !password) {
      throw new Error("实例已有账号：请设置 PI_TEACHER_VERIFY_USERNAME 与 PI_TEACHER_VERIFY_PASSWORD");
    }
    check("错误密码被拒绝", (await api("POST", "/api/auth/login", { username, password: `${password}-wrong` })).status === 401);
    const login = await api("POST", "/api/auth/login", { username, password });
    check("真实登录成功", login.status === 200 && login.json.success === true);
    const setCookie = login.headers.get("set-cookie") ?? "";
    check("cookie 使用 HttpOnly 与 SameSite", setCookie.includes("HttpOnly") && setCookie.includes("SameSite=Lax"));
    cookie = setCookie.split(";")[0];
    check("GET /api/auth/me 返回当前用户名", (await api("GET", "/api/auth/me")).json.username === username);

    console.log("\n[2] 固定 Space、常驻助教与模型目录");
    const workspaces = (await api("GET", "/api/workspaces")).json;
    const spaces = workspaces.spaces as Array<{ id: number; type: string; conversations: Array<{ id: number; spaceType: string }> }>;
    check("固定 Space 助教（0）与复习（1）都在", spaces.some((space) => space.id === 0 && space.type === "ta") && spaces.some((space) => space.id === 1 && space.type === "review"));
    const taSessionId = workspaces.taSessionId;
    check("taSessionId 指向助教会话", Number.isSafeInteger(taSessionId) && spaces.find((space) => space.id === 0)!.conversations.some((conversation) => conversation.id === taSessionId && conversation.spaceType === "ta"));
    check("dueCards 是数字", typeof workspaces.dueCards === "number");
    const taOpen = await api("POST", `/api/conversations/${taSessionId}/open`);
    check("助教可以打开且带模型", taOpen.status === 200 && taOpen.json.runtime.alive === true && taOpen.json.runtime.model !== null);
    check("助教不能关闭（常驻，ADR-0035）", (await api("POST", `/api/conversations/${taSessionId}/close`)).status === 400);
    check("助教不能删除（ADR-0037）", (await api("DELETE", `/api/conversations/${taSessionId}`)).status === 403);
    const models = (await api("GET", "/api/models")).json;
    check("模型目录非空且有默认模型", Array.isArray(models.models) && models.models.length > 0 && models.defaultModel?.provider && models.defaultModel?.id);
    check("模型目录仅公开白名单字段", models.models.every((model: any) => Object.keys(model).every((key) => ["provider", "id", "name"].includes(key))));
    const settings = (await api("GET", "/api/config/settings")).json;
    check("设置接口给出提醒间隔（ADR-0036）", Number.isInteger(settings.app?.reminderIntervalTurns) && settings.app.reminderIntervalTurns >= 0);
    check(
      "设置接口给出三段基础提醒与学习精华文案",
      ["makeCardOn", "makeCardOff", "ta", "learningEssence"].every((kind) => typeof settings.app?.reminderTexts?.[kind] === "string" && settings.app.reminderTexts[kind].trim().length > 0),
    );
    const promptLibrary = (await api("GET", "/api/prompts")).json;
    const learnTemplate = promptLibrary.agentsMd.find((template: any) => template.type === "learn");
    check("出厂提示词已随代码 seed：学习模板与教学风格都在", learnTemplate?.prompt && promptLibrary.teachStyles.length > 0);

    console.log("\n[3] 学习 Pi Session 与真模型");
    const spaceName = `verify:remote ${randomBytes(3).toString("hex")}`;
    const spaceResult = await api("POST", "/api/workspaces", { name: spaceName });
    check("创建学习 Space", spaceResult.status === 201 && spaceResult.json.space.type === "learn");
    createdSpaceId = spaceResult.json.space.id as number;
    const created = await api("POST", "/api/conversations", { spaceId: createdSpaceId, agentsMdId: learnTemplate.id, teachStyleId: promptLibrary.teachStyles[0].id });
    check("创建学习 Pi Session 并启动模型", created.status === 201 && created.json.runtime.alive === true && created.json.runtime.model !== null);
    const id = created.json.conversation.id as number;
    check("客户端只得到稳定数字 ID", Number.isSafeInteger(id) && !("path" in created.json.conversation));
    const events = openEvents(id);
    await waitFor(() => events.some((event) => event.type === "connected"), "SSE connected", 20_000);
    check("connected 使用业务 ID", events.find((event) => event.type === "connected")?.sessionId === String(id));
    const tools = (await api("POST", `/api/conversations/${id}/command`, { type: "get_tools" })).json.data;
    check("会话带 Pi 默认 bash / read 与业务工具", ["bash", "read", "card_propose", "md_get_outline"].every((name) => tools.some((tool: any) => tool.name === name && tool.active)));
    // skill 挂载验收：模型只能从系统提示词的 <available_skills> 得知 skill 在哪，命令真跑出来才算挂对了。
    // 一轮 prompt 打包四个内置 skill 的探针命令，控制真模型轮次成本：
    //   tavily-search --help（成功输出）、pullpage 无 key 报错（Node 脚本可执行 + 缺 key 文案）、
    //   exa-search --help（成功输出）、sbx --version（bundle 可执行）。
    const skillProbePrompt = "请依次实际执行以下四条 bash 命令（用绝对路径，不要只用文字描述，不要执行搜索或创建沙箱），每条命令的完整输出都原样回复给我：1）available_skills 里 tavily-search 的 location 所在目录下的 scripts/tavily-search --help；2）available_skills 里 pullpage 的 location 所在目录下的 scripts/pullpage --url https://example.com；3）available_skills 里 exa-search 的 location 所在目录下的 scripts/exa-search --help；4）available_skills 里 sbx 的 location 所在目录下的 scripts/sbx --version。";
    const skillRetryPrompt = "上一轮没有真正运行全部命令。请现在就用 bash 工具（不是文字描述）依次执行上面四条命令，并把每条命令的输出原样回复给我。";
    let skillBashResults: ContextMessage[] = [];
    let skillBashText = "";
    // 四个探针各有唯一特征串；模型可能一条 bash 跑完四条命令，所以按特征串判断而不是按 toolResult 条数。
    const skillProbesSatisfied = () => /search <query>/i.test(skillBashText) && /缺少 TAVILY_API_KEY/.test(skillBashText)
      && /exa-search search <query>/.test(skillBashText) && /\d+\.\d+\.\d+/.test(skillBashText);
    for (const [attempt, message] of [skillProbePrompt, skillRetryPrompt].entries()) {
      const messages = await prompt(id, events, message);
      skillBashResults = [...skillBashResults, ...messages.filter((entry) => entry.role === "toolResult" && entry.toolName === "bash")];
      skillBashText = skillBashResults.map((entry) => textOf(entry.content)).join("\n");
      if (skillProbesSatisfied()) break;
      console.log(`  - 第 ${attempt + 1} 轮模型没有跑全四条命令，再提示一次`);
    }
    check("bash 里真的跑出了 tavily-search --help（skill 目录挂载可用）", /search <query>/i.test(skillBashText));
    check("pullpage 可执行且缺 key 文案指向设置页", /缺少 TAVILY_API_KEY/.test(skillBashText) && /用户环境变量/.test(skillBashText));
    check("exa-search --help 正常输出", /exa-search search <query>/.test(skillBashText));
    check("sbx --version 输出版本号", /\d+\.\d+\.\d+/.test(skillBashText));
    for (const type of ["agent_start", "message_start", "message_end", "tool_execution_start", "tool_execution_end", "agent_settled", "prompt_done"]) {
      check(`SSE 收到 ${type}`, events.some((event) => event.type === type));
    }
    const statusView = (await api("GET", `/api/conversations/${id}/status`)).json;
    check("回合结束后会话空闲", statusView.alive === true && statusView.isRunning === false);

    console.log("\n[4] 用户环境变量与前端");
    const userEnv = (await api("GET", "/api/config/user-env")).json;
    // 值按 ADR-0034 明文回显，这里只看 key 与标记，绝不打印值。
    check("user-env 列出内置 skill 变量", [
      "TAVILY_API_KEY", "TAVILY_BASE_URL", "TAVILY_TIMEOUT",
      "EXA_API_KEY", "EXA_BASE_URL", "EXA_TIMEOUT",
      "FIRECRAWL_API_KEY", "FIRECRAWL_BASE_URL", "JINA_API_KEY", "JINA_BASE_URL",
      "DAYTONA_API_KEY", "E2B_API_KEY", "CODESANDBOX_API_KEY",
    ].every((key) => userEnv.items.some((item: any) => item.key === key && item.builtin === true && typeof item.configured === "boolean")));
    check("受保护变量名被拒", (await api("PATCH", "/api/config/user-env", { PI_TEACHER_HOME: "/tmp/x" })).status === 400);
    for (const spaPath of ["/", "/app", "/app/settings?tab=advanced", `/app/c/${id}/help`]) {
      const page = await fetch(`${baseUrl}${spaPath}`, { headers: { Cookie: cookie } });
      check(`SPA fallback 支持直接访问 ${spaPath}`, page.status === 200 && (await page.text()).includes('id="root"'));
    }
    check("未知 API 返回 JSON 404", (await api("GET", "/api/nonexistent")).status === 404);

    console.log("\n[5] 清理");
    const deleted = await api("DELETE", `/api/workspaces/${createdSpaceId}`);
    check("删除验收 Space（JSONL 删除、工作目录保留）", deleted.status === 200 && deleted.json.filesRetained === true);
    createdSpaceId = null;
    await waitFor(() => events.some((event) => event.type === "session_recycled"), "删除后 SSE 收到 session_recycled", 10_000);
    check("删除后会话 404", (await api("GET", `/api/conversations/${id}/context`)).status === 404);
    check("助教仍常驻", (await api("GET", `/api/conversations/${taSessionId}/status`)).json.alive === true);
    check("登出成功", (await api("POST", "/api/auth/logout")).status === 200);
    check("登出后的旧 cookie 已失效", (await api("GET", "/api/workspaces")).status === 401);
    cookie = "";
    console.log(`\n远程验收：${passed} 通过，0 失败`);
  } finally {
    for (const controller of streamControllers) controller.abort();
    await Promise.allSettled(streamTasks);
    if (createdSpaceId !== null && cookie) {
      await api("DELETE", `/api/workspaces/${createdSpaceId}`).catch(() => undefined);
    }
    if (createdAccount) {
      console.log(`\n本次由脚本创建的登录账号：用户名 ${createdAccount.username}，密码 ${createdAccount.password}（请登录后到设置里修改）`);
    }
  }
}

main().catch((error) => { console.error("远程验收失败：", error instanceof Error ? error.message : "未知错误"); process.exitCode = 1; });
