# Pi Teacher

一个 Web 学习助手。它通过多种学习风格帮助用户理解知识、练习知识，并让值得长期保持的知识真正留下来。项目重点不是重新实现 agent loop、tool calling 或流式传输，而是围绕学习业务构建可组合的学习流程。

## 文档

- [`CONTEXT.md`](CONTEXT.md) — 领域语言。讨论和代码命名以此为准。
- [`数据库设计.md`](数据库设计.md) — 当前 Schema 的完整快照，实现以此为准。
- [`docs/学习区设计.md`](docs/学习区设计.md) — 学习工作区的目录结构与各文件职责。
- [`docs/工具定义.md`](docs/工具定义.md) — 模型可用的全部工具及代码层约束。
- [`docs/adr/`](docs/adr/) — 已确认的架构决策及其理由。
- [`docs/open-questions.md`](docs/open-questions.md) — 尚未拍板的事项。
- [`todo.md`](todo.md) — 待实现与待补设计的清单。

调研报告：

- [`docs/pi-hook机制调研.md`](docs/pi-hook机制调研.md) — Pi 的生命周期钩子，每轮注入走 `context` 事件。
- [`docs/pi-web-研究/`](docs/pi-web-研究/) — pi-web 项目的可复用性调研与文件索引。
- [`docs/文档不一致清单.md`](docs/文档不一致清单.md) — 旧文档与现行设计的冲突清单，逐条裁决中。

## 已确认的方向

| 决策 | 出处 |
| --- | --- |
| Agent 底座用 `earendil-works/pi`，全栈 TypeScript | [ADR-0001](docs/adr/0001-pi-as-agent-harness.md) |
| 调度由 FSRS 计算，模型只负责评价回答 | [ADR-0003](docs/adr/0003-fsrs-schedules-model-evaluates.md) |
| 会话存储与业务库物理分离，业务库用 SQLite | [ADR-0004](docs/adr/0004-split-session-and-business-storage.md) |
| 模型只能提议，卡片与偏好写入需用户确认 | [ADR-0005](docs/adr/0005-model-proposes-user-confirms.md) |
| 扩展能力按职责选择载体，不统一插件化 | [ADR-0006](docs/adr/0006-extension-carrier-by-responsibility.md) |
| 内容默认 Markdown，图表优先 DSL，生图只做记忆锚点 | [ADR-0007](docs/adr/0007-markdown-default-visuals-by-purpose.md) |
| 不引入 Anki，卡片仓库与调度自建 | [ADR-0008](docs/adr/0008-no-anki-integration.md) |
| 制卡判据交给模型，用提示词约束 | [ADR-0009](docs/adr/0009-cards-from-failure-points.md) |
| Session、Pi Session、Card 的职责边界 | [ADR-0010](docs/adr/0010-studyspace-card-session-boundaries.md) |
| Topic 粒度宜细，并承载调度参数 | [ADR-0011](docs/adr/0011-topic-granularity-and-scheduling-params.md) |
| 卡片提议静默产生，不打断学习 | [ADR-0012](docs/adr/0012-silent-card-proposals.md) |
| 制卡开关挂在对话上，用布尔而非三档 | [ADR-0013](docs/adr/0013-new-study-type-supersedes-0002.md) |
| 行为倾向由提示词表达，硬约束由代码强制 | [ADR-0014](docs/adr/0014-prompt-injection-vs-code-constraints.md) |
| 优先 Docker 部署，代码执行用远程沙箱 | [ADR-0015](docs/adr/0015-docker-first-remote-sandbox.md) |
| 资料抓取交给子代理，隔离上下文污染 | [ADR-0016](docs/adr/0016-subagent-for-material-fetching.md) |
| 卡片去重：精确匹配归代码，语义判断归模型 | [ADR-0017](docs/adr/0017-card-dedup-exact-in-code-semantic-in-model.md) |
| 复习是一场批量对话，不是逐卡问答 | [ADR-0018](docs/adr/0018-review-is-batched-conversation.md) |
| 模型直接输出四档 Rating，不经中间层归档 | [ADR-0019](docs/adr/0019-model-outputs-rating-directly.md) |
| 彻底掌握的术语沉淀进数据库，成为全局用户模型 | [ADR-0020](docs/adr/0020-mastered-terms-graduate-into-database.md) |
| 复习节奏交给模型与用户，代码不设限 | [ADR-0021](docs/adr/0021-review-pacing-left-to-model-and-user.md) |
| 单用户、密码登录、导出不备份、手机端只做前端适配 | [ADR-0022](docs/adr/0022-single-user-password-export-mobile-web.md) |
| 生图：不控预算、不重试、AI 主动提议 | [ADR-0023](docs/adr/0023-image-generation-no-budget-no-retry.md) |
| Pi 会话跑在宿主进程内，桥接层从 pi-web 移植 | [ADR-0024](docs/adr/0024-in-process-pi-sessions.md) |
| 技术栈：Express + React + Vite + Tailwind | [ADR-0025](docs/adr/0025-tech-stack-express-react-vite.md) |
| 学习对话可取卡判定，但提示词标记为反模式 | [ADR-0026](docs/adr/0026-review-tools-allowed-in-learn-sessions.md) |
| 不用 MCP：能力扩展只有 skill 和插件两个载体 | [ADR-0027](docs/adr/0027-no-mcp-skill-and-extension-only.md) |
| 不替换 Pi 的默认系统提示词，角色塑造走 AGENTS.md | [ADR-0028](docs/adr/0028-keep-default-system-prompt.md) |

