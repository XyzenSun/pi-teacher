# Pi Teacher

基于 Pi Agent 的 Web 学习助手。项目重点不是重新实现 agent loop、tool calling 或流式传输，而是围绕学习业务构建可组合、可扩展的学习流程。

## 当前方向

- Agent 底座：`earendil-works/pi`（Pi Agent Harness）
- 技术栈方向：全栈 TypeScript
- 交互形态：Web UI，不做终端对话
- Agent Loop：由 Pi 执行，保留 Pi 的自动上下文压缩能力
- 会话历史：由 Pi 管理并在 Web UI 中完整可见
- 业务数据：使用应用数据库保存确定性数据，例如 workspace、卡片、FSRS 状态、复习记录、用户偏好和学习摘要
- 默认内容格式：Markdown
- 可选内容能力：Mermaid 结构图、AI 生图、HTML；首版优先 Markdown 与 AI 生图，HTML 后续再做

详细的已确认决策、约束和未决问题见 [`docs/architecture-decisions.md`](docs/architecture-decisions.md)。

当前对话摘要和下一次恢复用 prompt 见 [`docs/conversation-summary.md`](docs/conversation-summary.md) 与 [`docs/resume-prompt.md`](docs/resume-prompt.md)。
