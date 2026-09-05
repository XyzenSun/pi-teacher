# Pi hook 机制调研报告

> 调查对象：`@earendil-works/pi-coding-agent` **0.84.2**（本机全局安装）
> 安装根目录（下文简称 `$PI`）：
> `/root/.nvm/versions/node/v24.19.0/lib/node_modules/@earendil-works/pi-coding-agent/`
> 文中 `dist/xxx` 均指 `$PI/dist/xxx`；`pi-agent-core` 指 `$PI/node_modules/@earendil-works/pi-agent-core/`。
> 真实用法参考：`/tmp/pi-web`（agegr/pi-web v0.8.11，依赖 0.84.3，API 与 0.84.2 兼容）。
>
> **结论速览：能满足三个硬要求（不入 jsonl、不被压缩吃掉、每轮动态刷新）的机制是 Extension 的 `context` 事件**（每次 LLM 调用前触发、只改请求 payload、不落盘）。`before_agent_start` 注入的消息**会写入 jsonl 且参与压缩**，不满足要求 1 和 2。

---

## 1. 钩子全集

Pi 的"hook"统一称为 **Extension 事件**。Extension 是一个 TS 模块（文件或 inline factory），导出 `default function (pi: ExtensionAPI)`，通过 `pi.on(event, handler)` 订阅。

统一 handler 类型（`dist/core/extensions/types.d.ts:863`）：

```typescript
export type ExtensionHandler<E, R = undefined> =
  (event: E, ctx: ExtensionContext) => Promise<R | void> | R | void;
```

即**所有钩子都同时支持 sync 与 async handler**。`ctx` 是 `ExtensionContext`（`types.d.ts:209-249`），提供 `sessionManager`（只读）、`model`、`getSystemPrompt()`、`compact()`、`signal` 等。

事件总表（`on()` 重载定义于 `dist/core/extensions/types.d.ts:868-900`；Event/Result 接口行号见各行）：

### 1.1 Agent / LLM 调用生命周期

| 事件名 | 触发时机 | Event 关键字段 | 返回值可修改 | 定义行号 |
|---|---|---|---|---|
| `before_agent_start` | 用户提交 prompt 之后、agent loop 之前，**每轮用户消息触发一次** | `prompt`、`images?`、`systemPrompt`、`systemPromptOptions` | `message`（注入 custom 消息，**入 jsonl**）、`systemPrompt`（本轮替换） | Event 524-535 / Result 806-810 / on 883 |
| `agent_start` | 底层 agent run 开始 | — | 无 | 536-539 / 884 |
| `turn_start` | 每轮开始 | `turnIndex`、`timestamp` | 无 | 549-554 / 887 |
| `context` | **每次 LLM 调用前**（agent loop 内每个 turn 都会触发） | `messages: AgentMessage[]`（深拷贝） | `messages`（**替换本次 LLM 请求的消息，不落盘**） | 499-503 / Result 775-777 / on 879 |
| `before_provider_headers` | HTTP 头组装后、请求发送前 | `headers`（就地 mutate） | 无（in-place） | 509-517 / 881 |
| `before_provider_request` | provider payload 构建后、发送前 | `payload: unknown` | 返回值替换 payload | 504-508 / 880 |
| `after_provider_response` | HTTP 响应到达、流消费前 | `status`、`headers` | 无 | 518-523 / 882 |
| `message_start` | 消息开始（user/assistant/toolResult） | `message` | 无 | 562-566 / 889 |
| `message_update` | assistant 流式 token 更新 | `message`、`assistantMessageEvent` | 无 | 567-572 / 890 |
| `message_end` | 消息结束 | `message` | `message`（替换定稿消息，须保持原 role） | 573-577 / Result 802-805 / 891 |
| `tool_execution_start` | 工具开始执行 | `toolCallId`、`toolName`、`args` | 无 | 578-584 / 892 |
| `tool_call` | 工具执行前（可拦截） | `toolCallId`、`toolName`、`input`（**就地 mutate 可改参数**） | `block`、`reason`、`terminate` | 649-691 / Result 779-788 / 897 |
| `tool_result` | 工具执行后 | `content`、`isError`、`usage` 等 | `content`、`details`、`isError`、`usage` | 692-734 / Result 796-801 / 898 |
| `tool_execution_update` | 工具流式输出 | `partialResult` | 无 | 585-592 / 893 |
| `tool_execution_end` | 工具执行结束 | `result`、`isError` | 无 | 593-600 / 894 |
| `turn_end` | 每轮结束 | `turnIndex`、`message`、`toolResults` | 无 | 555-561 / 888 |
| `agent_end` | 底层 agent run 结束（可能仍有 retry/compaction/续排） | `messages` | 无 | 540-544 / 885 |
| `agent_settled` | 完全落定（无自动 retry/压缩/续排） | — | 无 | 545-548 / 886 |

