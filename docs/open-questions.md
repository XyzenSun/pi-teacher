# 未决问题

已确认的决策见 [`adr/`](./adr/)，Schema 见 [`数据库与目录结构设计.md`](./数据库与目录结构设计.md)，领域语言见 [`CONTEXT.md`](./CONTEXT.md)。

## 当前第二阶段 UI / 配置打磨未决

暂无用户层面的未决问题。已确认：

- 系统设置是 `/app` 工作台之上的路由覆盖层 modal；URL、刷新与浏览器前进/后退仍表达完整状态，背景工作区继续可见。
- 学习日历只展示 `card_schedule` / `review_log` 可确定性复算的 UTC 聚合；不展示连续打卡、平均留存率、预计用时等没有真实数据支撑的指标。
- 模型与 Provider 配置以结构化表单为主；高级 JSON 只编辑脱敏后的单个 provider 且经过同一白名单。绝不把 `~/.pi/agent/models.json` 原样返回浏览器（ADR-0032）。
- Teach Style 可在对话进行中切换，Agents Md 仍在创建后固定（ADR-0031）。

## 当前前端 WebUI 未决

以下问题属于前端 WebUI MVP，布局与视觉风格以 `/workspace/pi-teacher/前端模板` 为准；模板没有后端能力的按钮不做假功能。

暂无用户层面的未决问题。已确认：一体化管理面板的 Card 编辑、回收站、Topic FSRS 参数编辑全部进入首版；附件保存到当前 Pi Session 的 `work_path/attachments/`；不增加 Pi Session 级应用文件权限限制，Docker 与远程沙箱 skill 负责部署/执行隔离。

## 当前数据模型重构的实现未决

暂无用户层面的未决问题。已确认：初始化时创建固定助教 Pi Session；`space.type` 与 `agents_md.type` 必须匹配；`review_topic_id` 仅允许出现在 `review` Space 的 Pi Session；初始助教模板见 `提示词设计/提示词模板/agentsmd/助教.md`。

## 真正未决的底层问题

4. ~~**`context` 事件返回值的容器格式。**~~ 已决：用自有标记 `<pi-teacher-context>` 包裹，作为 `customType: "pi-teacher-context"` 的 custom 消息注入，不落 JSONL（`server/src/tools/factory.ts`）。不复用 `<system-reminder>`，避免与 Pi 自身注入撞车。

5. **FSRS optimizer 空输入行为。** `fsrs-optimizer` 空输入是返回默认权重还是抛异常，需在实现时验证；若抛异常，接口层捕获并提示“记录不足，参数未改变”。

6. **Pi 0.84.2 与 pi-web 0.84.3 的 API 漂移。** 移植前端依赖的 bridge 类型/事件消费时逐项核对；最关键是 `preflightResult` 与 `agent_settled`。

## 已确认的决策

### 领域与数据

| 问题 | 结论 | 出处 |
| --- | --- | --- |
| 容器模型 | `space` 是唯一收纳容器；删除 `session` 表；`pi_session.space_id` 是唯一父级；每个 Pi Session 自有 `work_path` | ADR-0030 |
| 复习容器 | `space.id = 1`、`type = 'review'` 的全局固定复习 Space；允许多个复习 Pi Session；复习 Space 左侧展示 Topic 快捷入口与历史对话 | ADR-0030、本次对齐 |
| 助教容器 | `space.id = 0`、`type = 'ta'` 的全局固定助教 Space；schema 初始化时直接创建唯一固定 Pi Session 与目录；不可创建 | ADR-0030、本次对齐 |
| 固定 Space 可编辑性 | `ta` / `review` 的名称、类型和身份不可修改、不可删除；学习 Space 可重命名和删除；Pi Session 不跨 Space 移动 | 本次对齐 |
| 旧数据 | 项目未上线，破坏性重建数据库，不提供旧数据迁移；同步重做验证脚本 | 本次对齐 |
| 卡片与复习的关系 | Card 全局归属 Topic，不归属 Space 或 Pi Session；复习是批量对话 | ADR-0010、ADR-0018 |
| Pi Session 提示词归属 | Agents Md、Teach Style、制卡开关属于 Pi Session，不属于 Space | ADR-0010、ADR-0013 |
| 文件访问边界 | 不做 Pi Session 级应用权限限制；Docker 是部署隔离边界，远程沙箱由独立 skill 负责；角色业务权限由工具控制层强制 | 本次对齐 |
| 后端/业务存储 | Pi 对话 JSONL 与业务 SQLite 物理分离 | ADR-0004 |