Schema 相关的决策不再单独立 ADR，直接维护在 [`数据库设计.md`](数据库设计.md) 里——它变动频繁，ADR 那种「一次决策一份记录」的形式跟不上。

## 功能与界面布局

界面设计的需求说明：程序有什么功能、WebUI 需要哪些页面与区块。本节自包含，可直接作为界面设计的输入。

### 功能全景

三种会话，各有独立场景：

| 会话 | 场景 | 形态 |
| --- | --- | --- |
| 学习 | 在工作区里跟 AI 系统学习一个主题 | 长期工作区（一个目录）内开对话；AI 讲解、出练习、写精华文档、静默提议卡片、维护术语 |
| 复习 | 到期卡片的复习，**两条独立路径** | ①开复习对话：AI 取一批卡、组织对话出题、判定四档；②直接刷卡：不经 AI，翻卡自评 |
| 助教 | 带着当前学习上下文的随手提问 | 全局唯一的助教对话，只答疑不推进课程 |

支撑系统：

| 系统 | 说明 | 出处 |
| --- | --- | --- |
| 卡片 | 提议 → 用户确认 → FSRS 调度 → 复习 → 合并 → 软删除，全生命周期；AI 无物理增删权 | ADR-0005、0009、0017、0021 |
| 术语表 | 「彻底搞懂」的术语由 AI 提议、用户确认，沉淀为跨工作区的全局用户模型 | ADR-0020 |
| Topic | 卡片归类维度 + FSRS 参数配置粒度；参数优化完全手动触发 | ADR-0011 |
| 提示词库 | agents_md 模板（分 learn / review / ta 三类）与 teach_style 风格库，WebUI 增删改，开对话时选 | `数据库设计.md` |
| 提醒 | 卡片到期提醒、偏好提醒，以 hook 注入对话上下文，**不是界面通知** | ADR-0014 |

### 页面与布局区

**1. 工作台（首页）** —— 学习工作区列表（名称、到期卡片数、最近活动）、新建工作区入口、复习与助教的常驻入口。助教是高频随手功能，入口应在所有页面可达。

**2. 工作区页（学习）** —— 三块：对话列表（标题、所用模板与风格、制卡开关、会话打开状态、关闭/重开按钮）、开新对话表单（先选模板与风格、制卡开关）、文档区（essence 精华文档的渲染查看、GLOSSARY.md、MISSION.md）。`learning-records/` 只给 AI 看，无界面入口。

**3. 对话窗口（三种会话共用骨架）** —— 消息流（Markdown、Mermaid 图表、代码高亮、图片）、工具调用展示区（可折叠）、输入框。整体形态可参考 pi-web（`pi-web-研究/03e`）。各类型的差异：

- 学习对话：制卡与术语提议走工具调用展示，**静默产生不打断对话**（ADR-0012）——不弹窗、不插消息，用户事后在待审批列表处理
- 复习对话：额外显示本批卡片进度（取了 N 张、已判定 M 张）与卡片正反面视图
- 助教对话：一条说明「本对话带着哪个工作区的上下文」的提示

消息操作按钮（底层能力见 `pi-会话生命周期调研.md` Q5）：

- **没有「删除单条消息」**——会话文件 append-only，条目不可改删。不要设计这个按钮
- AI 消息下可做「重新生成」（回退到上一条用户消息后重发）；用户消息下可做「编辑重发」；任意消息可做「回退到这里」
- **首版不做「另开分支」（fork）按钮**——回退统一走 navigateTree，同一对话内完成，不产生新对话行
- **回退只影响对话，不回滚副作用**——AI 已写盘的文件、已提议的卡片全在，界面文案要说清
- **会话历史是树不是线**——默认按当前路径渲染，被回退的分支收进分支切换器

**4. 卡片管理** —— 待审批列表（批量确认与零星确认共用同一套交互；每张展示 front / back / 制卡理由）、卡片库（按 Topic 过滤、搜索、编辑、软删除）、回收站（恢复、物理删除）、卡片详情（含调度状态：下次复习时间、复习次数、失误次数；FSRS 内部参数对用户是噪音，收进高级折叠或不显示；可跳回出处 essence 文档）。

**5. 复习中心** —— 到期队列概览（按 Topic 分组的到期数）、两个入口：开复习对话（选 Topic 过滤、模板、风格）、直接刷卡（翻卡：正面 → 背面 → 自评 Again / Hard / Good / Easy 四档）。

**6. 术语表** —— 待确认列表（AI 提议的术语，确认或删）、已掌握列表、手动添加。

**7. 提示词库** —— agents_md 模板按 type 分组的列表与编辑器（learn / review 可自由增删改；ta 只有一行固定）、teach_style 风格库同样管理。编辑器就是大文本框 + 名称 + 简介。

**8. Topic 管理** —— 列表（名称、描述、卡片数、到期数）、FSRS 参数编辑（期望保留率、最大间隔）、「优化 FSRS 参数」手动触发按钮与结果展示。

**9. 设置** —— 登录页、提醒 hook 配置（进阶用户直接编辑 JSON 字段）、导出（打包下载，界面需带「数据库文件需停止容器后单独复制」的固定说明文案）。

### 设计约束

- 单用户，无任何多用户界面元素（ADR-0022）
- **第一版就按响应式写**，为日后手机端做准备——不是等到「做手机端」再改造（ADR-0022）
- 提醒走对话内注入，不设计通知中心
- 复习界面（对话式 + 直接刷卡两形态）是设计重点，参考图将由用户提供
- 全局导航覆盖：工作台、复习中心、卡片、术语、提示词库、Topic、设置

## 当前状态

设计阶段，尚未开始实现。
