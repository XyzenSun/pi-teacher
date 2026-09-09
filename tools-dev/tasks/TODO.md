# TODO

## 当前状态：第二阶段 frontend-polish-config 已立项，待实现

**frontend-polish-config（2026-09-09 立项）**：PRD 见 `tasks/frontend-polish-config.md`。基线 commit `023858e`。在已跑通的 MVP 架构上做三件事：修一个真实规格缺陷（复习 Pi Session 制卡开关被前端写死为 false）、补齐视觉与交互债务（模板结构对齐、页面内交互替代原生弹窗、第三栏 1/3+2/3 与单卡审批、输入区控制条）、新增真实配置能力（账号密码、模型与 provider、受控 JSON、日历聚合）。不重写桥接层与会话架构，不做移动端。

需要新增 ADR：ADR-0031（Teach Style 可运行期切换，修订 `CONTEXT.md` 中「之后不变」）、ADR-0032（WebUI 编辑 Pi 模型配置的 secret 边界）。

## 上一阶段：前端 WebUI 桌面版 MVP 已实现，等待用户验收

**frontend-webui-mvp 已实现**（2026-09-09，未提交、未推送）：PRD 见 `tasks/frontend-webui-mvp.md`。后端按 ADR-0030 破坏性重建（`space → pi_session`，删除 `session` 表与 `session_id`，每条 Pi Session 独占 `work_path`，固定 ta/review Space 与唯一 ta Pi Session）；新增 `web/`（React 19 + TS + Vite 7 + Tailwind v4 + react-router-dom 7，hooks/context，Atelier Mind 令牌）。

验证面（真模型 agnes/agnes-2.5-flash，全部在临时 home，零残留）：`smoke` 84/84、`verify:schema` 66/66、`verify:attachments` 116/116、`verify` 22/22、`http-smoke` 159/159（含 SPA fallback）、`verify:lifecycle` 15/15；`server`/`web` typecheck 零错误；`web` 生产构建成功。另用 agent-browser 真浏览器走通：setup→登录→建学习 Space→创建学习对话→真模型流式回复（KaTeX/Mermaid/工具折叠/提议卡片）→右侧确认卡片→固定助教一次性注入→Topic 快捷入口建复习对话→真实 FSRS 评分→模型切换→回收/重开→图片附件上传并发送→`@` 文件补全与 `/` 命令菜单→/settings 五个 tab 真实 CRUD。

**第二阶段用户验收反馈（2026-09-09，已纳入 `frontend-polish-config` PRD）**：

- [ ] 复习新建面板补「是否允许老师提议制卡」开关（修复：前端当前错误写死 `false`）
- [ ] 将对话与 Space 重命名从原生 `prompt()` 改为页面内嵌编辑，删除改页面内确认
- [ ] 左下角补回模板四个快捷卡片：系统设置、学习日历、知识卡库、帮助指南
- [ ] 保持当前技术栈，但严格按 `前端模板` 对齐布局、间距、色彩与组件风格
- [ ] 第三栏改为卡片审批 1/3、助教 2/3；审批卡片改左右切换交互
- [ ] 将模型选择、真实制卡开关、真实教学风格切换移入消息输入区域
- [ ] 系统设置改为保留当前工作区上下文的小于全屏 route-backed modal
- [ ] 设置中补齐账号密码修改、模型与 provider 配置、受控 JSON 配置修改（真实读取、校验、原子保存、secret 保护）
- [ ] 新增真实复习排期聚合 API 与学习日历空状态/排期视图
- [ ] 新增 ADR-0031 / ADR-0032，并同步 `CONTEXT.md`、`数据库设计.md`、`docs/open-questions.md`

**下一步候选（未排期）**：移动端布局；`compact`/思考等级等会话命令的 UI 入口；卡片合并（`POST /api/cards/merge` 已有接口）；Pi Session 重命名后左树即时刷新的更细粒度事件。

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
