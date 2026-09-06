# Pi 会话生命周期调研：CLI 参数、运行形态与 pi-web 的会话管理

> 调研日期：2026-09-06
> 调研对象：
> - Pi 本体：`@earendil-works/pi-coding-agent` **0.84.2**，安装于 `/root/.nvm/versions/node/v24.19.0/lib/node_modules/@earendil-works/pi-coding-agent/`（下文简称 **Pi 包**）
> - pi-web：`@agegr/pi-web` **0.8.11**，位于 `/tmp/pi-web`（依赖 Pi **0.84.3**，注意与本机 0.84.2 的版本差）
>
> 所有结论均给出「文件路径 + 行号」。标注「推测」的条目无代码证据。
> 本文只读源码，未执行 `pi` 命令。

---

## Q1：Pi 的 CLI 到底支持哪些参数？

**参数定义代码位置：`Pi 包/dist/cli/args.js`**，`parseArgs()` 在第 10-227 行，`printHelp()`（即 `pi --help` 的输出）在第 228-418 行。CLI 入口 `dist/cli.js`（18 行）只做初始化后调 `main(process.argv.slice(2))`（第 18 行）。

### 1.1 会话相关参数（重点）

| 参数 | 短名 | 语义 | 证据（args.js 行号） |
|---|---|---|---|
| `--session <path\|id>` | — | 使用指定会话文件或 UUID 前缀（先在本项目找，找不到则全局找） | 64-66 |
| `--session-id <id>` | — | 使用**精确的项目会话 ID**；不存在则**以该 id 新建** | 67-69 |
| `--continue` | `-c` | 继续当前项目最近一个会话 | 31-33 |
| `--resume` | `-r` | 打开会话选择器（**交互式 TUI 列表**） | 34-36 |
| `--fork <path\|id>` | — | 把指定会话分叉成新会话 | 70-72 |
| `--session-dir <dir>` | — | 指定会话存储目录 | 73-75 |
| `--no-session` | — | 不落盘（内存会话） | 61-63 |
| `--name <name>` | `-n` | 设置会话显示名 | 53-59 |

会话参数在 `Pi 包/dist/main.js` 的 `createSessionManager()`（第 282-349 行）被解析成 `SessionManager` 调用：

