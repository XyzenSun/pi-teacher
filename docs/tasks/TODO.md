# TODO

## 当前状态：第三阶段 global-layout-prompt-layering 已立项，待实现

**global-layout-prompt-layering（2026-09-09 立项）**：PRD 见 `global-layout-prompt-layering.md`。基线 commit `d10ea07`。补建 `数据库与目录结构设计.md` 定义但从未创建的 `~/pi-teacher/` 全局文件（`AGENTS.md`、`USER.md`、`materials/`、`assets/`、`llm-text-to-img/`）；全局 `USER.md` + 会话 `style.md` 经 `appendSystemPrompt` 固定段落注入，段落里引导模型自行维护会话级 `pi-session-user.md`；设置面板新增「用户偏好」Tab。

**仓库整理（2026-09-09，本轮）**：删除冻结脚手架 `tools-dev/server/`、过时 `README.md`、空文件 `docs/助教设计.md`、残稿 `提示词设计/提示词追加位置.md`；`tools-dev/tasks/` → `docs/tasks/`，`tools-dev/doc/spec.md` → `docs/spec.md`；根 `todo.md` 合并入本文件；新增根 `CLAUDE.md`；全部文档（`CONTEXT.md`、`数据库与目录结构设计.md`、`提示词设计/`、`前端模板/`、`THIRD-PARTY-NOTICES.md`）收进 `docs/`，根目录只留 `CLAUDE.md`。

**下一轮待做**：8 组同一决策在多份文档重复书写（Teach Style 可切换、space→pi_session、glossary 不注入、materials 自读自写、镜像无 Python、四档 Rating、复习节奏、角色声明位置），各只保留 ADR 权威版本，其余改为一句引用。

## 待设计 / 待实现（从根 todo.md 合并，仍有效）

- **FSRS 参数优化**（已定方案）：完全手动触发；后端接口 + 前端按钮；输入 `review_log` 该 Topic 全部序列，输出写回 `topic`；`topic` 需新增 `w` 数组字段（ts-fsrs 权重），目前只有 `request_retention` 与 `maximum_interval`
- **合并卡**（已定方案，`POST /api/cards/merge` 后端已有）：判据归提示词、动作归工具；FSRS 状态复制 `stability` 最低那张旧卡；前端尚无入口
- **复习 rubric 细化**：四档边界（尤其 Hard/Good 分界）等有 `review_log` 数据后回头收紧（ADR-0019）
- **资料获取 skill**：yt-dlp 下载、网页抓取、转录清洗；子代理只返回一行摘要（ADR-0016）
- **Go 工具仓库**：等出现第一个「Shell 太弱、Node 不合适」的场景再建（ADR-0015）
- **数据库索引**：等有实际慢查询再加；已知高频查询：`card_schedule.due` 到期、`card.topic_id` 过滤、`topic.name` 唯一、`review_log.card_id` 聚合
- 移动端布局；`compact` / 思考等级的 UI 入口；Pi Session 重命名后左树即时刷新的细粒度事件

## 上一阶段：第二阶段 frontend-polish-config（2026-09-09 完成，commit `3f3c3a0`）

PRD 见 `frontend-polish-config.md`。8 项验收反馈全部落地，ADR-0031 / ADR-0032 已写。验证面：`http-smoke` 230/0、`smoke` 88/0、`verify` 22/0、`verify:schema` 71/0、`verify:attachments` 116/0、`verify:config` 48/0、`verify:lifecycle` 15/0；真浏览器验收通过。

- [x] 复习新建面板补制卡开关（修复前端写死 `false`）
- [x] 重命名 / 删除改为页面内 `InlineEdit` / `ConfirmDialog`
- [x] 左下角四个快捷卡片：系统设置、学习日历、知识卡库、帮助指南
- [x] 按 `前端模板` 对齐布局、间距、色彩与组件层级
- [x] 第三栏 38% / 62%，卡片审批单卡左右切换
- [x] 模型、制卡开关、教学风格移入输入区控制条，全部真实生效
- [x] 系统设置改为 `/app` 之上的路由覆盖层 modal
- [x] 账号改名改密、模型与 Provider 配置、脱敏 JSON 编辑（原子写、secret 边界）
- [x] 复习排期聚合 API 与学习日历
- [x] ADR-0031 / ADR-0032 + `CONTEXT.md`、`数据库与目录结构设计.md`、`docs/open-questions.md` 同步