### 1.2 输入与会话生命周期

| 事件名 | 触发时机 | Event 关键字段 | 返回值可修改 | 定义行号 |
|---|---|---|---|---|
| `input` | 用户输入到达、任何处理之前 | `text`、`images?`、`source`、`streamingBehavior?` | `action: "continue"/"transform"/"handled"`（可改写或吞掉输入） | 626-638 / Result 640-648 / 900 |
| `user_bash` | 用户以 `!`/`!!` 执行 bash | `command`、`excludeFromContext`、`cwd` | `operations`、`result`（完全接管执行） | 615-624 / Result 789-795 / 899 |
| `session_start` | 会话启动/加载/重载 | `reason`、`previousSessionFile?` | 无 | 415-422 / 870 |
| `session_info_changed` | 会话元数据变化 | `name` | 无 | 428-431 / 871 |
| `session_before_switch` | 切换会话前 | `reason`、`targetSessionFile?` | `cancel` | 429-434 / 811-813 / 872 |
| `session_before_fork` | fork 会话前 | `entryId`、`position` | `cancel`、`skipConversationRestore` | 436-440 / 814-817 / 873 |
| `session_before_compact` | 压缩前 | `preparation`、`branchEntries`、`customInstructions?`、`reason`、`willRetry`、`signal` | `cancel`、`compaction`（自定义摘要） | 441-452 / Result 818-821 / 874 |
| `session_compact` | 压缩后 | `compactionEntry`、`fromExtension`、`reason`、`willRetry` | 无 | 453-462 / 875 |
| `session_before_tree` | 树导航前 | `preparation`、`signal` | `cancel`、`summary`、`customInstructions` 等 | 484-489 / 822-835 / 877 |
| `session_tree` | 树导航后 | `newLeafId`、`oldLeafId`、`summaryEntry?` | 无 | 490-497 / 878 |
| `session_shutdown` | 运行时拆除（quit/reload/换会话） | `reason`、`targetSessionFile?` | 无 | 463-469 / 876 |
| `project_trust` | 项目信任判定 | `cwd` | `trusted: "yes"/"no"/"undecided"`、`remember` | 387-402 / 868 |
| `resources_discover` | session_start 后发现资源 | `cwd`、`reason` | `skillPaths`、`promptPaths`、`themePaths` | 403-414 / 869 |
| `model_select` | 切换模型 | `model`、`previousModel`、`source` | 无 | 601-608 / 895 |
| `thinking_level_select` | 切换思考档位 | `level`、`previousLevel` | 无 | 609-614 / 896 |

### 1.3 非事件的主动 API（`ExtensionAPI` 上的方法，`types.d.ts:902-1031`）

`registerTool`（902，注册 LLM 可调用工具）、`registerCommand`（904）、`registerShortcut`（906）、`registerFlag`（911）、`registerMessageRenderer`（919）、`registerEntryRenderer`（923，自定义 entry **不参与 LLM 上下文**）、`sendMessage`（925，注入 custom 消息，**入 jsonl**）、`sendUserMessage`（934）、`appendEntry`（939，写 `CustomEntry`，**不参与 LLM 上下文**，仅状态持久化）、`registerProvider`（1014）等。

