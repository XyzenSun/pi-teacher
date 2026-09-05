# TODO

## 索引设计（待设计）

数据库索引尚未设计，等实现阶段按真实查询模式定。已知的高频查询：

- 按 `card_schedule.due` 取到期卡片 —— 复习模式的核心查询，每次进入复习都跑
- 按 `card.topic_id` 过滤 —— 复习对话指定了 `review_topic_id` 时用
- 按 `pi_session.session_id` 列出工作区下的所有对话 —— 前端会话列表
- 按 `topic.name` 唯一查找 —— 制卡时 AI 复用已有 Topic
- 按 `review_log.card_id` 聚合 —— FSRS 参数优化时取复习序列

暂不预先建索引：SQLite 单用户、数据量小，等有实际慢查询再加，避免过早优化。

## FSRS 参数优化（已定方案，待实现）

**完全手动触发**，不做自动。

- 后端提供接口，前端按钮调用
- 输入：`review_log` 里该 Topic 的全部复习序列
- 输出：优化后的 FSRS 参数，写回 `topic` 表
- `review_log` 字段已对齐 `ts-fsrs` 的 `ReviewLog` 结构，可直接喂给 `fsrs-optimizer`，不做格式转换
- 待定：参数写回 `topic` 需要新增字段（`ts-fsrs` 的 `w` 数组），目前 `topic` 只有 `request_retention` 和 `maximum_interval`

## 待提供内容

- `agents_md` 四套预置模板正文：新学、新学不制卡、复习、助教
- `teach_style` 预置风格正文

## 文档待同步

正在派子代理审查全部旧文档，不一致清单将输出到 `docs/文档不一致清单.md`，由人工逐条决策后再改。

已确认的处理方向：

- **Sticking Point（难题）术语废弃**：卡片 + `reason_and_remark` 已完全替代它。CONTEXT.md 第 57 行的术语定义删除，其他文件里的「难题清单」表述一并清理。
- `docs/open-questions.md` 第 16 项（难题清单数据结构）标为已决：不建表，术语废弃。

其余待清单出来后决策。

## pi-web 代码移植（调研已完成）

调研报告在 `docs/pi-web-研究/`。移植清单：

- 可原样抄：`agent-event-stream.ts`、`agent-event-wire.ts`、`agent-event-connection.ts`、`agent-client.ts`、`session-title.ts`、`markdown.ts`、`path-security.ts`、`request-security.ts`、`web-auth.ts` 等
- 需裁剪：`rpc-manager.ts`（砍 subagent/worktree/plugin 后约 800 行）、`useAgentSession.ts`（2056 行按自己 UI 裁）
- 必须重写：`session-reader.ts`（我们的 jsonl 在自定义目录）
- 前置：本机 Pi 从 0.84.2 升到 0.84.3 对齐版本，验证 `preflightResult` 契约与 `agent_settled` 事件是否存在
