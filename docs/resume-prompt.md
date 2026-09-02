# 明日恢复对话 Prompt

请继续推进 `/workspace/pi-teacher` 的 Pi Teacher 设计讨论。请先阅读：

- `/workspace/pi-teacher/README.md`
- `/workspace/pi-teacher/docs/architecture-decisions.md`
- `/workspace/pi-teacher/docs/conversation-summary.md`

不要读取或依赖 `~/.claude/memory` 中的任何内容。

## 已确认的前提

- Agent 底座锁定 `earendil-works/pi`，不再研究 DeepSeek Harness。
- 全栈 TypeScript；Pi 负责 Agent Loop、tool calling、流式输出和自动上下文压缩。
- Web UI，不做终端对话；会话历史保持完整可见；支持自动标题和 Web UI 手动改标题。
- 一个 workspace 是持久化学习主题容器；一场完整多轮对话对应一个 Pi session；一个 workspace 有多个 session。
- `short-term` workspace 不制卡、不进入长期复习计划；`long-term` workspace 才触发制卡提醒并维护复习状态。
- 短期学习可以凝结为笔记、难题、结论，升级到新的或已有的长期 workspace，并自动提议卡片。
- 面试八股文、算法题等可以包装成卡片，AI 负责开放式回答的解读。
- 复习使用 FSRS/`ts-fsrs`，FSRS 计算日期，AI 评价回答；AI 可以提出特殊覆写但不能自由拍日期。
- 用户偏好手写为主，AI 可提议且须确认；偏好 Hook 暂定每 30 轮，和制卡提醒撞车时合并注入。
- 提醒只隐式注入给 AI；若无实际变更，不在回复中提及检查过程。
- Skill、MCP、Pi Extension 按职责选用，不把所有东西强行叫作插件。
- 默认 Markdown；HTML 后续可选且 Token 成本更高；Mermaid 与 AI 生图并存；首版优先 Markdown + 可选 AI 生图。
- Pi 管会话，应用数据库管确定性业务数据；SQLite 是单用户优先候选，但具体方案未定。

## 继续讨论时的规则

1. 继续使用中文，并称呼用户为“Xyzen”。
2. 一次只问一个问题，每个问题给出推荐答案。
3. 不要重新讨论已经锁定的 Pi、全栈 TypeScript、Web UI、workspace type、Markdown + 可选生图等决策。
4. 下一步优先处理尚未决定且影响架构的事项，例如：应用数据库与 Pi session backend 的职责边界、workspace/session metadata、卡片确认流、短期凝结 schema，或 Pi Web 嵌入的具体接口。
5. 不要直接开始实现，除非用户明确要求；先完成设计共识。
6. 所有确定性操作应落到代码和结构化 tool，不要依赖模型解析自然语言。