### 前端与产品方向

| 问题 | 结论 | 出处 |
| --- | --- | --- |
| MVP 功能面 | 认证、Space/Pi Session、主对话、固定助教、Card 审批与卡库、Glossary、Topic、提示词库；没有后端能力的日历、语音、知识图谱等不做假功能 | 本次对齐 |
| 左侧层级 | 两级可折叠树：`Space → Pi Session`；助教不出现在左侧，唯一入口是右侧栏下方固定助教 | 本次对齐 |
| 点击 Space | 只展开/收起，不自动打开 Pi Session | 本次对齐 |
| 复习 Space 展开 | 展示 Topic 快捷入口与历史复习 Pi Session；Topic 点击打开新建复习 Pi Session 面板并预选 `review_topic_id` | 本次对齐 |
| 新建入口 | 学习/复习 Space 的 `+` 直接打开对应类型面板；第三个入口是全局新建入口，打开通用面板并由用户选择学习或复习；手动建 Card 放在 Card 管理页 | 本次对齐 |
| 新建默认值 | `enable_make_card = true`；教学风格可为空；Topic 有“全部”；创建成功立即进入对话；助教不可创建 | 本次对齐 |
| 右侧待审卡片 | 全局 `proposed` 池，支持 Topic 筛选；不声称卡片来自当前对话 | 本次对齐 |
| 助教上下文 | 仅用户点击“一次性发送并注入当前主会话简介”按钮时注入，不自动注入 | 本次对齐 |
| SSE 消费 | reducer + 原生 `EventSource` 被动重连；连接后 GET context 权威同步；404 引导重新打开，不自动创建 | 本次对齐 |
| 认证页 | Atelier Mind 风格的全屏背景与简洁认证卡，不使用三栏工作台 | 本次对齐 |
| 对话能力 | Markdown + KaTeX + Mermaid、思维块、工具调用折叠、超长消息降级、历史懒加载、IME 输入保护、草稿恢复、图片附件、`@` 文件引用、斜杠命令、steer/follow-up、移动端键盘适配 | 本次对齐 |
| 附件 | 属于本次 MVP；上传保存到当前 Pi Session 的 `work_path/attachments/`，后端补上传接口 | 本次对齐 |
| SPA 工程 | React Router；Vite `/api` proxy；生产 Express serve `web/dist` + SPA fallback | 本次对齐 |
| 模型 | 增加模型查询/切换 API，模型选择器通过 `set_model` 修改当前 Pi Session | 本次对齐 |
| 管理入口 | 左下角 2×2 Dock：系统设置、学习日历、知识卡库、帮助指南。设置为 `/app` 之上的路由覆盖层 modal，在同一面板切换 Card、Glossary、Topic、Agents Md、Teach Style、账号、模型与 Provider、高级配置八个子页 | 本次对齐 |
| 会话设定入口 | 模型、制卡开关、教学风格三者直接放在输入区控制条，可见可操作，不折叠进二级菜单；全部真实写后端并回读 | 本次对齐 |
| 卡片审批交互 | 第三栏上部固定 38% 高度、单卡浏览：左右切换、翻面、`n / 总数` 序号、Topic 切换重置，确认/拒绝后索引自然前进 | 本次对齐 |
| 页面内交互 | 重命名、删除确认一律用页面内 `InlineEdit` / `ConfirmDialog`，正常路径不使用 `window.prompt` / `alert` / `confirm` | 本次对齐 |
| 助教 URL | 使用稳定的 `pi_session.id` 作为前端身份，不暴露绝对路径，不使用临时 UUID | 本次对齐 |

