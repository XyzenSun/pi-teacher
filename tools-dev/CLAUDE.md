# tools-dev — Pi Teacher 工具与插件开发

本目录是 pi-teacher 的**实现代码区**：Pi 插件（15 个自研业务工具 + ask_user 移植）、数据库层、FSRS 调度服务，以及后续的 Express 后端。设计文档全部在仓库上层（`../docs/`、`../数据库设计.md`），本目录只放代码与开发过程文档。

**当前状态**：起步阶段，实现代码尚未落地——目前只有任务流程文档，代码目录待按 `tasks/TODO.md` 推进创建。

**当前阶段范围（用户已定）**：先把插件注册与工具开发跑通。UI 前端不在本阶段，不做。

## 目录结构

当前实际结构：

```
tools-dev/
  CLAUDE.md              ← 本文件
  tasks/
    TODO.md              ← 待做任务清单（对齐需求后先写这里）
    当前任务.md           ← 当前任务的工作记忆（只放不易复现的问题与解法）
  doc/
    spec.md              ← 经验库：bug 与解决方案（三级标题索引，禁止整读）
```

规划中（随任务推进创建，见 `tasks/TODO.md`）：

```
  tasks/{任务简称}.md     ← PRD 文档，命名约定，按任务创建
  server/                ← 实现代码（Express 5 + 进程内 Pi SDK），搭骨架任务完成后存在
```

## 首要：对齐需求

开发新功能前，通过 skill 调用 `grill-doc` 与用户对齐需求，对齐后将简短描述写入 `./tasks/TODO.md`。

## 对齐需求后编写 PRD

按 `{任务简称}.md` 写 PRD 放 `./tasks/`。`./tasks/当前任务.md` 动态调整、聚焦当前任务并保持更新。

## 当前任务.md 的纪律（重要）

它存在的意义是对抗上下文压缩导致的工作记忆丢失，因此：

- **只放不易复现的记忆**：工作中遇到的问题、如何解决、工具调用错误怎么处理、端口抢占怎么处理等
- **不放可复现的内容**：工具调用结果、PRD 里已有的内容、从文档里随时能查到的东西
- **不与 PRD 重叠**

## 遇到问题怎么做

先问自己：这个问题在我们的需求下真的会被触发吗？如果会触发，先检索 `./doc/spec.md` 的**三级标题**（禁止读完整文件，内容很长），看是否有过往经验可参考。若无可参考经验：

1. 开发中发现与用户需求偏离，或需求在当前语境/开发环境下无法实现 → **暂停任务，询问用户**
2. 框架 API 用法未知、新版本变化、需要网络搜索 → 用 Agent 工具调用 `search-subagent`；仍无法解决 → **暂停任务，询问用户**

## 任务完成后

更新 `TODO.md`；根据当前记忆与 `./tasks/当前任务.md` 判断是否有值得记入 `./doc/spec.md` 的内容（bug 名称、原因、影响与触发条件、解法，保持简短）；然后 commit 并 push。

## 技术事实（本阶段已核实，勿重复探索）

以下是源码核实过的事实，直接引用即可：

- **Pi 版本**：本机 0.84.2（`/root/.nvm/versions/node/v24.19.0/lib/node_modules/@earendil-works/pi-coding-agent`），pi-web 用 0.84.3
- **工具注册走 extensionFactories 路线**（用户已定，否决 customTools 参数路线）：`createAgentSessionServices({ resourceLoaderOptions: { extensionFactories: [...] } })`，工厂内 `pi.registerTool(defineTool({...}))`
- **工具名前缀式定稿**：`card_*` / `topic_*` / `glossary_*` / `review_*` / `md_*` / `file_*` + `ask_user`。工具名不得含点号（Anthropic API 只允许 `^[a-zA-Z0-9_-]{1,128}$`），下划线安全
- **TypeBox 1.3.7**（新版拆分包）：`import { Type } from "typebox"`，`Type.Object/String/Optional` 可用；pi-teacher 需自加该依赖对齐 Pi 的版本
- **ask_user 底层**：`ExtensionUIContext` 的 `select/input/editor`；宿主通过 `bindExtensions({ uiContext, mode: "rpc" })` 注入。桥接层细节见 `../docs/pi-web-研究/01-桥接层.md`（pi-web 源码 checkout 在 `/tmp/pi-web`，重启即失，需要时重新 clone）
- **FSRS 参数已定**：`learning_steps: [], relearning_steps: []`（关多步学习，一张卡一天最多出现一次，最短间隔 24h）；`card_schedule`/`review_log` 不加 learning_steps 列，该字段恒 0
- **ts-fsrs 5.4.2**：`Card.learning_steps` 是 v5 新字段；`elapsed_days` 已标 deprecated（v6 移除）但保留无妨

## 设计文档索引（需要时按路径读，不整读）

| 什么时候读 | 要读什么 | 路径 |
| --- | --- | --- |
| 实现任何一个工具之前（签名、可见性矩阵、返回值形态的唯一权威） | 15+1 个工具完整定义 | `../docs/工具定义.md` |
| 写 db/schema.ts 前 | 10 张表 schema | `../数据库设计.md` |
| 写插件工厂 / 建会话代码前 | 进程模型（进程内 SDK） | `../docs/adr/0024-in-process-pi-sessions.md` |
| 搭 server/ 骨架前 | 技术栈决策 | `../docs/adr/0025-tech-stack-express-react-vite.md` |
| 处理学习对话调用复习工具的裁决时 | 可见性反模式说明 | `../docs/adr/0026-review-tools-allowed-in-learn-sessions.md` |
| 考虑引入 MCP 类外部能力前 | 不用 MCP 的决策 | `../docs/adr/0027-no-mcp-skill-and-extension-only.md` |
| 移植桥接层（本阶段之后的任务）时 | pi-web 移植清单 | `../docs/pi-web-研究/` |
