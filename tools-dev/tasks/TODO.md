# TODO

## 当前状态：后端宿主完成，下一任务为前端 WebUI（待对齐）

**backend-host-mvp 已完成**（2026-09-08 验收，commit 4006891 已推送）：Express + 桥接层 + 会话管理 + 投影/注入 + CRUD 路由 + scrypt 认证全部落地在仓库根 `server/`。验证面：smoke 74/74、run-real 真模型 7/7、http-smoke 真模型全链路 51/51、lifecycle 空闲回收 + SIGTERM 7/7、typecheck 零错误。tools-dev 冻结为历史脚手架，活跃代码在 `../server/`（见 CLAUDE.md 冻结注记）。

**下一任务：前端 WebUI**（已开任务，**需求尚未对齐**）。按流程先调 `grill-doc` 与用户对齐，对齐后写 PRD 到 `tasks/frontend-webui-mvp.md` 并更新本文件。前端可直接依赖的后端事实（http-smoke 已全量验证）：

- 认证：`GET /api/auth/status`（needs-setup 决定进设密码页/登录页）、`POST /api/auth/setup`、`POST /api/auth/login`、`POST /api/auth/logout`、`GET /api/auth/me`；cookie `pi_teacher_session`（HttpOnly + SameSite=Lax，7 天）
- 提示词库：`GET/POST /api/prompts`、`PATCH/DELETE /api/prompts/agents-md/:id`、`POST /api/prompts/teach-style`（agents_md.type ∈ {ta, learn, review}，与会话类型匹配，被 pi_session 引用拒删 409）
- 工作区：`GET/POST /api/workspaces`（列表含 dueCards 数）
- 对话：`GET/POST /api/conversations`、`GET /api/conversations/:key/context`（:key = encodeURIComponent(jsonl 路径)，jsonl 路径即对话 id）、`POST .../command`（prompt/abort/get_state/get_tools 等 15 命令）、`GET .../events`（SSE：connected/message_start/message_update/prompt_done/agent_settled，注释帧 + 30s 心跳）、`POST .../close`
- 卡片/术语/主题：`GET /api/cards?status=`、`POST /api/cards/:id/confirm|reject|delete|restore`、`PATCH /api/cards/:id`、`POST /api/cards/merge`、`GET /api/glossary`、`POST /api/glossary/:id/confirm|reject`、`GET/PATCH /api/topics/:id`（requestRetention ∈ [0.5,0.99]，maximumInterval ≥ 1 整数）
- 会话失效约定：会话被空闲回收后 command/events 返回 404，前端引导重新打开对话（不自动重开）

## 已完成任务

**插件注册与工具开发跑通**（2026-09-07 验收）：PRD 见 `plugin-tools-mvp.md`。冒烟 75/75、run-real 真模型 4/4（agnes-2.5-flash）、注册断言 16/16。已随 730db5b 提交。

- [x] 搭 server/ 工程骨架（依赖版本见 PRD「工程骨架」节）
- [x] db/schema.ts + connection.ts（冒烟 3 断言过）
- [x] fsrs/service.ts（关 steps 语义已验证：due ≥ 24h）
- [x] tools/ 按组实现（16 工具：15 自研 + ask_user 移植官方 question.ts）
- [x] 插件工厂 factory.ts（可见性执行层拒绝，冒烟验证助教硬拒/开关拒绝）
- [x] run-real.ts：真模型验证通过（deepseek 真实调用 topic_list→topic_create→card_propose 落库）
- [x] 验收清单逐项过：冒烟 25/25 + run-real 4/4 + 注册断言 16/16
- [x] 全工具冒烟（用户要求「把所有工具都测一遍」）：smoke.ts 重写为 16 工具全覆盖，75/75——补齐 card_get / card_delete / card_merge / topic_list / glossary_get / ask_user 直调，含 merge 调度继承、软删回收站、取卡截断、重名标题、路径越界等边界

**后端宿主 backend-host-mvp**（2026-09-08 验收）：PRD 见 `backend-host-mvp.md`。代码全部落本仓库根 `server/`（tools-dev 内 server/ 目录仅存 PRD 参考，未就地构建）。

- [x] 工程骨架：server/ 包 scaffolding + 版本定稿（express 5、pi-agent-core 提升直接依赖 0.84.2）
- [x] 桥接层：rpc-manager 2067 行裁剪重写（约 600 行）+ 4 文件直拷 + normalize.ts
- [x] 会话管理：directory-scan / session-reader / title-generator 移植
- [x] 投影/注入：agents_md / teach_style / context 哨兵 / env-sync 启动钩子
- [x] 认证：user 表 scrypt + setup/login/logout + 签名 cookie
- [x] CRUD 路由：workspaces / conversations(+SSE) / cards / glossary / topics / prompts
- [x] http-smoke 全链路 51/51（真模型）
- [x] 空闲回收 + SIGTERM 优雅退出（lifecycle 7/7）
- [x] ADR-0022 修订 + 工具定义.md 删 ask_user + tools-dev 冻结注记

## 已完成的探索结论（勿重复调研）

- 工具注册路线定 extensionFactories（用户拍板），customTools 路线否决
- 工具名前缀式定稿：card_* / topic_* / glossary_* / review_* / md_* / file_*（ask_user 已随 backend-host-mvp 移除）
- FSRS 关多步学习（learning_steps: []），表零加列
- 详细技术事实见 `../CLAUDE.md`「技术事实」节

## 待做（下一阶段候选，未排期）

- 沙箱插件、生图 skill
