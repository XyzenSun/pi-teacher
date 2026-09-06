# 每个工作区一个独立的 Pi 子进程

一个工作区（`learn/<session_id>/`、`review/`、`ta/`）对应一个独立的 Pi 子进程，以 `pi --mode rpc` 启动。关闭会话 = 杀掉那个进程；重新打开 = 用同一个 `--session-id` 重新 spawn，Pi 从 jsonl 恢复。

否决「单进程内用 SDK 管理多个 AgentSession」（pi-web 的做法）。

## 先纠正一条事实

此前 `open-questions.md` 里写过「Pi 官方没有 `--session` 参数」，这是错的。核实结果（见 `pi-会话生命周期调研.md` Q1.1）：

| 参数 | 语义 |
| --- | --- |
| `--session <path\|id>` | 按路径或 UUID 前缀找会话 |
| `--session-id <id>` | 精确 id；**不存在则以该 id 新建** |
| `--session-dir <dir>` | 会话落盘目录 |
| `--no-session` | 内存会话，不落盘 |

我们用 `--session-id`，不用 `--session`。原因：`--session` 命中「其他项目的会话」时会走 `promptConfirm()` 直接读 stdin 等 y/N，无头场景下这是死锁。`--session-id` 没有这条分支，且「不存在就新建」正好把「首次打开」和「重新打开」合成同一条代码路径——后端不需要判断这个工作区之前有没有开过。

session id 必须匹配 `/^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/`，我们的 id 从数据库自增主键派生（如 `learn-5`、`review`、`ta`），天然合规。

## 为什么不用 pi-web 的进程内方案

pi-web 把所有 AgentSession 放在 Next.js 服务器进程里，靠 `globalThis.__piSessions` 注册表 + 10 分钟空闲 `dispose()` 管理。官方文档也建议 Node 宿主直接用 SDK 而不是 spawn 子进程。

但它带来的复杂度不是我们想承担的：

- **注册表、启动锁、cwd 忙碌计数三个全局 Map**，都是为了绕开「同一个进程里多个会话互相干扰」。`fork()` 会原地变异 wrapper 内部状态，所以 fork 后必须立刻 destroy 旧 wrapper——这类陷阱是进程内共享状态的直接产物。
- **V8 堆不还给 OS**。`dispose()` 释放的是引用，进程的常驻内存不会跌回去。用户点「关闭会话省内存」时，什么都没省下。
- **一个会话的扩展抛未捕获异常能拖垮整个宿主**。pi-web 用大量 try/catch 缓解，那是它必须做的事，不是我们想抄的事。

子进程方案里这些问题都不存在：一个工作区一个进程，关闭就是 `SIGTERM`，内存真的归零，崩溃只影响那一个工作区。注册表退化成「workspace id → 子进程 handle」的一张薄表。

## 具体形态

启动一个工作区：

```
spawn("pi", [
  "--mode", "rpc",
  "--session-id", "learn-5",
  "--session-dir", "<工作区目录>",
  "--extension", "<我们的扩展>",
], { cwd: "<工作区目录>" })
```

- **cwd 只能靠 spawn 传**。Pi 没有 cwd 的 CLI 参数，它取 `process.cwd()`。这条正好符合我们的需求：工作区目录就是 cwd，`AGENTS.md`、`USER.md`、`MISSION.md`、`learning-records/` 全在里面被自动发现。
- **不手写 JSONL 分帧**。Pi SDK 导出了 `RpcClient`（含 `cliPath`/`cwd`/`env`/`args` 选项与 `start()`/`stop()`），直接用它驱动协议。官方明确警告不能用 Node `readline` 读这个流（会在 U+2028/U+2029 处错误分行），`RpcClient` 已经处理了。
- **关闭**：`SIGTERM` 有优雅退出路径（`runtimeHost.dispose()` → 给扩展发 `session_shutdown` → `process.exit`）。不用 `SIGKILL`。
- **空闲回收**：不做定时器。用户手动关。这是 ADR 系列一贯的取向——把「什么时候该关」交给用户，代码不猜。

