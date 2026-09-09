# PRD：第二阶段 UI/交互/配置打磨（frontend-polish-config）

> 任务简称：frontend-polish-config
> 状态：待实现
> 日期：2026-09-09
> 前置基线：commit `023858e`（frontend-webui-mvp：ADR-0030 后端重建 + 桌面版 WebUI）
> 视觉基准：`/workspace/pi-teacher/前端模板`（`DESIGN.md`、`code.html`、`screen.png`）
> 相关决策：ADR-0013、ADR-0014、ADR-0021、ADR-0022、ADR-0024、ADR-0029、ADR-0030
> 领域语言：`CONTEXT.md`（Space、Pi Session、Card、Teach Style、Agents Md 等术语以此为准）

## 1. 目标与边界

本任务不是重做 MVP，而是在已跑通的架构上做三件事：

1. **修复一个真实规格缺陷**：复习 Pi Session 的制卡开关被前端写死为关闭。
2. **补齐视觉与交互债务**：模板结构对齐、页面内交互替代原生弹窗、第三栏比例与单卡审批、输入区控制条。
3. **新增真实配置能力**：账号、密码、模型与 provider 配置、受控 JSON 配置，以及左下角四个入口所需的最小真实页面。

### 明确不做

- 不重写桥接层（`server/src/bridge/`）、会话生命周期与 SSE 协议。
- 不改动 ADR-0030 的 Space / Pi Session 数据关系。
- 不做移动端布局（仍待独立任务）。
- 不做多用户、不预留 `user_id`（ADR-0022）。
- 不引入 Redux/Zustand 等新状态库，继续用 hooks + context。
- 不使用假数据、mock DB、假模型结果或伪造的日历统计。

### 贯穿全任务的硬约束

- 任何开关必须端到端真实：前端表单 → API payload → 数据库 → 工具上下文 / Briefing。禁止只改前端显示。
- 正常交互不得使用 `window.prompt` / `window.alert` / `window.confirm`。
- 绝对路径、`sessionFile`、provider 凭据、API key 不得出现在任何 HTTP 响应、日志、验证输出与前端状态中。
- 代码、注释、错误信息、文档使用中文；identifier 保持英文。
- 维持 Ubuntu x64 / Node v24 / ESM / TypeScript NodeNext 现有约定。

## 2. 现状事实（已核实，实现时直接引用）

| 事实 | 位置 |
| --- | --- |
| `enable_make_card` 默认 1，助教强制 0，其余按传入值 | `server/src/db/schema.ts:68`、`server/src/session/repository.ts:94` |
| 创建 API 已接收并校验 `enableMakeCard` | `server/src/routes/conversations.ts:123` |
| 制卡权限由工具层强制拒绝 `card_propose` / `topic_create` | `server/src/tools/context.ts:27` |
| 每轮 Briefing 已注入制卡状态与到期卡数 | `server/src/projection/context-inject.ts:28` |
| 工具上下文在会话启动时由闭包捕获，是快照 | `server/src/tools/factory.ts:12`、`server/src/bridge/agent-session-wrapper.ts:555` |
| Teach Style 在创建时投影为 `style.md`，启动时读入 `appendSystemPrompt` | `server/src/projection/agents-md.ts:11`、`server/src/bridge/agent-session-wrapper.ts:548` |
| `GET /api/models` 只输出 provider / id / name | `server/src/routes/models.ts:11` |
| 模型目录为进程内单例缓存 | `server/src/session/models.ts:4` |
| 认证仅有 status / setup / login / logout / me | `server/src/routes/auth.ts:21` |
| scrypt 哈希与校验函数可直接复用 | `server/src/auth/password.ts:27` |
| 登录态为内存 Map，服务重启即失效 | `server/src/auth/session-store.ts:14` |
| `card_schedule` / `review_log` 已有真实调度与复习历史数据 | `server/src/db/schema.ts:115`、`server/src/db/schema.ts:130` |
| `GET /api/topics` 已聚合 `card_count` / `proposed_count` / `due_count` | `server/src/routes/topics.ts:70` |
| 复习面板前端写死 `enableMakeCard: false` ← **缺陷** | `web/src/app/CreatePanel.tsx:64` |
| 对话重命名使用原生 `prompt()` ← **待改** | `web/src/chat/ChatPanel.tsx:88` |
| Space 重命名/删除使用 `prompt()` / `alert()` / `confirm()` ← **待改** | `web/src/sidebar/Sidebar.tsx:52` |
| 第三栏两区均为 `flex-1`，比例约 1:1 ← **待改** | `web/src/aside/CardProposals.tsx:36`、`web/src/aside/AssistantPanel.tsx:40` |
| Proposal 为纵向列表渲染 ← **待改** | `web/src/aside/CardProposals.tsx:50` |
| 模型选择器在对话标题栏 ← **待移** | `web/src/chat/ChatPanel.tsx:108` |
| 左下角只有用户名 + 两个图标按钮 ← **待补** | `web/src/sidebar/Sidebar.tsx:160` |
| 已有可复用 `Modal` / `Field` / `useSubmit` / `ErrorLine` | `web/src/settings/shared.tsx:30` |