- `--no-session` → `SessionManager.inMemory(cwd)`（第 283-285 行）
- `--session` → `resolveSessionPath()`（第 194-213 行：含 `/`、`\` 或 `.jsonl` 后缀视为路径；否则先 `SessionManager.list(cwd)` 按 id 精确/前缀匹配，再 `SessionManager.listAll()` 全局匹配）。**注意**：命中「其他项目的会话」时走 `promptConfirm()`（第 213-226 行，直接读 stdin 的 y/N 确认，第 311-319 行）——无头场景下这是坑，应避免用 `--session` 跨项目引用。
- `--session-id` → `findLocalSessionByExactId()`（第 189-193 行），存在则 `SessionManager.open()`，不存在则打 warning 后 `SessionManager.create(cwd, sessionDir, { id })`（第 341-348 行）。
- `--continue` → `SessionManager.continueRecent(cwd, sessionDir)`（第 338-340 行）。
- `--resume` → `selectSession()` 交互选择器（第 325-337 行），**只适合 TTY**。

互斥校验（main.js 第 227-261 行）：`--fork` 不能与 `--session`/`--continue`/`--resume`/`--no-session` 组合；`--session-id` 不能与 `--session`/`--continue`/`--resume` 组合。

**session id 格式约束**（`Pi 包/dist/core/session-manager.js` 第 15-19 行）：`/^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/`——字母数字开头结尾，中间可用 `-`、`_`、`.`。自定义工作区固定 id 时必须符合。

### 1.2 目录相关参数

- **cwd：没有 CLI 参数**。Pi 取 `process.cwd()`（main.js 第 454 行 `const cwd = process.cwd()`）。想换工作目录只能由调用方在 spawn 时传 `cwd`，或 SDK 里传 `cwd` 选项（sdk.d.ts 第 11 行 `/** Working directory for project-local discovery. Default: process.cwd() */`）。
- **sessionDir**：`--session-dir`（args.js 73-75）或环境变量 `PI_CODING_AGENT_SESSION_DIR`（config.js 第 398 行 `ENV_SESSION_DIR = PI_CODING_AGENT_SESSION_DIR`；main.js 第 533-536 行：CLI 参数 > 环境变量 > settings 默认值）。
- **全局配置目录**：环境变量 `PI_CODING_AGENT_DIR`（config.js 第 397 行），默认 `~/.pi/agent`（第 417 行）。

### 1.3 非交互参数

- `--print` / `-p`：非交互模式，处理完 prompt 即退出（args.js 109-116 行；后面可紧跟消息参数）。
- `--mode <text|json|rpc>`：输出模式（args.js 25-30 行）。`json` 是结构化事件流的一次性执行；`rpc` 是常驻 JSON 协议（见 Q2）。

### 1.4 完整参数清单（`pi --help`，args.js 228-298 行原文）

```
--provider <name>              --no-tools, -nt / --no-builtin-tools, -nbt
--model <pattern>              --tools, -t / --exclude-tools, -xt <tools>
--api-key <key>                --thinking <level: off|minimal|low|medium|high|xhigh|max>
--system-prompt <text>         --extension, -e <path>（可多次）
--append-system-prompt <text>  --no-extensions, -ne
--mode <text|json|rpc>         --skill <path> / --no-skills, -ns
--print, -p                    --prompt-template <path> / --no-prompt-templates, -np
--continue, -c                 --theme <path> / --use-theme <name> / --no-themes
--resume, -r                   --no-context-files, -nc
--session <path|id>            --export <file>
--session-id <id>              --list-models [search]
--fork <path|id>               --verbose
--session-dir <dir>            --tui-mode <regular|fullscreen>
--no-session                   --approve, -a / --no-approve, -na
--name, -n <name>              --offline
--models <patterns>            --help, -h / --version, -v
```

另有子命令：`install/remove/uninstall/update/list/config/auth`（args.js 243-251 行）。扩展可注册自定义 flag（第 298 行、230-237 行）。

---

## Q2：`pi` CLI 是交互式 TUI 还是可以当服务用？

**结论：两者皆可。Pi 有四种运行形态，其中两种天生无头（headless）。**

README.md 第 19 行（Pi 包根目录）：

> Pi runs in four modes: interactive, print or JSON, RPC for process integration, and an SDK for embedding in your own apps.

模式判定逻辑 `Pi 包/dist/main.js` 第 83-94 行 `resolveAppMode()`：

```js
if (parsed.mode === "rpc")  return "rpc";
if (parsed.mode === "json") return "json";
if (parsed.print || !stdinIsTTY || !stdoutIsTTY) return "print";   // ← 关键
return "interactive";
```

即：**只要 stdin/stdout 不是 TTY（被管道接管），无需任何参数就自动降级为 print 模式**——子进程跑 `pi` 不会卡在交互界面。

### RPC 模式（对「当服务用」最相关）

- 启动方式：`pi --mode rpc` 或专用入口 `Pi 包/dist/rpc-entry.js`（第 10 行：`main(["--mode", "rpc", ...])`，进程名 `pi-rpc`）。另有 SDK 导出的 `RpcClient` 类可以 spawn 并类型化地驱动该协议（`Pi 包/dist/modes/rpc/rpc-client.d.ts`，含 `cliPath`/`cwd`/`env`/`args` 选项与 `start()`/`stop()` 方法）。
- 协议（`Pi 包/dist/modes/rpc/rpc-mode.js` 第 1-12 行文件头注释）：**stdin 收 JSON 命令（每行一个），stdout 出 JSON 响应与事件流**。严格 LF 分帧，官方文档明确警告不能用 Node `readline`（会在 U+2028/U+2029 处错误分行，docs/rpc.md 第 30-37 行）。
- 生命周期：进程**常驻**（rpc-mode.js 第 652 行 `return new Promise(() => { })` 永不 resolve）；stdin EOF 或 SIGTERM/SIGHUP 触发优雅退出（第 275-288、578-595 行：`runtimeHost.dispose()` → `process.exit`）。
- 一个 RPC 进程同一时刻只挂**一个会话**，但可以在进程内切换：`switch_session`（按 jsonl 路径）、`new_session`、`fork`、`clone` 命令（rpc-mode.js 第 333-340、473-497 行；命令全集见 `Pi 包/dist/modes/rpc/rpc-types.d.ts` 第 14-133 行）。**没有「一个进程挂多个并行会话」的能力。**
- 官方建议（docs/rpc.md 第 5 行）：

> Note for Node.js/TypeScript users: If you're building a Node.js application, consider using `AgentSession` directly from `@earendil-works/pi-coding-agent` instead of spawning a subprocess.

### print/json 模式

一次性执行：`pi -p "..."` 处理完退出（main.js 第 780-793 行 `runPrintMode` 后直接 return）。无交互、适合脚本调用，但**每条消息都要付一次「进程冷启动 + 会话文件全量重读」的成本**。

---

## Q3：pi-web 是怎么管理会话的？（最重要）

### 3.1 总答案：单进程、直接 import SDK，不 spawn pi CLI

`/tmp/pi-web/lib/rpc-manager.ts` 第 2 行：

```ts
import { createAgentSessionFromServices, createAgentSessionServices, getAgentDir,
         initTheme, SessionManager, SettingsManager, Theme } from "@earendil-works/pi-coding-agent";