官方生命周期图（`docs/extensions.md:275-330`）：

```
user sends prompt
  ├─► input (可拦截/改写)
  ├─► before_agent_start (可注入消息、改 system prompt)
  ├─► agent_start
  │   ┌── turn（LLM 调用工具时循环）──┐
  │   ├─► turn_start
  │   ├─► context (可修改消息)          ← 每次 LLM 调用
  │   ├─► before_provider_headers / before_provider_request / after_provider_response
  │   ├─► tool_execution_* / tool_call / tool_result
  │   └─► turn_end
  ├─► agent_end
  └─► agent_settled
```

---

## 2. `before_agent_start` 详解

### 2.1 完整签名

`dist/core/extensions/types.d.ts:883`：

```typescript
on(event: "before_agent_start",
   handler: ExtensionHandler<BeforeAgentStartEvent, BeforeAgentStartEventResult>): void;
```

Event（`types.d.ts:524-535`）：

```typescript
export interface BeforeAgentStartEvent {
    type: "before_agent_start";
    /** The raw user prompt text (after expansion). */
    prompt: string;
    /** Images attached to the user prompt, if any. */
    images?: ImageContent[];
    /** The fully assembled system prompt string. */
    systemPrompt: string;
    /** Structured options used to build the system prompt. */
    systemPromptOptions: BuildSystemPromptOptions;
}
```

Result（`types.d.ts:806-810`）：

```typescript
export interface BeforeAgentStartEventResult {
    message?: Pick<CustomMessage, "customType" | "content" | "display" | "details">;
    /** Replace the system prompt for this turn. If multiple extensions return this, they are chained. */
    systemPrompt?: string;
}
```

### 2.2 `role: "custom"` 消息的类型定义

`dist/core/messages.d.ts:32-39`：

```typescript
export interface CustomMessage<T = unknown> {
    role: "custom";
    customType: string;
    content: string | (TextContent | ImageContent)[];
    display: boolean;
    details?: T;
    timestamp: number;
}
```

它通过 module augmentation 注册进 `AgentMessage` 联合类型（`dist/core/messages.d.ts:52-59`，`CustomAgentMessages.custom`）。与普通 message 的区别：

- **发给 LLM 时**被 `convertToLlm` 转成 `role: "user"` 消息（`dist/core/messages.js:92-99`）——即对模型而言就是一条用户消息。
- **TUI 渲染**由 `display` 控制：`false` 完全隐藏，`true` 用区别于用户消息的样式渲染。
- `details` 不发给 LLM，仅供扩展自身使用。

### 2.3 触发时机与注入位置

调用点在 `AgentSession.prompt()`（用户每轮发消息的公共入口，RPC/print/TUI 模式最终都走这里）：

- `dist/core/agent-session.js:885`：`await this._extensionRunner.emitBeforeAgentStart(expandedText, currentImages, this._baseSystemPrompt, this._baseSystemPromptOptions)`
- 本轮 messages 的组装顺序（`dist/core/agent-session.js:869-897`）：
  1. 用户消息（`role: "user"`）
  2. `_pendingNextTurnMessages`（extension `sendMessage({ deliverAs: "nextTurn" })` 攒下的消息）
  3. **`before_agent_start` 返回的 custom 消息**（agent-session.js:886-897，逐条 push 为 `role: "custom"`）

即注入内容位于**本轮用户消息之后、assistant 回复之前**，且历史会话中该位置固定（持久化后即 jsonl 尾部该时刻的位置）。

多个扩展返回 message 时按扩展加载顺序逐个 push（`dist/core/extensions/runner.js:837-896`，合并结果类型 `BeforeAgentStartCombinedResult` 见 `runner.d.ts:14-17`）；`systemPrompt` 链式传递。

### 2.4 是否写入 jsonl —— **写入（关键结论）**

完整证据链：

