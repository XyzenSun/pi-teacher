# 未决问题

已确认的决策见 [`adr/`](./adr/)，Schema 见 [`../数据库设计.md`](../数据库设计.md)，领域语言见 [`../CONTEXT.md`](../CONTEXT.md)。本文只记录尚未拍板的事项。

阻塞工具定义与提示词设计的问题已全部清空。剩下 4 条都在别的方向上：两条等技术栈介绍，一条等界面设计稿，一条等实现时验证。

## 真正未决

1. **`context` 事件返回值的容器格式。** 通道已定（见 `pi-hook机制调研.md`），注入项也已定（待复习卡数、当前使命摘要、最近学习记录），但用什么标记包裹还没定。`<system-reminder>` 是 Pi 内部在用的标记，我们复用可能与它自己的注入撞车。需要在实现时看一次真实 payload 再定。

2. **Web 后端框架**（Express / Fastify / Hono / Next.js API Routes）。用户对 Node 生态不熟，等一轮技术栈介绍后再定。注意：ADR-0024 定了子进程方案，pi-web 的进程内桥接层不再是「照抄」，Next.js 的绑定力度比原先估计的低。

3. **前端框架**（React / Vue / Svelte）与状态管理。同上。pi-web 的前端（Markdown 管线、Mermaid 渲染、SSE 消费）仍可复用，那部分是 React。

4. **卡片管理与复习界面的交互与布局。** 用户会提供参考图与参考 HTML。复习界面是对话窗口（见 ADR-0018），另需「自己刷卡」入口（见 ADR-0021）。

## 实现时验证

不阻塞设计，但实现到那一步要跑一次确认。

| 待验证 | 影响 | 出处 |
| --- | --- | --- |
| `fsrs-optimizer` 空输入是返回默认权重还是抛异常 | 若抛异常，接口层要捕获并提示「记录不足，参数未改变」 | ADR-0021 |
| 一个 Pi 子进程的常驻内存 | 决定 WebUI 是否需要提示用户「工作区开太多了」 | ADR-0024 |
| RPC 模式的长连接稳定性 | pi-web 没走这条路，此组合缺生产验证 | ADR-0024 |

## 已在别处解决的

以下问题曾列在本文，现已有答案，记录出处避免重复讨论。

### 卡片与复习

| 问题 | 结论 | 出处 |
| --- | --- | --- |
| 卡片去重判据 | 精确匹配（同 Topic、`front` 归一化）归代码，语义相似归模型；首版不用向量 | ADR-0017 |
| 复习形态 | 取一批 → 组织对话 → 批量判定 | ADR-0018 |
| Rating 判定规则 | 模型直接输出四档，无中间映射层；每档含义写在 rubric 里，待细化 | ADR-0019 |
| 一批取多少张卡 | 取卡工具只给 `nums` 参数，由 AI 结合用户偏好自主决定 | ADR-0021 |
| 到期卡积压 | 不调整 `due`，队列如实累积；另提供不经 AI 的 WebUI 手动复习 | ADR-0021 |
| 每张卡耗时预估 | 不做。节奏偏好由用户与 AI 在对话中写进 `USER.md`，代码不约束 | ADR-0021 |
| FSRS 训练的最少记录数 | 不设门槛，0 条也允许调用——记录不足时优化器本身不会改变权重 | ADR-0021 |
| 卡片表字段 | 6 个字段 + `status` 三态，无 `answer_mode` 与 `metadata` | `数据库设计.md` |
| 卡片溯源 | 不存消息 id 与对话外键，靠 `reason_and_remark` | ADR-0010 |
| 卡片提议确认 UI | 批量确认与零星确认共用同一套交互 | — |
| 合并卡的判据与实现 | 纯提示词约束触发时机 + 合并工具做实际合并与 FSRS 状态更新，不让 AI 算 | `todo.md` |
| 难题清单数据结构 | 不建表，Sticking Point 术语废弃 | ADR-0009 |
| 是否集成 Anki | 不集成 | ADR-0008 |

### 上下文与工作区