```

pi-web 是 Next.js 应用（package.json：`next 16.3.1`，依赖 `@earendil-works/pi-coding-agent 0.84.3`），Pi 的 AgentSession 全部活在 Next.js 服务器进程内。其 AGENTS.md 第 42 行也自述：`"startRpcSession() in lib/rpc-manager.ts creates an AgentSession in-process."`

仓库里确有 `spawn`/`child_process`（lib/npx.ts、git-changes.ts、session-reader.ts 等），但都用于 git/文件/npx 辅助操作，**没有一处用于启动 pi agent**。

### 3.2 多会话数据结构：三个全局 Map

`/tmp/pi-web/lib/rpc-manager.ts` 第 1589-1593 行：

```ts
declare global {
  var __piSessions: Map<string, AgentSessionWrapper> | undefined;
  var __piStartLocks: Map<string, Promise<{ session: AgentSessionWrapper; realSessionId: string }>> | undefined;
  var __piStartingSessionCwds: Map<string, number> | undefined;
}
```

- `__piSessions`（第 1595-1610 行 `getRegistry()`）：**会话注册表**，key 为 Pi 生成的真实 session id。放 `globalThis` 而非模块级变量的原因：**Next.js dev 热重载会重建模块但保留 globalThis**（其 AGENTS.md 第 127 行明确记载）。
- `__piStartLocks`（第 1653-1656 行 `getLocks()`）：**并发启动去重**——同一 id 的并发 `startRpcSession` 合并为同一个 Promise（第 1890-1891 行命中在途锁直接返回）。
- `__piStartingSessionCwds`（第 1667-1681 行）：记录「正在启动中」的 cwd 计数，供 `hasBusyRpcSessionForCwd()` 判断某目录是否忙碌。

### 3.3 创建：`startRpcSession()`（第 1874-2067 行）

流程（关键行号）：

1. 注册表命中且存活 → 直接复用（第 1887-1888 行）；启动锁命中 → 返回在途 Promise（第 1890-1891 行）。
2. `sessionFile` 有值 → `SessionManager.open(sessionFile, undefined)`（第 1895 行，恢复会话）；否则 `SessionManager.create(cwd, undefined)`（第 1898 行，新建）。
3. `SettingsManager.create(sessionCwd, agentDir)`（第 1948 行）→ `createAgentSessionServices({ cwd, agentDir, settingsManager, resourceLoaderOptions... })`（第 1949-1985 行，含项目信任门控）→ 解析可见模型 → `createAgentSessionFromServices({ services, sessionManager, model?, tools?... })`（第 2008-2016 行）。
4. 包一层 `AgentSessionWrapper`（第 2046 行），`registerRpcWrapper()` 入注册表、订阅事件、派发 `session_start` 给扩展（第 1612-1620 行）。
5. `locks.set(sessionId, starting)`（第 2065 行），Promise settle 后删锁（第 2060-2063 行）。

**会话恢复（重新打开）**：`/tmp/pi-web/app/api/agent/[id]/route.ts` 第 39-56 行——POST 命令时若 `getRpcSession(id)` 不存活（第 36、39 行），先 `resolveSessionPath(id)` 找到 jsonl 文件（第 45 行），再 `startRpcSession(id, filePath)` 重开（第 55 行）。即**恢复 = 从磁盘 jsonl 重建 AgentSession**，内存态不保留。

### 3.4 销毁：空闲 10 分钟自动回收 + 显式关闭

**空闲超时**（rpc-manager.ts 第 434-447 行 `resetIdleTimer()`）：

```ts
this.idleTimer = setTimeout(() => {
  if (this.isRunning() && !this.forceShutdownOnIdle) { this.resetIdleTimer(); return; }
  void this.shutdown()...
}, 10 * 60 * 1000);   // ← 10 分钟
```

- 计时器在每次收到命令（第 528 行，`get_state` 除外）和 `IDLE_RESET_EVENT_TYPES`（`agent_end`/`agent_settled`/`auto_compaction_end`/`compaction_end`，第 119-124 行）时重置。
- `isRunning()` = `pendingPromptCount > 0 || isStreaming || isCompacting || isBashRunning`（第 261 行）。运行中只顺延不回收。
- `abort`/`abort_bash` 会置 `forceShutdownOnIdle = true`（第 636、937 行）：用户点停后，本轮一空闲就强制回收。

**两级销毁**：

- `shutdown()`（第 998-1021 行）：幂等（`shutdownPromise` 兜底）。等扩展绑定完成 → 给扩展发一次 `session_shutdown`（reason `"quit"`）事件 → `destroy()`。
- `destroy()`（第 950-996 行）：置 `_alive = false` → 清 idle 定时器 → `abortBash()` → 退订事件 → cancel 所有 pending 扩展 UI Promise → 关闭自定义 UI/widget → （若尚未发过）补发 `session_shutdown` → **`this.inner.dispose()`**（调用 Pi SDK 的 `AgentSession.dispose()`）→ 触发 `onDestroyCallback`，注册表据此 `registry.delete(sessionId)`（第 1616 行）。

**进程级兜底**（第 1598-1607 行）：`process.once("exit", destroy)`（同步 destroy，Node 退出钩子里不能 await）；`SIGINT`/`SIGTERM` → 全部 `shutdown()`。

**按工作区批量销毁**：`destroyRpcSessionsForCwd(cwd)`（第 1840-1847 行）——关掉某目录下全部会话。

### 3.5 一个空闲会话实例占多少内存？

**代码与文档中无相关信息。** 检索过 `/tmp/pi-web/lib/rpc-manager.ts`、`lib/subagent-runtime.ts`、`AGENTS.md`、`CONTEXT.md`、`docs/adr/*.md`（3 个 ADR），均无内存占用数字、无内存上限配置、无堆大小相关注释。pi-web 对会话数量**没有硬上限**，完全依赖「10 分钟空闲回收 + 前端关闭即关」软性控制（其 AGENTS.md 第 126-129 行只写了 idle timeout 10 分钟与启动锁，未提内存）。

会话实例实际持有的东西可以间接推断（`Pi 包/dist/core/agent-session-services.d.ts` 第 64-71 行 `AgentSessionServices` 接口）：`modelRuntime`、`settingsManager`、`resourceLoader` + AgentSession 自身的消息数组/事件监听器。这些总量「推测」在几十 MB 量级（Node 基线 + 全部历史消息驻留），但**未经测量，不能作为架构依据**。

### 3.6 一个重要陷阱：fork 会原地变异 inner 状态

pi-web AGENTS.md「Fork must destroy the wrapper immediately」一节：`AgentSession.fork()` **原地修改** wrapper 内部状态（fork 后 `inner.sessionId` 变成新会话 id），所以 pi-web 在 `send("fork")` 里捕获新 id 后立即 `destroy()` 旧 wrapper（rpc-manager.ts 第 723、751 行 `shutdownAfterSessionReplacement`）。设计多会话系统时若用 fork/switch 类 API 必须注意。

---

## Q4：Pi 的 SDK 有没有「关闭会话释放资源」的方法？

**有，两级都有 `dispose()`，但没有 `close()`/`destroy()`/`[Symbol.asyncDispose]`。**

### `AgentSession.dispose(): void`

- 声明：`Pi 包/dist/core/agent-session.d.ts` 第 283 行（sdk.md 文档第 110 行也列为 `// Cleanup`）。
- 实现：`Pi 包/dist/core/agent-session.js` 第 556-571 行：

```js
dispose() {
    try {                                    // 中止一切进行中的工作
        this.abortRetry(); this.abortCompaction();
        this.abortBranchSummary(); this.abortBash(); this.agent.abort();
    } catch { /* Dispose must succeed even if an abort hook throws. */ }
    this._extensionRunner.invalidate("...");  // 使扩展上下文失效（防陈旧引用）
    this._disconnectFromAgent();              // 退订 agent 事件
    this._eventListeners = [];                // 清空会话事件监听器
    cleanupSessionResources(this.sessionId);  // 调 pi-ai 的全局清理回调注册表
}
```

- `cleanupSessionResources`（`Pi 包/node_modules/@earendil-works/pi-ai/dist/session-resources.js` 第 8-21 行）：遍历 `registerSessionResourceCleanup` 注册的全部回调。检索 pi-ai dist，目前唯一的注册者是 OpenAI Codex 的 WebSocket 会话缓存清理（`api/openai-codex-responses.js` 第 679 行 `registerSessionResourceCleanup(closeOpenAICodexWebSocketSessions)`）。
- **注意**：`dispose()` 不 flush 会话文件——持久化在每条消息结束时已由内部完成（agent-session.js 第 532 行注释：`Session persistence is handled internally (saves messages on message_end)`）。
- **注意**：`AgentSessionServices`（modelRuntime/settingsManager/resourceLoader）**没有** dispose 方法（agent-session-services.d.ts 第 64-71 行纯数据接口）。释放靠丢引用 + GC；HTTP 连接走 undici 全局 dispatcher（进程级共享池），本就不随会话关闭。

### `AgentSessionRuntime.dispose(): Promise<void>`

- 声明：`Pi 包/dist/core/agent-session-runtime.d.ts` 第 104 行。
- 实现：`Pi 包/dist/core/agent-session-runtime.js` 第 288-295 行——先给扩展发 `session_shutdown`（reason `"quit"`），再 `this.session.dispose()`。**这就是 RPC 模式退出时调用的路径**（rpc-mode.js 第 588 行 `await runtimeHost.dispose()`）。
- `AgentSessionRuntime` 还提供会话**替换**方法：`switchSession(path)`（第 128-146 行）、`newSession()`（第 147-173 行）、`fork()`（第 174 行起）、`importFromJsonl()`（第 258-287 行）——每次替换都会先 `teardownCurrent()`（abort + `session_shutdown` + `session.dispose()`，第 102-113 行）再建新 runtime。**单 Runtime 内换会话是官方支持的**，代价是旧会话内存立即释放、新会话全量重建。

### 其他

- `[Symbol.asyncDispose]` 只存在于 `Pi 包/dist/client/remote-session.d.ts` 第 51 行（`RemoteSession`，远程会话客户端子系统），与本地 `AgentSession` 无关。
- pi-web 的用法即最佳实践：`shutdown()`（发 `session_shutdown` 给扩展）→ `destroy()` → `inner.dispose()`，然后从注册表删除引用（rpc-manager.ts 第 950-1021 行）。

---

## 对 pi-teacher 的意义

需求：**每个工作区（学习区/复习区等）独立进程、可手动关闭以省内存、可重新打开恢复会话**。基于以上事实，有三条可行路径：

### 路径 A：每工作区一个 RPC 子进程（`pi --mode rpc`，或 `RpcClient`）

做法：主进程按工作区 spawn `pi --mode rpc --session-dir <我们的目录>`（cwd 设为工作区路径，因为 cwd 无 CLI 参数、只能靠 spawn 的 `cwd` 选项）；用 SDK 导出的 `RpcClient`（rpc-client.d.ts）类型化驱动；关闭 = kill 子进程（SIGTERM 有优雅退出路径，rpc-mode.js 第 275-288 行）；恢复 = 重启子进程后发 `switch_session` 或直接以 `--session-id <工作区固定id>` 启动。

- 优点：**内存隔离最彻底**——关闭即进程消失，泄漏的扩展/监听器/消息缓存全部归零，与「每工作区独立进程」需求天然对齐；单个工作区崩溃不殃及主进程；`AI_AGENT=pi` 等环境已由入口自动设置。
- 代价：每工作区一个 Node 常驻进程（每个约等于一份完整 Pi 运行时的 baseline，粗估几十 MB，**推测、未测量**）；需要自己实现 JSONL 分帧客户端（官方警告不能用 readline，docs/rpc.md 第 30-37 行，但可直接抄 `Pi 包/dist/modes/rpc/jsonl.js` 的 `attachJsonlLineReader`）；扩展 UI 对话框协议（extension_ui_request/response）要转发到我们的 UI；进程意外退出的监控与自动重启逻辑自建。
- 风险点：0.84.2 的 RPC 协议成熟度（pi-web 没走这条路，等于该组合在生产中验证较少）。

### 路径 B：单进程 SDK + 全局注册表（完全照抄 pi-web 桥接层）

做法：在主 Node 进程里 `import { createAgentSessionServices, createAgentSessionFromServices, SessionManager } from "@earendil-works/pi-coding-agent"`，抄 `/tmp/pi-web/lib/rpc-manager.ts` 的 `AgentSessionWrapper` + `__piSessions` 注册表 + `startRpcSession`；关闭 = `wrapper.shutdown()`（内部 `session.dispose()`，见 Q3.4/Q4）；恢复 = `SessionManager.open(jsonl)` 重建。已有研究文档 `docs/pi-web-研究/01-桥接层.md` 给出了详细的移植/裁剪清单。

- 优点：pi-web 全套生产验证（含 10 分钟空闲回收、fork 原地变异陷阱的修复、SSE 重连快照补发）；无 IPC 序列化开销；事件直接在进程内订阅；内存回收可控（dispose + 丢引用即释放，Q4 证实 SDK 提供了完整清理入口）。
- 代价：**进程内内存隔离**——V8 堆不还给 OS，多个会话的峰值叠加在同一进程；一个会话的扩展抛出未捕获异常理论上可影响整个宿主进程（pi-web 用大量 try/catch 缓解）；「每工作区独立进程」这一字面需求**不满足**，除非接受「独立会话实例 + 手动 dispose」的弱化版本。
- 风险点：0.84.2 与 pi-web 所依赖 0.84.3 的 API 漂移（`01-桥接层.md` 第 6.3 节列了 8 项，最关键的是 `preflightResult` 与 `agent_settled`，需实测）。

### 路径 C：混合——单进程 SDK 管理 + 每工作区空闲后 dispose、重开时从 jsonl 重建

做法：路径 B 的结构，但把 pi-web 的「10 分钟空闲自动回收」改成「用户手动关闭即 dispose；重开时 `SessionManager.open()` 从磁盘恢复」。恢复语义已验证可行：pi-web 的 `/api/agent/[id]` 路由就是这么做的（Q3.3 末尾），Pi 的会话文件是自包含的 append-only jsonl 树（`--export`/`get_entries` 均基于它）。

- 优点：实现量最小（比 A 少 IPC 层、比 B 只是把定时器换成手动触发）；「可手动关闭省内存、可重新打开恢复」两点**语义上都满足**（关闭后该会话只剩磁盘 jsonl）；重开成本 = 读一个 jsonl + 重建服务，pi-web 在每次 POST 时都可能走这条路径，证明开销可接受。
- 代价：与 B 相同的进程内隔离限制；被关闭会话若有正在跑的 run 会丢失内存态（dispose 会 abort，Q4）——需要「关闭前确认空闲」的交互约定。
- 注意：会话 jsonl 存储目录用 `SessionManager.create(cwd, sessionDir)` 的第二参自定义（`01-桥接层.md` 第 6.1 节的 4 处改点），不要动 `getAgentDir()`。

### 选择建议（基于事实，非最终决定）

- 若「每工作区独立进程」的动机是**故障隔离**（工作区内的扩展/bash 崩溃不该拖垮主应用）→ 只有路径 A 真正满足。
- 若动机只是**省内存**（空闲工作区不占 RAM）→ 路径 C 即可：SDK 的 `dispose()` 链路完整（abort 全部工作、失效扩展上下文、退订事件、清理 WebSocket 资源），pi-web 已在生产验证「dispose 后从 jsonl 无损重开」。
- pi-web 本身（官方生态内最成熟的 Pi 宿主）选择了进程内方案，且官方文档明确建议 Node.js 宿主不要 spawn 子进程（docs/rpc.md 第 5 行）——这是路径 B/C 的最强背书。
- 无论哪条路：cwd 只能通过 spawn 选项（A）或 SDK `cwd` 参数（B/C）指定，`--session-dir`/`SessionManager` 第二参控制会话落盘位置；固定会话 id 需符合 `[A-Za-z0-9][A-Za-z0-9._-]*[A-Za-z0-9]` 格式（Q1.1）。