1. `before_agent_start` 返回的 message 被并进本轮 prompt messages（`dist/core/agent-session.js:886-897`），随后 `await this._runAgentPrompt(messages)`（`agent-session.js:919`）→ `this.agent.prompt(messages)`。
2. `pi-agent-core/dist/agent-loop.js:62-65`（`runAgentLoop`）：**prompt 中的每条消息**（含 custom）都会 emit `message_start` + `message_end`：
   ```javascript
   for (const prompt of prompts) {
       await emit({ type: "message_start", message: prompt });
       await emit({ type: "message_end", message: prompt });
   }
   ```
3. `dist/core/agent-session.js:367-372`（`_handleAgentEvent`，挂在 `message_end` 上的持久化）：
   ```javascript
   if (event.message.role === "custom") {
       this.sessionManager.appendCustomMessageEntry(
           event.message.customType, event.message.content,
           event.message.display, event.message.details);
   }
   ```
4. `appendCustomMessageEntry`（`dist/core/session-manager.js:866`，签名 `session-manager.d.ts:238`）把 `type: "custom_message"` 的 entry 追加进会话 jsonl。`CustomMessageEntry` 定义于 `dist/core/session-manager.d.ts:90-102`，注释明确：

   > "Unlike CustomEntry, this DOES participate in LLM context. The content is converted to a user message in buildSessionContext()."

5. 官方文档同样直说（`docs/extensions.md:545`）：`// Inject a persistent message (stored in session, sent to LLM)`。
6. 旁证：pi-web 作为纯 jsonl 读取器能在前端还原这类消息（`/tmp/pi-web/lib/session-reader.ts:632-641` 把 `custom_message` entry 转回 `role: "custom"` 消息渲染）——说明它确实在文件里。

**结论：`before_agent_start` 注入的每条消息都会成为 jsonl 中的一行 `custom_message` entry，违反硬性要求 1（污染会话历史）。**

### 2.5 是否参与压缩 —— **参与（会被吃掉）**

- 压缩以 session entries 为输入（`dist/core/agent-session.js:1380` `getBranch()` → `prepareCompaction`），`custom_message` entry 会经 `sessionEntryToContextMessages` 还原为上下文消息。
- `dist/core/compaction/compaction.js` 中 custom 消息与 user 消息同级对待：
  - `estimateTokens` 计入其 token（compaction.js:210-213）
  - `isCutPointMessage`：`case "custom": return true`（compaction.js:221-233）——可被选为切割点
  - `isTurnStartMessage`：`case "custom": return true`（compaction.js:235-247）
- 生成摘要时 `generateSummary` 也用 `convertToLlm`（compaction.js:9 导入，456 行起使用），custom 消息内容进入摘要输入。
- 压缩完成后 `this.agent.state.messages = sessionContext.messages` 整体重建（`agent-session.js:1432-1434`），被切走的 custom 消息从活动上下文中消失，仅存于摘要文本中。

**结论：注入的 custom 消息是普通上下文消息，超过保留窗口后被压缩掉，违反硬性要求 2。**

---

## 3. `context` 事件详解（推荐方案的依据）

前一轮线索中的"context 事件在 agent 循环的 LLM 调用前触发"**属实**，且这正是满足三个硬要求的机制。

### 3.1 定义与文档

`dist/core/extensions/types.d.ts:499-503` / `775-777` / `879`：

```typescript
export interface ContextEvent {
    type: "context";
    messages: AgentMessage[];
}
export interface ContextEventResult {
    messages?: AgentMessage[];
}
on(event: "context", handler: ExtensionHandler<ContextEvent, ContextEventResult>): void;
```

官方文档（`docs/extensions.md:648-657`）：

> #### context
> Fired before each LLM call. Modify messages non-destructively.
> `// event.messages - deep copy, safe to modify`

### 3.2 触发链路与"不落盘"的证据

调用链（每一环都在源码中核实）：

1. `dist/core/sdk.js:222-227`：创建 agent 时注册
   ```javascript
   transformContext: async (messages) => {
       const runner = extensionRunnerRef.current;
       if (!runner) return messages;
       return runner.emitContext(messages);
   },
   ```
   该配置与运行模式无关（TUI/RPC/print/SDK 全部共用此构造路径）。