模板关键结构坐标：左栏底部 2×2 Dock `前端模板/code.html:177`；输入区控制 pill 行 `前端模板/code.html:320`；第三栏卡区 `h-[38%]` `前端模板/code.html:336`；单卡与左右切换 `前端模板/code.html:357`、`前端模板/code.html:384`；序号 badge `前端模板/code.html:342`；设置弹窗 `max-w-xl` `前端模板/code.html:742`；卡库弹窗 `max-w-4xl` `前端模板/code.html:651`；日历弹窗 `max-w-3xl` `前端模板/code.html:696`；帮助弹窗 `max-w-lg` `前端模板/code.html:777`。

## 3. 需求详述

### 3.1 复习 Pi Session 的制卡开关（缺陷修复）

**产品语义**（ADR-0013）：学习与复习都持有 `enable_make_card`，默认开启；复习的克制程度由复习 Agents Md 正文约束，不由布尔字段表达；助教永不制卡，工具层直接拒绝，不看该字段。

**实现要求**：

- `CreatePanel` 的制卡开关对 `learn` 与 `review` 两种模式都渲染，文案区分：
  - 学习：「允许老师在学习中提议记忆卡片」
  - 复习：「允许老师在复习中提议记忆卡片」，并附说明「复习以巩固为主，仅在暴露新盲点时提议」
- 默认值统一为开启，切换模式不重置用户已改动的选择。
- 提交时 `enableMakeCard` 按用户真实选择发送，删除 `mode === "learn" ? … : false` 的写死逻辑。
- 后端无需改动创建路径；须确认复习路径落库为 1 且工具层放行。

**验收**：创建关闭制卡的复习 Pi Session → `enable_make_card = 0` → `card_propose` 被工具层拒绝且理由可读；创建开启制卡的复习 Pi Session → 落库为 1 → 工具放行 → Briefing 显示「制卡已开启」。

### 3.2 运行时切换制卡开关（新增能力）

原 MVP 只在创建时决定。本阶段要把它放进输入区控制条，因此需要真实的运行时切换能力。

**难点**：`SessionToolContext` 是会话启动时的闭包快照（`server/src/tools/factory.ts:12`），仅更新数据库不会改变活跃 Pi Session 的工具裁决，会形成假开关。

**决策：把工具上下文从「值快照」改为「按需读取」。**

- `SessionToolContext` 中 `enableMakeCard` 由固定布尔改为读取函数或持有 `piSessionId` + `db`，在 `assertToolAllowed` 与 `buildContextInjection` 调用时实时查库。
- 这是最小侵入方案：不重启会话、不动 JSONL、不改 SSE 协议；`spaceType`、`workPath` 等真正不变的字段仍保持快照。
- 只读一行主键查询，开销可忽略。

**新增 API**：`PATCH /api/conversations/:id/options`

- 请求体：`{ "enableMakeCard": boolean }`
- 助教 Pi Session 返回 400（该字段对助教无意义）。
- 运行中允许切换（不涉及模型或 system prompt 重建），但下一轮 Briefing 才会体现，响应中明确返回生效语义。
- 返回更新后的 `conversation` 视图，供前端同步。

**为何不复用 command 通道**：command 是 Pi SDK 会话命令的转发层（`server/src/routes/conversations.ts:167`），制卡开关是 pi-teacher 业务字段，与 SDK 无关，放业务路由语义更正确。

**验收**：切换后立即调用 `card_propose`，工具裁决与新值一致；下一轮 Briefing 文案随之改变；数据库值正确；助教被拒。

### 3.3 运行时切换 Teach Style（新增能力，含语义变更）

**领域语言现状**：`CONTEXT.md:16` 写明「开始时选定提示词模板与教学风格，之后不变」。本阶段要让 Teach Style 可在当前 Pi Session 内切换，这是**对领域语言的修改**，必须落 ADR 并更新 `CONTEXT.md`。

**Agents Md 仍然不可切换**：它决定「做什么」，与 Space 类型强绑（schema 触发器校验），中途更换等于改变对话性质。只放开 Teach Style（决定「怎么说话」）。

**实现路径**：

`style.md` 在会话启动时读入 `appendSystemPrompt`（`server/src/bridge/agent-session-wrapper.ts:548`），因此改文件对已启动会话无效。切换需要：