## 代价

**每个工作区一个常驻 Node 进程。** 具体多少内存没有实测数据（pi-web 的代码和文档里都没有内存数字），粗估几十 MB 量级。这是这个方案付出的主要成本，换来的是「关闭真的能省内存」——而进程内方案连这一点都做不到。

**SSE 链路多一跳。** 子进程 stdout 的 JSONL 事件流 → 后端解析 → SSE 推给浏览器。pi-web 的前端与 Markdown 管线仍然可以抄，但它的事件订阅层（进程内 `session.on(...)`）要换成读 RPC 事件流。

**扩展跑在子进程里。** 这是影响最大的一条：`context` 事件、卡片工具、取卡工具都由 `--extension` 加载进子进程，不是在宿主进程里注册 `InlineExtension`。于是扩展需要自己连 SQLite——多个工作区的子进程会并发读写同一个数据库文件。**SQLite 必须开 WAL 模式**，否则并发写会撞锁。

**扩展 UI 协议要转发。** Pi 的 `extension_ui_request` / `extension_ui_response` 是一对往返消息，需要从子进程转到浏览器再转回来。卡片提议的确认交互如果走扩展 UI，就要过这条链路；若改成「扩展只写库、WebUI 自己轮询提案」则完全绕开，实现时再定。

**RPC 模式的生产验证少于进程内方案。** pi-web 没走这条路，等于 `pi --mode rpc` + 长连接这个组合在真实负载下的表现我们得自己踩。协议本身有官方文档和 `RpcClient` 客户端，不是无人区，但要预留调试时间。

## Considered Options

### 单进程 + SDK + 会话注册表（照抄 pi-web）

否决理由见上。补一条：这个方案的核心优势是「零 IPC 开销、事件直接订阅」，而我们的负载是单用户、并发工作区个数是个位数，IPC 开销在这个量级上不构成瓶颈。用复杂度换一个我们感受不到的性能收益，不值。

### 单进程 + 动态切换工作目录

即一个 Pi 进程用 `switch_session` 在工作区之间来回切。官方支持（`AgentSessionRuntime.switchSession()`），但每次切换都要 `teardownCurrent()` 再全量重建。用户在学习区和助教区之间来回问，等于每次切换都付一次会话重建成本，而且两个工作区无法同时在跑。否决。

### 每次请求 spawn 一次 `pi -p`（print 模式）

无状态，最省内存。否决：每条消息都要付一次「进程冷启动 + 会话文件全量重读」的成本，而且流式输出、扩展 UI 往返、中途 abort 全都做不了。

## Consequences

- 后端需要一个进程管理器：`workspace id → { child, RpcClient, 状态 }`，负责 spawn / SIGTERM / 意外退出检测。意外退出的处理策略（自动重启还是让用户手动重开）留到实现时定。
- WebUI 每个工作区显示进程状态，提供「关闭」与「打开」两个按钮。关闭前若有正在跑的 run，先确认——`dispose()` 会 abort，内存态会丢。
- SQLite 开 WAL 模式，这是多进程访问的前提，不是优化项。写进建库脚本。
- 扩展打包成独立文件（或目录），路径通过 `--extension` 传入。它是子进程的一部分，不能依赖宿主进程的内存状态——所有跨进程共享的东西走 SQLite。
- `--session-dir` 指向工作区目录，jsonl 与 `AGENTS.md` 等文件同处一地，与 ADR-0004「会话存储与业务存储分离」不冲突：分离说的是 jsonl 不进数据库，不是 jsonl 不能和工作区文件放一起。
- 全局配置目录用默认 `~/.pi/agent`（可用 `PI_CODING_AGENT_DIR` 改）。全局 `AGENTS.md` 放在 `~/.pi/agent/AGENTS.md`，所有子进程共享。