2. `pi-agent-core/dist/agent.js:118`：`this.transformContext = runtimeOptions.transformContext`；`agent.js:314` 传入 agent loop config。
3. `pi-agent-core/dist/agent-loop.js:181-184`（`streamAssistantResponse`，**每次 LLM 调用都会执行**）：
   ```javascript
   let messages = context.messages;
   if (config.transformContext) {
       messages = await config.transformContext(messages, signal);   // ← context 事件
   }
   const llmMessages = await config.convertToLlm(messages);          // custom → user
   const llmContext = { systemPrompt: context.systemPrompt, messages: llmMessages, tools: context.tools };
   ```
   **返回值只用于构建本次 LLM 请求 payload，从不回写 `context.messages`（agent 状态），也不 emit 任何事件。**
4. `dist/core/extensions/runner.js:747-775`（`emitContext`）：先 `structuredClone(messages)` 再链式过 handler，`if (handlerResult && handlerResult.messages) currentMessages = handlerResult.messages`（handler 返回 `undefined` 即保持原样）。

因此三个硬要求逐条对应：

| 硬要求 | 满足原因 |
|---|---|
| 1. 不写 jsonl | 持久化只挂在 `message_end` 事件上（`agent-session.js:365-381`），而 `context` 变换结果不产生任何事件、不进 agent 状态 |
| 2. 不被压缩吃掉 | 压缩作用于 session entries / `agent.state.messages`（`agent-session.js:1432-1434`），注入内容不在其中；压缩后下一次 LLM 调用时 `context` 事件**照常重新触发**，重新注入最新内容 |
| 3. 每轮动态 | `streamAssistantResponse` 每次 LLM 调用前都执行 `transformContext`（`agent-loop.js:181-182`），handler 每次都可查数据库拿最新快照 |

### 3.3 注入消息的形态与位置

- handler 返回的新数组中可加入 `role: "custom"` 消息（会被 `convertToLlm` 转成 user 消息，`dist/core/messages.js:92-99`），也可以直接加普通 `role: "user"` 消息；效果等价，用 `custom` 便于按 `customType` 识别/过滤。
- 建议追加在数组**尾部**（即紧贴本轮用户输入之后），与 `before_agent_start` 注入位置一致；尾部追加对 provider 的 prompt cache 前缀最友好。
- 注意：同一轮 agent loop 里（工具调用循环）**每个 turn 都触发一次** `context` 事件。若只想"每轮用户消息注入一次"，需按消息尾部 role 判断（见 §5 代码）：
  - 尾部是 `user` / `custom` / `bashExecution` → 本轮首次 LLM 调用（或 steering 插话后），注入；
  - 尾部是 `toolResult` → 同轮工具循环的后续调用，跳过。
  该判断依据 `agent-loop.js` 的消息推进顺序（prompt 消息 push 于 58-65 行、steering 消息 push 于 106-113 行、toolResult push 于 121-125 行附近）。

---

## 4. 可行方案对比表

