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

## 合并卡（已定方案，待实现）

判据交给提示词，**合并动作交给工具**——AI 不碰 FSRS 状态计算。

- 提示词约束的触发时机大致是：用户对几张相关卡片的回答明显轻松、理解深刻到位时，提议合并
- 合并工具负责：新卡入库、旧卡置 `deleted`、新卡的 `card_schedule` 初始状态如何从旧卡推导
- 待定：合并后的 FSRS 状态怎么算。取最保守的一张（`stability` 最低）、还是重新按 `Good` 走一次调度？前者稳妥，后者简单
- 做进制卡 skill 里，skill 调 CLI 工具

## 学习计划（已定，无需开发）

由 `MISSION.md` 承担，**不做「每天学什么」的拆分**——大多数人并不会遵守这种计划，做了反而是负担。

## 资料获取的外部服务（已定方向）

由 skill 接第三方服务实现，不进核心代码。

- 视频下载：yt-dlp
- 网页抓取：用户已有的工具，待接入时提供
- 转录与清洗服务：skill 内部决定，核心只约定子代理返回一行摘要（见 ADR-0016）

## 复习 rubric 细化（待写）

四档由模型直接输出，无中间映射层（见 ADR-0019）。基线已写在该 ADR 里，但每档的边界还需要在真实复习中打磨，特别是 `Hard` 与 `Good` 的分界——「明显吃力」是个模糊词。等有了 `review_log` 数据再回头收紧。

## 待提供内容

- `agents_md` 四套预置模板正文：新学、新学不制卡、复习、助教
- `teach_style` 预置风格正文

## 文档待同步

正在派子代理审查全部旧文档，不一致清单将输出到 `docs/文档不一致清单.md`，由人工逐条决策后再改。

已确认的处理方向：

- **Sticking Point（难题）术语废弃**：卡片 + `reason_and_remark` 已完全替代它。CONTEXT.md 第 57 行的术语定义删除，其他文件里的「难题清单」表述一并清理。
- 难题清单数据结构：不建表，术语废弃（已从 open-questions 移入「已在别处解决的」）。

其余待清单出来后决策。

## pi-web 代码移植（调研已完成）

调研报告在 `docs/pi-web-研究/`。移植清单：

- 可原样抄：`agent-event-stream.ts`、`agent-event-wire.ts`、`agent-event-connection.ts`、`agent-client.ts`、`session-title.ts`、`markdown.ts`、`path-security.ts`、`request-security.ts`、`web-auth.ts` 等
- 需裁剪：`rpc-manager.ts`（砍 subagent/worktree/plugin 后约 800 行）、`useAgentSession.ts`（2056 行按自己 UI 裁）
- 必须重写：`session-reader.ts`（我们的 jsonl 在自定义目录）
- 前置：本机 Pi 从 0.84.2 升到 0.84.3 对齐版本，验证 `preflightResult` 契约与 `agent_settled` 事件是否存在