### 卡片与复习

| 问题 | 结论 | 出处 |
| --- | --- | --- |
| 卡片去重判据 | 精确匹配（同 Topic、`front` 归一化）归代码，语义相似归模型；首版不用向量 | ADR-0017 |
| 复习形态 | 取一批 → 组织对话 → 批量判定 | ADR-0018 |
| Rating 判定规则 | 模型直接输出四档，无中间映射层；每档含义写在 rubric 里，待细化 | ADR-0019 |
| 一批取多少张卡 | 取卡工具只给 `nums` 参数，由 AI 结合用户偏好自主决定 | ADR-0021 |
| 到期卡积压 | 不调整 `due`，队列如实累积；另提供不经 AI 的 WebUI 手动复习 | ADR-0021 |
| 每张卡耗时预估 | 不做。节奏偏好由用户与 AI 在对话中写进 `USER.md`，代码不约束 | ADR-0021 |
| FSRS 训练的最少记录数 | 不设门槛，0 条也允许调用——记录不足时优化器本身不会改变权重 | ADR-0021 |
| 卡片表字段 | 6 个字段 + `status` 三态，无 `answer_mode` 与 `metadata` | `数据库与目录结构设计.md` |
| 卡片溯源 | 不存消息 id 与对话外键，靠 `reason_and_remark` | ADR-0010 |
| 卡片提议确认 UI | 批量确认与零星确认共用同一套交互 | 原对齐结论 |
| 合并卡的判据与实现 | 纯提示词约束触发时机 + 合并工具做实际合并与 FSRS 状态更新，不让 AI 算 | `todo.md` |
| 是否集成 Anki | 不集成 | ADR-0008 |

### 全局资源与提示词

| 问题 | 结论 | 出处 |
| --- | --- | --- |
| 每轮动态注入机制 | Pi 的 `context` 事件，不落盘、不受压缩 | `pi-hook机制调研.md` |
| 已掌握术语怎么给模型 | 不注入，`USER.md` 里写引导，AI 自主决定何时用数据库工具查 | ADR-0020 |
| AGENTS.md 生成时机 | 新开 Pi Session 时从 `agents_md` 表整份投影到该 Pi Session 的 `work_path` | ADR-0030 |
| Pi Session 工作目录 | `learn/<space-id>/pi/<pi-session-id>/`、`review/pi/<pi-session-id>/`、`ta/pi/<pi-session-id>/`；JSONL 平铺在 Pi Session 目录根部 | ADR-0030 |
| 资料存哪、索引格式 | 全局 `materials/`，索引是 `index.md` 普通 Markdown，模型自读自写 | `数据库与目录结构设计.md` |
| 资料抓取的上下文污染 | 交给子代理，`inheritContext: false` | ADR-0016 |
| 学习计划 | 由 MISSION.md 承担，不做“每天学什么”的拆分 | `todo.md` |
| 对话标题生成 | 后端独立 LLM 调用，写回 `pi_session.name` | `数据库与目录结构设计.md` |
| 助教会话压缩参数 | 保持 Pi 默认 | 原对齐结论 |

### 部署与运维

| 问题 | 结论 | 出处 |
| --- | --- | --- |
| Pi 实例的进程模型 | 所有 AgentSession 跑在后端宿主进程内（进程内 SDK），桥接层从 pi-web 移植到 Express；不 spawn 子进程 | ADR-0024 |
| Web 后端框架 | Express 5 | ADR-0025 |
| 前端框架与构建 | React + TypeScript + Vite + Tailwind，状态管理用内置 hooks 不引库；复用 pi-web 前端逻辑 | ADR-0025 |
| 手机端 | 只做 WebUI 响应式适配，后端不变 | ADR-0022 |
| Pi 事件流转 SSE | 使用 pi-web 事件订阅模式 | ADR-0024 |