| 方案 | 是否入 jsonl | 是否受压缩影响 | 每轮能否动态变化 | 实现复杂度 | 推荐度 |
|---|---|---|---|---|---|
| **A. `context` 事件注入**（Extension，inline factory） | **否**（只进请求 payload，`sdk.js:222-227` + `agent-loop.js:181-184`） | **否**（每次 LLM 调用重新注入） | **能**（handler 每次异步查库） | 低（一个 ~30 行的 inline extension） | ★★★★★（推荐） |
| B. `before_agent_start` 注入 message | **是**（`agent-session.js:367-372` → `appendCustomMessageEntry`） | **是**（compaction.js:221-247 同级处理） | 能（每轮触发一次） | 低 | ★★（违反要求 1、2） |
| C. `before_agent_start` 返回 `systemPrompt` | 否（system prompt 不入会话文件） | 否 | 能（每轮替换，`agent-session.js:899-905`） | 低 | ★★★（可用，但每轮改 system prompt 会击穿 provider prompt cache，且语义不适合放实时状态） |
| D. 每轮重写 AGENTS.md 文件 | 否（system prompt 不入 jsonl） | 否 | **难**：`_baseSystemPrompt` 仅在构造时与资源发现后构建（`agent-session.js:643, 1778-1779`），改文件后必须触发 reload 才生效；且同样破坏 prompt cache | 高（每轮 reload + 文件写入竞争） | ★ |
| E. `agentsFilesOverride` | 否 | 否 | **否**：只在资源加载（reload）时调用一次（`dist/core/resource-loader.d.ts:108-117`，实现 `resource-loader.js:378`） | 低 | ★（适合静态定制，不适合每轮动态） |
| F. Extension 注册自定义工具让模型主动查 | 调用即入 jsonl（toolResult → `appendMessage`，`agent-session.js:373-380`） | 是（历史会被压缩） | 被动：依赖模型自发调用，不保证每轮 | 中 | ★★（作为 A 的补充：模型需要明细时主动查询） |
| G. `pi.sendMessage()` / `sendUserMessage()` | **是**（同样走 `message_end` → `appendCustomMessageEntry`，`agent-session.js:1094`） | 是 | 能 | 低 | ★（与 B 同病） |
| H. `before_provider_request` 改 payload | 否 | 否 | 能 | 高（需处理各家 provider 的 payload 格式，官方定位是调试用途） | ★ |

补充说明：

- 方案 B 的两个致命伤在官方文档中也有印证——`docs/extensions.md:545` 直接把该消息称为 "persistent message (stored in session)"。
- 方案 D/E 的 system prompt 重建时机：`_rebuildSystemPrompt`（`agent-session.js:710-740`）从 `resourceLoader.getAgentsFiles().agentsFiles` 取内容，仅在 session 构造（643 行）与 `resources_discover` 之后（1778 行）执行，不在 `prompt()` 路径上。
- 方案 A 与 C 可组合：system prompt 放稳定的"角色设定"，`context` 事件注入每轮变化的"实时状态"。

---

## 5. 推荐方案 + 可运行代码

**推荐路径：`createAgentSessionServices`/`createAgentSession` + inline extension（`extensionFactories`）+ `context` 事件注入。**

这正是 pi-web 的接入形态（`/tmp/pi-web/lib/rpc-manager.ts:1949-2010`：`createAgentSessionServices({ resourceLoaderOptions: { extensionFactories: [...] } })` → `createAgentSessionFromServices`），inline extension 的写法参考 `/tmp/pi-web/lib/project-command-env.ts:87-112`，官方文档见 `docs/sdk.md:617-651`。

### 5.1 扩展本体：`lib/pi-context-injection.ts`

