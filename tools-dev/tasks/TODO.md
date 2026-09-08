# TODO

## 当前状态：后端宿主完成，前端 WebUI PRD 待用户审查

**backend-host-mvp 已完成**（2026-09-08 验收，commit 4006891 已推送）：Express + 桥接层 + 会话管理 + 投影/注入 + CRUD 路由 + scrypt 认证全部落地在仓库根 `server/`。验证面：smoke 74/74、run-real 真模型 7/7、http-smoke 真模型全链路 51/51、lifecycle 空闲回收 + SIGTERM 7/7、typecheck 零错误。tools-dev 冻结为历史脚手架，活跃代码在 `../server/`（见 CLAUDE.md 冻结注记）。

**下一任务：前端 WebUI**。需求已通过 `grill-doc` 收敛，完整 PRD 已写入 `tasks/frontend-webui-mvp.md`，当前等待用户审查，尚未开始实现。用户审查通过前不修改 `server/` 或创建 `web/` 代码。

本任务的已确认范围：

- 领域模型重建为 `space → pi_session`；删除 `session` 表和 `pi_session.session_id`；每条 Pi Session 独占 `work_path`；固定 `ta` / `review` Space，固定且唯一的 ta Pi Session；
- WebUI 使用 React + TypeScript + Vite + Tailwind + `react-router-dom`，状态管理只用 React hooks/context；视觉与布局以 Atelier Mind 模板为准；本阶段先跑通桌面版，移动端另立任务；
- 左侧展示 `Space → Pi Session` 两级树，助教仅从右侧固定入口复用；主区实现真实 SSE 对话；右侧实现全局 Card Proposal 与一次性上下文注入的固定助教；
- 管理面板首版包含 Card、Glossary、Topic、Agents Md、Teach Style 的真实 CRUD/编辑；不使用模板假数据伪装功能；
- 后端同步补齐破坏性 Schema 重建、独立工作目录、附件上传/下载/文件索引、模型查询/切换和 SPA 静态服务；
- 不实现 Pi Session 级应用文件沙箱；制卡、复习写入等角色差异由工具控制层强制，Docker 与既有远程沙箱 skill 负责部署/执行隔离；
- 原有 backend-host-mvp API 记录仅作历史参考，新实现必须以 PRD 和重建后的后端契约为准。

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