1. 校验目标 `teach_style_id` 存在（或为 null）；
2. 更新 `pi_session.teach_style_id`；
3. 重新投影 `style.md`（复用 `projectTeachStyle`）；
4. 让活跃会话重新加载 system prompt：**关闭当前 wrapper 后按稳定 ID 重开同一 JSONL**（复用现有 `close` + `open` 路径，`startWorkspaceSession` 的 `SessionManager.open` 保证历史与身份不变）；
5. 通过既有 SSE 事件让前端重新同步 context。

**约束**：

- 运行中禁止切换，返回 409「请等待当前回复结束再切换教学风格」，与 `set_model` 的运行中保护一致（`server/src/routes/conversations.ts:194`）。
- 重开必须保留 `pi_session.id`、`work_path`、`path`、历史消息与已选模型（`set_model` 已持久化，`hasModel` 分支保证不被默认模型覆盖）。
- 前端必须提示「切换将重新载入当前对话的风格设定，历史不变」。

**新增 API**：`PATCH /api/conversations/:id/teach-style`，请求体 `{ "teachStyleId": number | null }`。

**验收**：切换后 `style.md` 内容为新风格、数据库字段更新、重开后历史条数与模型不变、JSONL 路径不变、运行中切换被 409 拒绝。

### 3.4 页面内重命名（替代原生弹窗）

**范围**：Pi Session 重命名 + 学习 Space 重命名与删除确认，一并消除原生弹窗。

**Pi Session 重命名**：标题位置 inline edit。

- 点击标题旁编辑按钮进入编辑态，输入框获得焦点并全选原名。
- Enter 保存，Escape 取消，失焦不隐式保存（避免误提交）。
- 空名称或纯空白：就地显示校验错误，不发请求。
- 保存中禁用输入与按钮；失败就地显示错误并保留编辑态。
- 成功后同步主区标题与左侧树（沿用 `onRenamed` → `refresh()`）。
- 仍走 `set_session_name` command（后端已同步数据库，`server/src/routes/conversations.ts:213`）。

**Space 重命名**：左侧树行内 inline edit，键盘契约同上，复用同一套输入与错误样式。

**Space 删除**：改用页面内确认弹层，复用 `settings/shared.tsx` 的 `Modal`；文案保留「文件会保留在磁盘上」这一真实后果说明。

**复用要求**：inline edit 的键盘与错误处理抽成一个可复用组件（如 `web/src/components/InlineEdit.tsx`），Pi Session 与 Space 共用，不写两份。`Modal` 从 `settings/shared.tsx` 提升为通用组件，供设置面板、创建面板、确认弹层共用。

### 3.5 左下角四个快捷卡片

按模板 2×2 Dock 实现（`前端模板/code.html:177`）：卡片层级、图标、`label-md` 字号、间距与 hover 状态对齐，不做成四个纯文字按钮。

| 卡片 | 图标 | 打开内容 | 数据真实性 |
| --- | --- | --- | --- |
| 系统设置 | `tune` | 设置 modal（见 3.7） | 全部真实 API |
| 学习日历 | `calendar_today` | 复习排期 modal | 真实 `card_schedule` / `review_log` 聚合 |
| 知识卡库 | `style` | 设置 modal 的 Card 子页 | 复用现有 `CardsTab` |
| 帮助指南 | `help_center` | 帮助 modal | 静态说明，无数据 |

**知识卡库**：不新建组件，直接打开设置 modal 并定位到 Card tab（`?tab=cards`），避免重复实现卡片管理。

**学习日历**：新增 `GET /api/review-schedule`，只返回可由现有表确定性算出的数据：

- 未来 N 天（默认 14）每天的到期卡片数，按 `card_schedule.due` 日期分组，仅 `card.status = 'normal'`；
- 已逾期卡片总数（`due <= now`）；
- 最近 N 天每天的真实复习次数，来自 `review_log.reviewed_at`；
- 可选按 Topic 过滤。

**严禁**：连续打卡天数、平均留存率、预计用时等模板中虚构的指标——除非能由现有表确定性算出，否则不做。日历为空时显示明确空状态，不填充占位数字。

**帮助指南**：基于本项目真实概念撰写（Space / Pi Session / Card 审批 / 复习调度 / 助教注入 / `@` 引用 / 斜杠命令 / 制卡开关），不抄模板的虚构文案。

### 3.6 更严格对齐前端模板

技术栈不变。以下为**可验收的结构项**，而非「换颜色」：

**布局与比例**

- 左栏保持 `16rem`（`gutter-sidebar`），右栏 `22rem`（`gutter-aside`），中间自适应，阅读区 `44rem`（DESIGN.md `spacing`）。
- 顶部栏统一 `h-14`；左栏结构固定为「品牌区 / 可滚动仓区 / 底部 Dock」三段。
- 第三栏卡区约 1/3、助教约 2/3（见 3.8）。