```typescript
/**
 * 每轮用户消息前，向模型上下文注入最新学习状态（数据库快照）。
 *
 * 机制：订阅 Extension 的 context 事件。该事件在每次 LLM 调用前触发，
 * 返回的 messages 只进入本次 LLM 请求 payload：
 *   - 不写 jsonl（持久化只挂在 message_end 上，见 agent-session.js:367-381）
 *   - 不进 agent.state.messages，因此不参与 compaction
 *   - 每次 LLM 调用重新执行，天然每轮刷新
 */
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { InlineExtension } from "@earendil-works/pi-coding-agent";

/** 从数据库查询本轮要注入的动态内容。替换为真实查询。 */
async function fetchLearnerSnapshot(): Promise<string> {
  // 例：
  // const [dueCount] = await db.select({ count: count() }).from(reviewCards)
  //   .where(and(eq(reviewCards.userId, uid), lte(reviewCards.dueAt, new Date())));
  // const goal = await getCurrentLearningGoal(uid);
  return [
    "[学习状态 · 系统自动注入，每轮刷新]",
    "- 待复习卡片：12 张",
    "- 当前学习目标：完成「图论 · 拓扑排序」小节",
    "- 最近一次复习：2026-09-05 08:30",
  ].join("\n");
}

export function createLearnerContextExtension(): InlineExtension {
  return {
    name: "learner-context",
    factory: (pi) => {
      pi.on("context", async (event) => {
        const messages = event.messages; // 深拷贝，安全（docs/extensions.md:653）
        if (messages.length === 0) return undefined;

        // 同一轮 agent loop 中每次 LLM 调用都会触发本事件。
        // 只在"本轮第一次 LLM 调用"注入：此时尾部是本轮用户输入
        // （user/custom/bashExecution）；工具循环的后续调用尾部是 toolResult。
        // steering 插话会把 user 消息推到尾部，此时也会注入（视为新交互，合理）。
        const last = messages[messages.length - 1];
        if (last.role === "toolResult") return undefined;

        const snapshot = await fetchLearnerSnapshot();

        // role: "custom" 会被 convertToLlm 转成 user 消息发给 LLM（messages.js:92-99）。
        // customType 用于按类型过滤（例如 plan-mode 示例的做法，examples/extensions/plan-mode/index.ts:177-198）。
        const injected: AgentMessage = {
          role: "custom",
          customType: "learner-context-snapshot",
          content: snapshot,
          display: false, // 不进 TUI 渲染（context 注入本就不落盘，此字段仅满足类型）
          timestamp: Date.now(),
        };

        // 返回全新数组，追加在尾部（紧贴本轮用户输入，对 prompt cache 前缀友好）
        return { messages: [...messages, injected] };
      });
    },
  };
}
```

依赖：`@earendil-works/pi-agent-core` 是 `pi-coding-agent` 的直接依赖（`$PI/package.json:46`），但 `AgentMessage` 未从主入口重导出，需在自己的 `package.json` 中显式声明（版本与 `pi-coding-agent` 对齐，`^0.84.x`）。若不想加依赖，可省略 `injected` 的显式类型标注，直接内联在返回值里由上下文推断。

### 5.2 接入方式一：pi-web 形态（`createAgentSessionServices`）

```typescript
import {
  createAgentSessionFromServices,
  createAgentSessionServices,
  getAgentDir,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { createLearnerContextExtension } from "./lib/pi-context-injection";

export async function startSession(cwd: string, sessionFile?: string) {
  const sessionManager = sessionFile
    ? SessionManager.open(sessionFile, undefined)
    : SessionManager.create(cwd, undefined);

  const services = await createAgentSessionServices({
    cwd,
    agentDir: getAgentDir(),
    settingsManager: SettingsManager.create(cwd, getAgentDir()),
    resourceLoaderOptions: {
      extensionFactories: [createLearnerContextExtension()],
    },
  });

  const { session } = await createAgentSessionFromServices({ services, sessionManager });
  return session;
}
```

（pi-web 同款形态见 `/tmp/pi-web/lib/rpc-manager.ts:1949-2010`。）

### 5.3 接入方式二：SDK 极简形态（`createAgentSession`）

```typescript
import {
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import { createLearnerContextExtension } from "./lib/pi-context-injection";

const loader = new DefaultResourceLoader({
  cwd: process.cwd(),
  agentDir: getAgentDir(),
  extensionFactories: [createLearnerContextExtension()],
});
await loader.reload();

const { session } = await createAgentSession({
  resourceLoader: loader,
  sessionManager: SessionManager.inMemory(), // 或 SessionManager.create(cwd)
});

await session.prompt("开始今天的复习");
```

（官方示例：`$PI/examples/sdk/06-extensions.ts:26-43`。）

### 5.4 行为核对

| 现象 | 预期 |
|---|---|
| jsonl 会话文件 | 每轮只有 user/assistant/toolResult 等常规 entry，**无** `custom_message` 注入行 |
| 自动压缩后 | 下一轮 prompt 的第一次 LLM 请求里依然出现最新快照（transformContext 每次调用重新执行） |
| 同轮工具循环 | 第二次起 LLM 调用不再注入（尾部是 toolResult 时跳过） |
| 模型视角 | 快照是一条位于用户消息之后的 user 消息 |

