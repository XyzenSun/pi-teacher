# Pi 会话跑在宿主进程内，桥接层从 pi-web 移植

所有 AgentSession 由后端宿主进程用 Pi SDK 直接创建，全部活在同一个 Express 进程里。会话注册表、启动锁、空闲回收、事件转 SSE 这层「桥接」从 pi-web 的 `rpc-manager.ts` 移植，**不 spawn pi CLI 子进程**。

## 本 ADR 曾定为子进程方案，后反转

第一版 ADR-0024 是「每对话一个 `pi --mode rpc` 子进程」，理由是概念边界干净：一对话一进程，关闭真释放内存，故障天然隔离。那是**概念上的简单**。

反转的触发是逐部件清点「要写多少没有参考实现的新代码」：

| 部件 | 进程内（抄 pi-web） | 子进程 |
| --- | --- | --- |
| 会话生命周期 | 抄 `rpc-manager.ts`（注册表 + 启动锁 + 空闲回收），`pi-web-研究/01-桥接层.md` 有移植清单 | 自研，无参考 |
| 事件 → SSE | 原样抄三个文件 | 订阅层不能抄，改写成读 RPC 事件流 |
| 扩展与卡片工具 | `InlineExtension` 在宿主进程，工具函数直接闭包访问后端的 SQLite 连接 | 扩展在子进程，自建数据库连接，WAL 成硬前提 |
| 扩展 UI 确认交互 | pi-web 有现成实现 | 自研跨进程往返转发，无先例 |
| 坑 | fork 变异、dispose 幂等、SSE 重连补发——全被 pi-web 踩过，连解法一起抄 | RPC 长连接 + 扩展转发组合无生产先例，自己趟 |

本项目的开发模式是「AI 写代码、用户看效果」——有参考实现的代码错误率远低于自研，调试时还能对照原版。**工程量的简单压倒概念的简单**，这是子进程方案输掉的原因。

官方文档也站在这一边：`docs/rpc.md` 明确建议 Node.js 宿主直接用 SDK 而不是 spawn 子进程。pi-web 是 MIT 许可，整套桥接层经过生产验证。

## 运行时形态

每个 pi_session（对话）对应一个进程内 AgentSession，以 `pi-teacher-pi-session-id-{pi_session.id}` 为会话 id：

```
SessionManager.create(workPath, workPath, { id })   // 自定义会话目录 + 固定 id
→ createAgentSessionServices(...)                   // 设置、模型解析、资源加载
→ createAgentSessionFromServices(...)               // 会话实例
→ getSessionFile()                                  // jsonl 路径，写回 pi_session.path
→ 包一层 Wrapper 入注册表（Map<id, Wrapper>），并发启动用 Promise 锁去重
```

- **重开对话 = 从磁盘恢复**：`SessionManager.open(jsonl)` 重建 AgentSession，内存态不保留。pi-web 的 `/api/agent/[id]` 路由在生产中就是这么做的，无损。
- **关闭**：用户点关闭按钮即 `shutdown()` → 给扩展发 `session_shutdown` → `session.dispose()`（abort 全部进行中的工作、失效扩展上下文、退订事件、清理资源），从注册表删除引用。
- **空闲自动回收**：沿用 pi-web 的 10 分钟空闲 `dispose()`，计时器在每条命令与流式事件上重置，运行中只顺延不回收。
- **进程退出兜底**：`process.once("exit", destroy)` + SIGINT/SIGTERM 全量 shutdown。

## 宿主是 Express，globalThis 补丁整个消失

pi-web 把注册表挂在 `globalThis` 上，唯一原因是 **Next.js dev 热重载会重建模块但保留 globalThis**——那是 Next 特有的坑。Express 没有这个问题，注册表用普通模块级变量即可，抄过来的代码反而更少更直白。API 路由的移植就是「route handler 换成 Express 路由函数」。

## 真实代价（不美化）

- **`dispose()` 不把堆还给 OS。** 对象可回收，但进程 RSS 基本不降，「关闭省内存」弱化为「闲置自动回收 + 手动立即回收」。不过内存账要算全：多开会话时进程内反而更省——N 个对话共享一份 Pi runtime，子进程方案是 N 份。单用户场景这个差异不致命。
- **故障不隔离。** 一个会话的扩展抛未捕获异常理论上影响宿主，靠 try/catch 缓解（抄 pi-web 的做法）。最坏情况损失「正在进行的回合」，落盘的 jsonl 与 SQLite 都在，重启后恢复。
- **API 漂移要实测。** pi-web 依赖 Pi 0.84.3，我们用 0.84.2，`01-桥接层.md` 6.3 节列了 8 项差异（最关键 `preflightResult` 与 `agent_settled`）。移植时逐项核对。
- **fork 原地变异**：`AgentSession.fork()` 会原地改 wrapper 内部状态，fork 后必须立刻销毁旧 wrapper。pi-web 已解，抄；我们几乎不用 fork。

## Considered Options

### 每对话一个 `pi --mode rpc` 子进程（本 ADR 第一版）

概念边界最干净、关闭真释放内存、故障隔离。否决理由见上表——在「有 pi-web 可抄」的前提下，全链路自研的 RPC 事件流改写、扩展跨进程、UI 转发带来的错误与调试成本，压过它的架构优势。技术事实留档：`--session-id <id>` 存在且「不存在则以该 id 新建」（首开与重开同一代码路径），此前「Pi 没有 --session 参数」的说法是错的（见 `pi-会话生命周期调研.md` Q1.1）；`RpcClient` 自带分帧处理可用。这些留给日后若因故障隔离需求重启子进程方案时参考。

### 全盘 Next.js 照抄（连宿主框架一起抄 pi-web）

适配量最小，但 Next 的核心卖点（SSR/SEO/边缘部署）对本地单用户工具价值为零，App Router、缓存语义等抽象是每个接口都要背的持续成本，且有状态后端还要为它的运行时心智打补丁。否决。

### 进程内 `switch_session` 轮换

一个进程挂多个会话轮流切换，每次切换 teardown 再全量重建。本质是「一进程管多会话」，且同工作区并发对话从根上不可能。否决。

## Consequences

- 扩展（`InlineExtension`）注册在宿主进程：卡片工具、取卡工具、`context` 注入都是普通函数，直接访问后端已打开的 better-sqlite3 连接，扩展**不需要自建数据库连接**，WAL 从多进程硬前提降为可选优化。
- 资料抓取子代理（ADR-0016）沿用 pi-web 的进程内做法：spawn 子 AgentSession，`inheritContext: false`。
- `pi_session.path` 从 `SessionManager.create()` 返回后立即 `getSessionFile()` 取得——路径在构造时就定了，延迟的只是写盘，不需要回填。
- SSE 三件套从 pi-web 原样抄（事件订阅、流式协议、重连快照补发）。
- 会话 id 命名规范 `pi-teacher-pi-session-id-{pi_session.id}` 保留，取自对话表而非工作区表——用工作区 id 会让该工作区所有对话挤一个 jsonl。
- 移植时逐项核对 `01-桥接层.md` 的 4 处改点与 8 项 API 漂移。