**表面层级**（DESIGN.md「Surface Hierarchy」）

- 基底 `surface`；左右栏 `surface-container-low`；卡片与文档面 `surface-container-lowest`；hairline 分隔用 `line`。
- 输入区改为浮动卡片（`rounded-2xl` + `shadow-md` + `focus-within` 提升），不再是整条底边栏。

**字体层级**

- Newsreader 用于对话正文（`body-reading`）、面板标题、品牌名；Inter 用于控件、树节点、元数据；JetBrains Mono 用于代码、ID、计数。
- `.prose-chat` 正文应用阅读字体与 `1.6–1.7` 行高（DESIGN.md「Formatting & Readability Rules」）。

**组件形态**

- 树节点 32px 行高、6px hover 圆角、选中态左侧 2px 竖条 + 半粗体（DESIGN.md「Lists & Navigation Trees」）。
- 卡片 10–12px 圆角 + 1px `line` + resting shadow，hover 边框转 `outline-variant`。
- 输入聚焦为 1.5px sage 边框 + `0 0 0 3px rgba(91,124,110,0.12)` 光晕，不用蓝色 outline。
- Modal 外壳 14px 圆角，内部嵌套 8px。
- 计数用 pill，`label-sm` + 等宽数字。

**空状态与密度**

- 所有列表（对话、卡片、Topic、术语、日历）都有符合模板语气的空状态，不留空白区域。
- 8px 基线节奏，4px 用于徽标与内联标签。

**执行方式**：在 `web/src/styles.css` 补齐缺失的语义工具类（如 `panel`、`dock-card`、`tree-row`、`pill`、`input-floating`），各组件复用这些类，避免同样的 Tailwind 串在多处重复。

### 3.7 系统设置改为页面内 modal

**交互**

- 从左下角「系统设置」打开，宽高小于 viewport（宽度参考模板 `max-w-xl`，但本产品含五个管理 tab，采用 `max-w-5xl` + `max-h-[85vh]`，内部滚动）。
- 背景保留主对话、左侧树与第三栏，加遮罩 + backdrop blur。
- 关闭方式三种：关闭按钮、点击遮罩、Escape。
- 打开时焦点进入 modal，关闭后焦点回到触发按钮。

**路由兼容（必须保留）**

- 设置状态仍由 URL 表达，不能退化为局部 `useState`，否则会破坏前进/后退与直接访问。
- 方案：把 `/settings` 变为 `/app` 之上的覆盖层——`/app/c/:id` 打开设置时进入 `/app/c/:id/settings?tab=cards`，背景路由继续渲染；直接访问或刷新 `/settings` 时，重定向到 `/app/settings`，在无对话的工作台背景上显示同一 modal。
- `tab` 仍存 query，浏览器前进/后退可在 tab 之间切换，关闭 modal 等价于返回背景路由。
- 保留五个 tab：Card、Glossary、Topic、Agents Md、Teach Style，再加 3.8 的账号与配置 tab。

**服务端**：SPA fallback 已覆盖任意路径（`server/src/index.ts:76`），无需改动；但需在验证中确认新路径可直接访问。

### 3.8 设置中的真实配置能力

设置 modal 新增 tab：**账号**、**模型与 Provider**、**高级配置**。

#### 3.8.1 账号与密码

**新增 API**

- `PATCH /api/auth/username`：请求 `{ currentPassword, username }`
- `PATCH /api/auth/password`：请求 `{ currentPassword, newPassword, confirmPassword }`

**规则**

- 两者都必须校验 `currentPassword`（复用 `verifyPassword`），失败返回 401，文案统一为「当前密码不正确」，不透露其他信息。
- 服务端独立校验，不信任前端：用户名非空且 ≤ 100 字符；新密码至少 6 位（与 setup 一致，`server/src/routes/auth.ts:36`）；`confirmPassword` 一致性同时在前后端校验。
- 新密码与当前密码相同时返回 400「新密码不能与当前密码相同」。
- 单用户语义（ADR-0022）：只操作 `user` 表唯一那一行，不引入 `user_id` 参数。

**改密后的登录态**：采取**安全失效其他会话、保留当前会话**策略——销毁除当前 token 外的所有登录态，为当前会话签发新 token 并下发新 cookie。理由：改密后旧会话继续有效不安全；把当前用户也踢出去则是无意义的体验损失。需要在 `session-store.ts` 增加「按用户销毁其他会话」能力。

**改用户名后**：登录态中的 `username` 需同步更新，避免 `/api/auth/me` 返回旧名。