| 问题 | 结论 | 出处 |
| --- | --- | --- |
| 工作目录组织方式 | `~/pi-teacher/learn/<session_id>/` | `数据库设计.md` |
| 每轮动态注入机制 | Pi 的 `context` 事件，不落盘、不受压缩 | `pi-hook机制调研.md` |
| 历次对话摘要如何分层 | 不做。只用 Pi 的自动压缩，靠 `learning-records/`、`USER.md`、`MISSION.md`、术语表推断学习情况 | 本文 |
| 已掌握术语怎么给模型 | 不注入，`USER.md` 里写引导，AI 自主决定何时用数据库工具查 | ADR-0020 |
| AGENTS.md 生成时机 | 新开对话时从 `agents_md` 表整份覆盖写出 | `数据库设计.md` |
| `review/AGENTS.md` 从哪来 | 与学习、助教统一：开对话时从模板投影。`agents_md` 加 `type` 字段供 WebUI 筛选 | `数据库设计.md` |
| 资料存哪、索引格式 | 全局 `materials/`，索引是 `index.md` 普通 Markdown，模型自读自写，不做程序解析 | `数据库设计.md` |
| 资料抓取的上下文污染 | 交给子代理，`inheritContext: false` | ADR-0016 |
| 视频转文本、网页抓取服务 | 后续由 skill 接第三方实现；视频下载用 yt-dlp，网页抓取用用户已有工具 | `todo.md` |
| 学习计划 | 由 `MISSION.md` 承担，不做「每天学什么」的拆分 | `todo.md` |
| 对话标题生成 | 后端独立 LLM 调用，prompt 为「总结下面的内容，生成一个 20 字以内的标题」 | `数据库设计.md` |
| 助教会话压缩参数 | 保持 Pi 默认 | — |
| Pi 会话存储格式 | JSONL + 自定义 `sessionDir` 指向工作目录 | `数据库设计.md` |

### 提醒与生成内容

| 问题 | 结论 | 出处 |
| --- | --- | --- |
| 卡片提醒的默认轮次 | WebUI 后台直接暴露 hook 配置的 JSON 字段供用户改，不设「正确默认值」 | 本文 |
| 多条提醒同时触发怎么合并 | 直接拼接两个 `<system-reminder>` 块，不做优先级与去重 | 本文 |
| 生图预算与重试 | 不控预算（用户在 API 提供商侧设限）、不重试 | ADR-0023 |
| 生图存哪 | `~/pi-teacher/llm-text-to-img/`，全局共用，由 skill/mcp 内部落盘 | ADR-0023 |
| 生图触发方式 | AI 主动提议，纯提示词，不做 hook | ADR-0023 |
| Mermaid 渲染与失败回退 | pi-web 的 `MermaidBlock.tsx` 有现成实现 | `pi-web-研究/03a-Markdown管线.md` |
| HTML 输出服务端渲染 | 首版不做 | — |

### 部署与运维

| 问题 | 结论 | 出处 |
| --- | --- | --- |
| Pi 实例的进程模型 | 每工作区一个 `pi --mode rpc` 子进程，用 `--session-id` 启动，关闭即杀进程 | ADR-0024 |
| Docker 基础镜像 | `node:22-slim`。alpine 只小 87MB，不值得换取 musl/BusyBox 差异 | ADR-0015 |
| 镜像内的语言运行时 | 只有 Node.js，不装 Python。工具脚本用 Shell / Node / 预编译 Go 二进制 | ADR-0015 |
| Go 工具怎么进镜像 | 独立仓库开发，GitHub Actions 交叉编译，本仓库只 `COPY` 二进制 | ADR-0015 |
| SQLite 挂载 | 单独挂卷。多子进程并发访问，必须开 WAL | ADR-0015、ADR-0024 |
| 用户认证 | 单用户账号密码，不做 OAuth，永远不做多用户、不预留 `tenant_id` | ADR-0022 |
| 备份与导出 | 只做导出不做自动备份；在线导出打包 `~/pi-teacher/` 但不含 SQLite（需停容器手动复制） | ADR-0022 |
| 手机端 | 不做 apkg、不做原生端。以后只是 WebUI 适配小屏，后端不改 | ADR-0022 |
| Pi 事件流转 SSE | pi-web 有实现可参考，但子进程方案下事件订阅层要换成读 RPC 流 | ADR-0024 |
| 沙箱选型 | 设计工具时再定 | — |

## 已核实的外部事实

以下来自对源码的核实，供决策参考，本身不是结论。

### Pi CLI 与会话生命周期（核实于 v0.84.2，详见 `pi-会话生命周期调研.md`）

