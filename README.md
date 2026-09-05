# Pi Teacher

一个 Web 学习助手。它通过多种学习风格帮助用户理解知识、练习知识，并让值得长期保持的知识真正留下来。项目重点不是重新实现 agent loop、tool calling 或流式传输，而是围绕学习业务构建可组合的学习流程。

## 文档

- [`CONTEXT.md`](CONTEXT.md) — 领域语言。讨论和代码命名以此为准。
- [`docs/adr/`](docs/adr/) — 已确认的架构决策及其理由。
- [`docs/open-questions.md`](docs/open-questions.md) — 尚未拍板的事项。

## 已确认的方向

| 决策 | 出处 |
| --- | --- |
| Agent 底座用 `earendil-works/pi`，全栈 TypeScript | [ADR-0001](docs/adr/0001-pi-as-agent-harness.md) |
| ~~学习期限挂在学习空间上~~（已被 0013 取代） | [ADR-0002](docs/adr/0002-learning-horizon-on-workspace.md) |
| 调度由 FSRS 计算，模型只负责评价回答 | [ADR-0003](docs/adr/0003-fsrs-schedules-model-evaluates.md) |
| 会话存储与业务库物理分离，业务库用 SQLite | [ADR-0004](docs/adr/0004-split-session-and-business-storage.md) |
| 模型只能提议，卡片与偏好写入需用户确认 | [ADR-0005](docs/adr/0005-model-proposes-user-confirms.md) |
| 扩展能力按职责选择载体，不统一插件化 | [ADR-0006](docs/adr/0006-extension-carrier-by-responsibility.md) |
| 内容默认 Markdown，图表优先 DSL，生图只做记忆锚点 | [ADR-0007](docs/adr/0007-markdown-default-visuals-by-purpose.md) |
| 不引入 Anki，卡片仓库与调度自建 | [ADR-0008](docs/adr/0008-no-anki-integration.md) |
| 卡片只从真实失败点产生，另开手动入口 | [ADR-0009](docs/adr/0009-cards-from-failure-points.md) |
| StudySpace、Card、Session 的职责边界 | [ADR-0010](docs/adr/0010-studyspace-card-session-boundaries.md) |
| Topic 粒度宜细，并承载调度参数 | [ADR-0011](docs/adr/0011-topic-granularity-and-scheduling-params.md) |
| 卡片提议静默产生，不打断学习 | [ADR-0012](docs/adr/0012-silent-card-proposals.md) |
| 制卡倾向挂在学习空间上 | [ADR-0013](docs/adr/0013-new-study-type-supersedes-0002.md) | 被 ADR-0016 取代 |
| 模式差异由提示词注入表达，硬约束由代码强制 | [ADR-0014](docs/adr/0014-prompt-injection-vs-code-constraints.md) |
| 优先 Docker 部署，代码执行用远程沙箱 | [ADR-0015](docs/adr/0015-docker-first-remote-sandbox.md) |
| Space 是三个固定值，Session 持有制卡开关、主题过滤与教学风格；「学习空间」变为按 work_path 分组的前端视图 | [ADR-0016](docs/adr/0016-space-session-schema.md) |
| 卡片单表多形态，answer_mode 判别；调度状态分离；review_log 记录完整状态转换 | [ADR-0017](docs/adr/0017-card-topic-schema.md) |

## 当前状态

设计阶段，尚未开始实现。