**错误信息**：不回显密码内容，不区分「用户不存在」与「密码错误」。

#### 3.8.2 模型与 Provider 配置

**真实数据源**：`~/.pi/agent/models.json`（`{ providers: Record<string, ProviderConfig> }`）与 `~/.pi/agent/settings.json`（`defaultProvider` / `defaultModel` / `retry` 等）。**已确认 `models.json` 内嵌 apiKey**，因此这是本任务最高风险面。

**已核实的 schema 契约（SDK 0.84.2）**

- provider 层可选字段：`name`、`baseUrl`、`apiKey`、`api`、`oauth: "radius"`、`headers`、`compat`、`authHeader`、`models`、`modelOverrides`。
- model 层只有 `id` 必需；其余可选：`name`、`api`、`baseUrl`、`reasoning`、`thinkingLevelMap`、`input`、`cost`、`contextWindow`、`maxTokens`、`samplingParams`、`headers`、`compat`。
- Known API 共十种，UI 中 `api` 必须是这十项的下拉枚举，不允许自由输入：`openai-completions`、`mistral-conversations`、`openai-responses`、`azure-openai-responses`、`openai-codex-responses`、`anthropic-messages`、`bedrock-converse-stream`、`google-generative-ai`、`google-vertex`、`pi-messages`。
- **SDK 的结构校验对未知键不严格**：拼错的 `baseURL` 或非法 `api` 字符串可能静默通过保存、直到真正请求时才失败。因此服务端必须自带严格字段白名单 + `api` 枚举校验，不能只依赖 SDK。
- `models.json` 容忍 `//` 行注释与尾逗号（不支持 `/* */`）；`settings.json` 走原生 `JSON.parse`，不容忍注释。改写时不保留注释，需在 UI 明示。

**新增 API**

- `GET /api/config/models`：返回 provider 列表（名称、api 类型、baseUrl、模型 id 列表）与默认 provider/model；凭据只返回 `apiKeyConfigured: boolean`（或固定掩码 `"••••"`），**绝不返回真实字符、长度、前后缀、环境变量名或引用命令**。
- `PATCH /api/config/models`：接收 provider 的可编辑字段；secret 字段遵循**三态语义**：
  - 缺省 = 保持原值不变；
  - 非空字符串 = 用新值覆盖；
  - `null` = 清除该字段。
  - 空字符串**不表示清除**（避免误删）；提交值等于下发掩码时一律视为「保持不变」。
- `PATCH /api/config/default-model`：设置 `defaultProvider` / `defaultModel`，必须是当前目录中真实可用的组合，否则 400。

**secret 边界（比 apiKey 更宽）**

- 需要脱敏的不只 `apiKey`，还包括 provider 与 model 层的 `headers` 值（常用于放置令牌）。
- 凭据值可能是明文、`$VAR`、`${VAR}` 或 `!command` 三类引用。出口一律折叠为「已配置 / 未配置」，不得暴露引用形式本身，否则等于泄漏环境变量名与命令行。

**写入安全（models.json）**

- 写前解析 + 严格字段白名单 + `api` 枚举校验，拒绝未知键。
- 通过后再做一次**候选校验**：把候选内容写入临时文件，用 `ModelRuntime.create({ modelsPath })` 打开并检查 `getError()`，确认 SDK 侧可加载后才落到正式路径。单个 provider 的错误不应阻断其他 provider，错误信息需脱敏后返回。
- 写入采用**同目录临时文件 + `rename` 原子替换**，保持 `0o600` 权限（本机现为 `-rw-------`）。
- 校验失败或写入异常时原文件字节不变。
- 任何路径下都不得把文件内容原样返回前端或写入日志。

**写入安全（settings.json）——与 models.json 策略不同**

- `settings.json` 由 SDK `SettingsManager` 以 `proper-lockfile` 加锁、**锁内重读、字段级合并**方式写入，本机权限 `0o644`。整文件原子替换会与各 Pi Session 自己的 SettingsManager 竞争并丢更新，**因此禁止整文件覆盖**。
- 默认 provider/model 一律走公开 setter：`setDefaultProvider()` / `setDefaultModel()` / `setDefaultModelAndProvider()`，随后 `flush()`。
- `retry` 细项没有公开 setter（只有 retry enabled 有）。若本阶段确实要编辑，必须复刻「加锁 → 锁内重读 → 字段级合并 → 写回」语义，并把 `proper-lockfile` 声明为 `server` 的显式依赖，不得依赖 SDK 的嵌套包。