- **`--session-id <id>` 存在，且「不存在则以该 id 新建」**。此前本文写过「官方没有 `--session` 参数」，是错的。
- `--session <path|id>` 命中其他项目的会话时会读 stdin 等 y/N 确认，**无头场景下会死锁**，应避免。
- **cwd 没有 CLI 参数**，Pi 取 `process.cwd()`。只能靠 spawn 的 `cwd` 选项或 SDK 的 `cwd` 参数指定。
- session id 须匹配 `/^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/`。
- **stdin/stdout 不是 TTY 时自动降级为 print 模式**，不会卡在交互界面。
- Pi 有四种运行形态：interactive / print / json / **rpc**。RPC 是 stdin 收 JSON 命令、stdout 出 JSON 事件的常驻协议，SIGTERM 有优雅退出路径。官方警告不能用 Node `readline` 读这个流，SDK 导出了 `RpcClient` 已处理分帧。
- **一个 RPC 进程同一时刻只挂一个会话**，可在进程内 `switch_session` 切换，但没有「一进程多并行会话」的能力。
- SDK 两级都有 `dispose()`：`AgentSession.dispose()`（abort 全部工作、失效扩展上下文、退订事件、清理 WebSocket 资源）与 `AgentSessionRuntime.dispose()`（先发 `session_shutdown` 再调前者）。没有 `close()`。
- `dispose()` 不 flush 会话文件——持久化在每条消息结束时已完成。
- **`AgentSession.fork()` 原地变异内部状态**，fork 后 `inner.sessionId` 变成新 id，宿主必须立刻销毁旧 wrapper。
- pi-web 走的是进程内 SDK 方案（`globalThis.__piSessions` 注册表 + 启动锁 + 10 分钟空闲回收），不 spawn pi CLI。官方文档也建议 Node 宿主直接用 SDK。我们仍选了子进程，理由见 ADR-0024。
- 一个空闲会话实例占多少内存：**pi-web 的代码与文档里都没有数字**，也没有会话数上限配置。

### Pi 的存储与注入机制（核实于 v0.84.2）

- 默认会话存储是 JSONL，条目以 `id` / `parentId` 构成树结构，压缩不删除旧条目，完整历史可用于 Web UI 展示。
- 官方存在 SQLite 会话后端，但属 pre-stabilization：schema 近期发生过一次不带迁移的破坏性变更。
- 存在可自行实现的会话仓库与存储接口，是落到自有存储的正规入口。
- **没有官方的自动标题生成能力**，标题需自建。
- 会话头部没有自由 metadata 字段槽位，自定义业务数据需走自定义条目通道。
- **`context` 事件**：每次 LLM 调用前触发，返回值只进请求 payload，不写 jsonl、不受压缩影响，是每轮动态注入的正规通道。`before_agent_start` 注入的 `role: "custom"` 消息会落盘且参与压缩，不适合此用途。
- 自动压缩可配置触发阈值与保留窗口，压缩产物是追加的条目，原始消息保留。
- `AGENTS.md` 机制：全局 `~/.pi/agent/AGENTS.md`（是 `agent/` 不是根 `.pi/`）+ 工作目录 `AGENTS.md`（是 cwd 本身，不是 `.pi/AGENTS.md`）。不受压缩影响。**`@文件` 引用不存在于 AGENTS.md 内部**，它是 CLI 参数语法，不是文件 import。
- `SessionManager.create(cwd, sessionDir)` 可自定义会话存储目录，JSONL 平铺在 `sessionDir` 下。
- **延迟落盘但路径提前确定**：文件名在构造时生成（`<时间戳>_<sessionId>.jsonl`），`getSessionFile()` 创建后立即可取，写盘动作延迟到首条 assistant 回复。所以路径不需要回填。
- `create(cwd, sessionDir, options)` 的 `options.id` 可自定义 sessionId，会进入文件名。
- `open(path, sessionDir, cwdOverride)` 可完全自定义文件路径，但 sessionId 随机不可指定，`cwd` 需显式传第三参否则退化为 `process.cwd()`。传入 0 字节的已存在文件会让 header 当场落盘。
- 原生无 subagent，但可用 `InlineExtension` + `defineTool` 自行实现（pi-web 的做法，MIT 可复用）。

### Docker 基础镜像（实测于 2026-09-06，见 `../scripts/probe-base-images.sh`）

- `node:22-alpine` 230MB / `node:22-slim` 325MB。alpine 补齐 bash + GNU coreutils 后 238MB，差距缩到 87MB。
- **两个镜像都不自带 python3**，也没有 pip3。
- `better-sqlite3` 在 alpine（musl）和 slim（glibc）都有预编译二进制，3 秒装完，**不需要 node-gyp 与编译工具链**。
- slim 的 `/bin/sh` 是 dash，不是 bash。写脚本要么显式 `#!/bin/bash`，要么只用 POSIX 语法。
- BusyBox 1.37 已支持 `sed -i.bak`（此前判断有误）。

### Anki（已决定不集成，见 ADR-0008）

- AnkiConnect 是社区插件，寄生在桌面进程内，要求 Anki 常驻；官方无 HTTP API，且明确拒绝此类贡献。
- `answerCards` 支持 ease 1–4 对应四档评级，走真实调度器，不需要 GUI 在复习界面。
- Anki 持有 collection 的独占锁，第三方进程无法并发读写。
- 卡片级 FSRS 记忆状态在 `cards.data` JSON 列中，AnkiConnect 未暴露。
- 官方 Python `anki` 包是能力最全的无 GUI 路径，但需要 Python sidecar。
- `ts-fsrs` 实现 FSRS-6，参数与 Anki 同源同序，日后需要互操作时可映射。
