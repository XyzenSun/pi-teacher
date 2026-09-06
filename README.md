# Pi Teacher

一个 Web 学习助手。它通过多种学习风格帮助用户理解知识、练习知识，并让值得长期保持的知识真正留下来。项目重点不是重新实现 agent loop、tool calling 或流式传输，而是围绕学习业务构建可组合的学习流程。

## 文档

- [`CONTEXT.md`](CONTEXT.md) — 领域语言。讨论和代码命名以此为准。
- [`数据库设计.md`](数据库设计.md) — 当前 Schema 的完整快照，实现以此为准。
- [`docs/学习区设计.md`](docs/学习区设计.md) — 学习工作区的目录结构与各文件职责。
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

Schema 相关的决策不再单独立 ADR，直接维护在 [`数据库设计.md`](数据库设计.md) 里——它变动频繁，ADR 那种「一次决策一份记录」的形式跟不上。

## 当前状态

设计阶段，尚未开始实现。