**缓存刷新**：`getModelCatalog()` 为进程内单例（`server/src/session/models.ts:4`）。SDK 提供公开方法 `ModelRuntime.refresh({ allowNetwork: false })`（无 invalidate API），保存成功后**优先调用 refresh**，而不是把 `catalogPromise` 置空重建。refresh 必须串行化，避免并发保存交错。已启动的 Pi Session 保持其当前模型不变（避免运行中被动切换），新会话与模型列表使用新配置；前端需明确提示这一点。

**环境变量覆盖**：`PI_TEACHER_PROVIDER` / `PI_TEACHER_MODEL` 优先于 settings（`server/src/session/models.ts:17`）。`GET` 需返回 `defaultModelSource: "env" | "settings" | "catalog"`；当来源为 `env` 时，UI 显示「当前由部署环境变量固定」并禁用编辑，服务端对 `PATCH /api/config/default-model` **返回 409**，不给出假成功。

#### 3.8.3 高级配置（受控编辑，不做自由 JSON）

**明确对象**：不做任意文件编辑器，也不提供自由 JSON textarea。`models-store.json` 不是用户配置编辑目标。本阶段只有两个编辑面：

1. **Pi 运行设置白名单**（来自 `settings.json`）：`defaultProvider`、`defaultModel`，以及可选的 `retry`（`timeoutMs` / `maxRetries` / `maxRetryDelayMs`）。全部为**结构化表单字段**，按 3.8.2 的 SettingsManager 路径写入。`packages`、`theme`、`lastChangelogVersion` 属 Pi 框架自身管辖，只读展示或不展示。
2. **provider / model 定义**（来自 `models.json`）：主入口为结构化表单（provider 名称、`api` 枚举下拉、`baseUrl`、模型列表、凭据三态）。另提供**脱敏只读 JSON 视图**便于核对；若开放该视图的编辑，则只接受白名单字段的子集，凭据位置显示掩码并遵循三态语义。

**编辑与保存**

- 不引入第三方编辑器依赖；JSON 视图用等宽 `textarea` 呈现。
- 前端保存前先 `JSON.parse`（如为可编辑视图），错误显示具体信息。
- 服务端二次解析 + 严格白名单 + 枚举/区间校验 + 候选 `ModelRuntime` 校验。
- `models.json` 走原子替换并保持 `0o600`；`settings.json` 走 SettingsManager / 锁内合并并保持 `0o644`。
- 保存失败绝不破坏原文件。

## 4. 第三栏比例与卡片审批交互

### 4.1 比例

- Card 审批区约占第三栏高度 1/3，助教约 2/3（模板为 `h-[38%]`，采用固定百分比而非 `flex-1`）。
- 助教区在缩小后仍必须完整可用：消息区可滚动、输入框可见、「一次性发送并注入当前主会话简介」按钮清晰可点，不被挤压或截断。

### 4.2 单卡浏览状态机

替换现有纵向列表（`web/src/aside/CardProposals.tsx:50`）：

- 一次只显示一张提议卡。
- 左右按钮切换上一张 / 下一张；到边界时禁用对应按钮（不循环，避免用户误判是否看完）。
- 正面 / 背面可翻看；**切卡时重置为正面**，避免看到上一张的背面状态。
- 保留确认与拒绝。
- 显示序号，格式 `当前 / 总数`（如 `1 / 5`）。
- **Topic 切换后索引重置为 0，翻面状态重置。**
- 确认或拒绝后从池中移除该卡，索引停在原位以自然显示下一张；若移除的是最后一张，索引回退到新的末位；池空则显示空状态。
- 加载中、错误、空池三种状态都有明确呈现，空状态符合模板视觉。

**后端**：现有 `GET /api/cards?status=proposed&topicId=` 与 confirm / reject 已足够，无需新增接口。

## 5. 消息输入区控制条

把当前对话的输入控制集中到输入卡片内（模板 `前端模板/code.html:320`）：

**控制条内容**

- 会话类型标签（学习 / 复习 / 助教，只读）。
- 复习 Topic 标签（只读，复习会话显示）。
- **模型选择器**：从标题栏移入；运行中或未连接时禁用，`title` 说明原因；仍走 `set_model` command。
- **制卡开关**：真实切换，走 3.2 的 `PATCH /options`；助教会话不显示。
- **教学风格选择器**：真实切换，走 3.3 的 `PATCH /teach-style`；运行中禁用；切换前提示会重新载入风格。
- 连接状态标签（连接中 / 已连接 / 重连中 / 已回收）从标题栏移入或保留在标题栏，二者择一，不重复显示。

**布局要求**

- 控件按模板做紧凑 pill 分组，两行以内：上行为状态与会话设定，下行为附件、模型与发送。
- 不得让输入区过度拥挤：次要控件可折叠进「会话设置」小菜单，但**模型、制卡、教学风格三者必须直接可见可操作**，不藏进二级菜单。
- 标题栏移除模型选择器后，只保留标题、inline 重命名入口与必要标签。