可选增强（非必需）：再注册一个自定义工具（`pi.registerTool`）让模型在需要明细时主动查库——工具结果会入 jsonl，属于正常工具调用历史，与快照注入互补。

---

## 6. 未核实清单

以下结论为静态源码分析（读 `dist/` 的 `.js`/`.d.ts` 与官方 docs），**未做运行时实测**：

1. **未端到端运行验证**。`context` 事件"不落盘、压缩后仍注入"是从调用链推导的（`sdk.js:222-227` → `agent.js:118/314` → `agent-loop.js:181-184`），建议写一个最小 demo 跑一轮后 `cat` jsonl 确认。
2. **连续 user 消息的 provider 兼容性**：注入后 payload 中可能出现 user → user(注入) 相邻（`convertToLlm` 直接映射，`messages.js:92-99`）。Anthropic API 接受相邻同角色消息，但未逐一验证 openai-responses/google 等其他 provider 序列化路径。
3. **prompt cache 命中率**：尾部注入对前缀缓存友好的判断是推理，未实测 cacheRead token 变化。
4. **RPC 模式触发**：`transformContext` 注册在 `sdk.js` 的共享构造路径上，理论上 TUI/RPC/print 全模式生效，但未在 pi-web 的 RPC 链路上实测。
5. **`structuredClone` 开销**：`emitContext` 每次深拷贝全量消息（`runner.js:749`），超长会话下的性能影响未测量（官方亦如此设计，视为可接受）。
6. **子代理（subagent）会话**：pi-web 有 subagent 资源逻辑（`rpc-manager.ts:1900-1960` 附近），子代理会话是否继承宿主的 inline extension 未深入验证。
7. 版本差异：pi-web 依赖 0.84.3，本机为 0.84.2；本报告所有行号以本机 0.84.2 为准，升级后行号可能漂移（类型结构在两个版本间一致）。

---

## 附：证据文件索引

| 主题 | 文件 | 关键行号 |
|---|---|---|
| 事件类型全集 | `dist/core/extensions/types.d.ts` | 868-900（on 重载）、524-535、806-810、499-503、775-777 |
| emitContext 实现 | `dist/core/extensions/runner.js` | 747-775 |
| emitBeforeAgentStart 实现 | `dist/core/extensions/runner.js` | 837-896 |
| before_agent_start 调用点 | `dist/core/agent-session.js` | 885-905 |
| custom 消息持久化 | `dist/core/agent-session.js` | 365-381 |
| transformContext 注册 | `dist/core/sdk.js` | 222-227 |
| transformContext 执行 | `pi-agent-core/dist/agent-loop.js` | 175-185（181-182 为调用） |
| prompt 消息 emit | `pi-agent-core/dist/agent-loop.js` | 58-73 |
| CustomMessage 类型 | `dist/core/messages.d.ts` | 32-39、52-59 |
| custom → user 转换 | `dist/core/messages.js` | 75-115（92-99） |
| CustomMessageEntry | `dist/core/session-manager.d.ts` | 90-102 |
| 压缩对 custom 的处理 | `dist/core/compaction/compaction.js` | 210-247 |
| 压缩替换状态 | `dist/core/agent-session.js` | 1432-1434 |
| system prompt 重建时机 | `dist/core/agent-session.js` | 643、710-740、1778 |
| agentsFilesOverride | `dist/core/resource-loader.d.ts` / `.js` | 108-117 / 378 |
| 官方事件文档 | `docs/extensions.md` | 275-330（图）、521-556、648-657 |
| 官方 SDK 文档 | `docs/sdk.md` | 617-651 |
| context 事件用例 | `examples/extensions/plan-mode/index.ts` | 177-198 |
| before_agent_start 用例 | `examples/extensions/plan-mode/index.ts` | 201-240 |
| pi-web 接入形态 | `/tmp/pi-web/lib/rpc-manager.ts` | 1949-2010 |
| pi-web inline extension 写法 | `/tmp/pi-web/lib/project-command-env.ts` | 87-112 |