## 更早阶段：前端 WebUI 桌面版 MVP（2026-09-09 完成，commit `023858e`）

PRD 见 `frontend-webui-mvp.md`。后端按 ADR-0030 破坏性重建（`space → pi_session`，删除 `session` 表与 `session_id`，每条 Pi Session 独占 `work_path`，固定 ta/review Space 与唯一 ta Pi Session）；新增 `web/`（React 19 + TS + Vite 7 + Tailwind v4 + react-router-dom 7，hooks/context，Atelier Mind 令牌）。真浏览器走通：setup→登录→建 Space→学习对话真模型流式回复（KaTeX/Mermaid/工具折叠/提议卡片）→确认卡片→助教一次性注入→复习对话真实 FSRS 评分→模型切换→回收/重开→图片附件→`@` 文件补全与 `/` 命令。

## 已完成任务

**前端 WebUI 桌面版 frontend-webui-mvp**（2026-09-09 实现，待用户验收）：

- [x] 后端 Schema 重建：`db/schema.ts` + `db/seed.ts` + `session/repository.ts`（CHECK/部分唯一索引/触发器三层保护固定 Space；IMMEDIATE 事务预占 id 再建目录；幂等初始化）
- [x] 路由重写：workspaces / conversations（稳定 ID 寻址、一次性助教注入、steer/follow_up、set_model）/ cards / glossary / topics / prompts；统一 `HttpError` + `apiErrorHandler`
- [x] 新增 `GET /api/models`（无凭据）、附件 `POST/GET /attachments`、`GET /attachments/:name`、`GET /file-index`
- [x] 出口投影 `projection/client-view.ts`：HTTP 与 SSE 共用，前端永不见绝对路径
- [x] Express 托管 `web/dist` + SPA fallback；API 404 保持 JSON
- [x] web/：认证页、三栏布局、Space/Pi 树、统一新建面板、SSE reducer、Markdown+KaTeX+Mermaid、消息/工具折叠、输入框（IME/@/斜杠/附件/草稿/steer）、右侧提议池与固定助教、/settings 五 tab
- [x] 验证脚本全部适配新 Schema，新增 `verify:schema`、`verify:attachments`

**插件注册与工具开发跑通**（2026-09-07 验收）：PRD 见 `plugin-tools-mvp.md`。冒烟 75/75、run-real 真模型 4/4（agnes-2.5-flash）、注册断言 16/16。已随 730db5b 提交。

- [x] 搭 server/ 工程骨架（依赖版本见 PRD「工程骨架」节）
- [x] db/schema.ts + connection.ts（冒烟 3 断言过）
- [x] fsrs/service.ts（关 steps 语义已验证：due ≥ 24h）
- [x] tools/ 按组实现（16 工具：15 自研 + ask_user 移植官方 question.ts）
- [x] 插件工厂 factory.ts（可见性执行层拒绝，冒烟验证助教硬拒/开关拒绝）
- [x] run-real.ts：真模型验证通过（deepseek 真实调用 topic_list→topic_create→card_propose 落库）
- [x] 验收清单逐项过：冒烟 25/25 + run-real 4/4 + 注册断言 16/16
- [x] 全工具冒烟（用户要求「把所有工具都测一遍」）：smoke.ts 重写为 16 工具全覆盖，75/75——补齐 card_get / card_delete / card_merge / topic_list / glossary_get / ask_user 直调，含 merge 调度继承、软删回收站、取卡截断、重名标题、路径越界等边界

**后端宿主 backend-host-mvp**（2026-09-08 验收）：PRD 见 `backend-host-mvp.md`。代码全部落本仓库根 `server/`（原 tools-dev/server 脚手架已于仓库整理时删除）。

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
- 详细技术事实见 根 `CLAUDE.md`「技术事实」节

## 待做（下一阶段候选，未排期）

- 沙箱插件、生图 skill