**状态同步**：切换后通过既有 `refreshContext` / SSE 事件更新 `conversation`，控件反映真实后端状态，不做乐观假设。

## 6. 后端改动清单

### 新增路由

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| PATCH | `/api/conversations/:id/options` | 切换 `enable_make_card` |
| PATCH | `/api/conversations/:id/teach-style` | 切换 Teach Style（含重开会话） |
| GET | `/api/review-schedule` | 日历真实排期与复习历史聚合 |
| PATCH | `/api/auth/username` | 修改用户名（校验当前密码） |
| PATCH | `/api/auth/password` | 修改密码（校验当前密码） |
| GET | `/api/config/models` | provider/model 配置（secret 脱敏） |
| PATCH | `/api/config/models` | 保存 provider 配置（原子写） |
| PATCH | `/api/config/default-model` | 设置默认 provider/model |
| GET | `/api/config/settings` | 白名单运行设置 |
| PATCH | `/api/config/settings` | 保存白名单运行设置（SettingsManager / 锁内合并） |

### 修改点

- `server/src/tools/context.ts`：`enableMakeCard` 改为实时读取，支持运行时切换。
- `server/src/projection/context-inject.ts`：制卡状态随实时值注入。
- `server/src/session/models.ts`：增加串行化的 `ModelRuntime.refresh({ allowNetwork: false })` 入口，并暴露 `defaultModelSource`。
- `server/src/auth/session-store.ts`：支持「销毁除当前 token 外的会话」与用户名更新。
- 新增 `server/src/config/`：Pi 配置读取、校验、脱敏、原子写入模块（集中处理 secret，避免散落）。

### 不改动

桥接层协议、SSE 事件类型、`clientView` 出口投影规则、Space/Pi Session schema 关系、附件与 file-index 逻辑。

## 7. 文档同步

- **新增 ADR-0031**：Teach Style 可在 Pi Session 运行期切换（supersedes `CONTEXT.md` 中「之后不变」对教学风格的部分），并说明 Agents Md 仍不可切换的理由。
- **新增 ADR-0032**：WebUI 可编辑 Pi 模型/provider 配置的边界与 secret 处理原则（只出不进的脱敏、三态语义、原子写、缓存刷新、env 覆盖优先）。
- **更新 `CONTEXT.md`**：Teach Style 条目改为「开始时选定，可在对话进行中切换」；Agents Md 保持不变。
- **更新 `docs/open-questions.md`**：补入本阶段结论（设置为覆盖层 modal、日历只用真实聚合、JSON 编辑范围限定）。
- **更新 `数据库设计.md`**：`enable_make_card` 与 `teach_style_id` 说明补上「可运行时修改」及其生效机制。
- **不恢复** `docs/` 下此前被外部删除的四份设计文档。

## 8. 实现顺序

1. **缺陷修复**：复习制卡开关（3.1）——最小改动、独立可验证。
2. **后端能力**：工具上下文实时化 + `PATCH /options`（3.2）→ Teach Style 切换（3.3）→ `GET /api/review-schedule`（3.5）。
3. **配置后端**：`server/src/config/` 模块 → 账号密码（3.8.1）→ 模型 provider（3.8.2）→ 白名单设置（3.8.3）。
4. **前端基础**：`styles.css` 语义类补齐 + 通用 `Modal` / `InlineEdit` 提升（3.4、3.6）。
5. **前端结构**：三栏比例与模板对齐（3.6）→ 设置覆盖层路由（3.7）→ 左下角 Dock 与四个入口（3.5）。
6. **前端交互**：inline 重命名（3.4）→ 单卡审批（4）→ 输入区控制条（5）。
7. **设置前端**：账号、模型 Provider、高级配置三个 tab。
8. **验证与文档**：验证脚本扩展 → ADR 与文档同步 → 真浏览器验收。

每完成一组即跑对应 typecheck / build / 验证，不积压到最后。

## 9. 验收标准

### 后端

- 复习 Pi Session 的 `enable_make_card` 按用户选择落库；助教恒为 0。
- 运行时切换制卡后，工具裁决与 Briefing 立即使用新值。
- Teach Style 切换后 `style.md` 与数据库一致；重开保留 `pi_session.id`、JSONL 路径、历史条数与已选模型；运行中切换返回 409。
- 改密码 / 改用户名必须校验当前密码；错误信息不泄漏账号是否存在；其他会话失效、当前会话可用。
- `GET /api/config/models` 与 `GET /api/models` 均不含 apiKey、header 值或任何 secret 片段，也不含 `$VAR` / `!command` 引用形式。
- 配置保存后模型目录经 `ModelRuntime.refresh()` 刷新；`models.json` 写入失败时原文件字节不变，权限仍为 `0o600`；`settings.json` 经 SettingsManager / 锁内合并写入，权限仍为 `0o644`，未涉及字段不被抹掉。
- 非法 JSON、未知字段、非 Known API 的 `api` 值、越界数值全部被拒且不落盘。
- `defaultModelSource === "env"` 时 `PATCH /api/config/default-model` 返回 409。
- `GET /api/review-schedule` 数据可由 `card_schedule` / `review_log` 复算验证，无捏造指标。
- 所有响应仍不含绝对路径（沿用 http-smoke 的既有断言机制）。

### 前端

- 复习新建面板显示制卡开关，默认开启，语义真实。
- 重命名、Space 重命名、Space 删除全部为页面内交互；代码中不再出现 `window.prompt` / `alert` / `confirm` 作为正常路径。
- 左下角四个模板样式卡片可用；日历与卡库展示真实数据或明确空状态；帮助内容与本产品一致。
- 设置以 modal 形式打开，背景保留；三种关闭方式可用；tab 与浏览器前进后退正常；直接访问和刷新有合理行为。
- 第三栏卡区约 1/3、助教约 2/3；助教输入与注入按钮清晰可操作。
- 卡片单卡浏览：左右切换、翻面、序号、Topic 切换重置、确认拒绝后正确前进、空状态正确。
- 输入区可直接操作模型、制卡与教学风格，且状态与后端一致；运行中禁用规则生效。
- 账号、密码、模型 provider、受控配置四类操作都连真实 API，成功与失败都有明确反馈。
- 三栏比例、字体层级、卡片形态、hover 与空状态可与 `screen.png` 逐项比对。

### 验证面

必须全绿：

- `server`：`typecheck`、`smoke`、`verify:schema`、`verify:attachments`、`verify`、`http-smoke`、`verify:lifecycle`
- `web`：`typecheck`、生产 `build`

**新增或扩展的验证**：

- `verify:schema`：复习 Pi Session 制卡开关双值落库；Teach Style 切换后字段与投影一致。
- `smoke`：制卡运行时切换后工具裁决改变（关 → 拒绝，开 → 放行）。
- `http-smoke`：新增八类端点的成功与失败路径；改密后旧会话失效；`GET /api/config/models` 无 secret；配置写入失败不破坏原文件；`/api/review-schedule` 与直接 SQL 聚合一致。
- 新增 `verify:config`（若 http-smoke 过长则独立）：配置校验、原子替换、权限保持、掩码不回写、缓存刷新。

配置类验证必须在临时 HOME 中进行，绝不触碰用户真实 `~/.pi/agent/`。

### 真浏览器验收

用 `agent-browser` 走通：页面内设置 modal、inline 重命名、四个 Dock 卡片、第三栏 1/3 + 2/3、卡片左右切换、输入区三个控件、复习新建制卡开关、账号密码修改、模型 provider 配置、JSON 校验与保存。

## 10. 风险与对策

| 风险 | 对策 |
| --- | --- |
| provider secret 泄漏（最高风险） | 集中在 `server/src/config/`；出口只给布尔 + 固定掩码；`apiKey` 与 `headers` 同等对待；不暴露 `$VAR` / `!command` 引用形式；验证脚本断言响应体不含 secret |
| SDK 对未知键不严格，拼错字段静默通过 | 服务端自带严格白名单 + `api` Known API 枚举；落盘前用临时文件 + `ModelRuntime.create({ modelsPath })` + `getError()` 做候选校验 |
| settings.json 整文件覆盖丢失并发更新 | 禁止整文件替换；默认模型走 SettingsManager setter + `flush()`；retry 细项复刻锁内重读 + 字段级合并，`proper-lockfile` 显式依赖 |
| 假开关（改库不改行为） | 工具上下文实时读取；验证以工具裁决而非数据库值为准 |
| Teach Style 重开丢历史或换模型 | 复用 `SessionManager.open` + `hasModel` 分支；验证断言历史条数、JSONL 路径与模型不变 |
| 配置写坏导致启动失败 | 校验先行 + 临时文件原子替换；失败保持原文件 |
| 设置改 modal 破坏路由 | 保持 URL 表达状态，覆盖层路由 + tab query，验证刷新与前进后退 |
| 输入区控件过密 | 两行紧凑分组；次要项可折叠，三个核心控件必须直接可见 |
| 日历无真实数据来源 | 只做能确定性计算的聚合；其余做空状态说明 |
| 改密码把自己锁死 | 保留当前会话并换发新 token，只失效其他会话 |
| 模型缓存不刷新导致「保存无效」错觉 | 保存后主动失效重建；界面明确说明已启动会话不受影响 |
