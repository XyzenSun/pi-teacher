# Pi Teacher 开发者文档

面向开发者的仓库总览：各目录职责、数据库设计、运行时目录设计与关键机制。
领域语言（Space / Pi Session / Agents Md / Teach Style / Briefing / Card / Topic 等）是贯穿本文与代码的核心术语，命名保持一致。

## 仓库布局

```
pi-teacher/
├── doc-for-dev/                    ← 开发者文档（本目录）
├── server/                     ← 后端宿主（Express 5，Node 24 ESM + tsx 直跑）
├── web/                        ← 前端（React 19 + TypeScript + Vite 7 + Tailwind v4）
├── skills/                     ← 内置 skill（五个，随镜像分发）
├── Dockerfile                  ← 三阶段构建：前端 → 后端依赖 → 运行镜像（node:24-slim）
├── docker-entrypoint.sh        ← 启动时把内置 skill 覆盖同步进 ~/.pi/agent/skills，再启动后端
└── compose.yaml                ← 单机部署编排：端口、两个数据挂载、健康检查
```

## server/ —— 后端

Express 5 应用，既是 HTTP API 与 SSE 服务，也是 Pi Agent 进程的宿主。目录按职责划分：

| 目录 | 职责 |
| --- | --- |
| `src/bridge/` | **Pi SDK 桥接层**。`agent-session-wrapper.ts` 包装一次 Agent 会话：准入串行化、空闲 10 分钟回收（固定助教例外，常驻到 SIGTERM）、运行中风格切换的重载；事件流相关文件把 Pi 的内部事件规范化成前端可消费的形状 |
| `src/session/` | 会话仓储与周边：`repository.ts`（pi_session 表 CRUD、IMMEDIATE 事务预占 id 再建目录）、`session-reader.ts`（读 JSONL 历史）、`title-generator.ts`（首轮后独立发起一次 LLM 调用生成标题，不在会话内走工具）、`attachments.ts` / `models.ts` |
| `src/tools/` | **Pi 插件与 15 个业务工具**（`card_*` / `topic_*` / `glossary_*` / `review_*` / `md_*` / `file_*`）。`factory.ts` 是注册入口，`context.ts` 每轮实时从数据库读工具开关——闭包快照会得到假开关。签名与可见性见 `factory.ts` 及各工具定义文件 |
| `src/projection/` | 双向投影：开会话时把 `agents_md` / `teach_style` 模板写成工作目录的 `AGENTS.md` / `style.md`（`agents-md.ts`）；HTTP 出口把内部路径折叠成相对路径（`client-view.ts`，前端永不见绝对路径）；`system-prompt-builder.ts` 合并全局 `USER.md` + 会话 `style.md` 经 `appendSystemPrompt` 注入；`context-inject.ts` 每轮注入待复习数等动态状态（不落 JSONL）；`maintenance-reminder.ts` 按轮次在用户消息末尾追加维护提醒 |
| `src/prompts/defaults.ts` | **全部出厂提示词的唯一出处**：全局 AGENTS.md、四套 agents_md 模板、教学风格模板、三段基础维护提醒 + 学习精华追加段。调提示词只改这一个文件 |
| `src/db/` | `schema.ts`（建表 + 触发器 + 幂等迁移）、`seed.ts`（幂等初始化固定 Space、预置模板、全局文件）、`connection.ts` |
| `src/fsrs/service.ts` | ts-fsrs 封装：关闭多步学习（`learning_steps: []`），一卡一天最多出现一次；时间列统一 SQLite 空格分隔格式，不存 ISO 串 |
| `src/routes/` | HTTP 形状：workspaces / conversations（含 SSE）/ cards / glossary / topics / prompts / auth / config / models / attachments / review-schedule / app-state，统一 `HttpError` + 错误处理器 |
| `src/auth/` | 单用户 scrypt 密码 + 签名 cookie 会话 |
| `src/config/` | `pi-config.ts`（models.json / settings.json 脱敏读写，secret 只在这一个文件处理）、`user-env.ts`（`user_env` 表 → `process.env`，保存即注入）、`home-markdown.ts`（`~/pi-teacher` 下全局 Markdown）、`app-settings.ts`（`setting` 表） |
| `src/security/` | `path-security.ts`（路径越界防护）、`request-security.ts`（Host 头校验防 DNS rebinding） |
| `src/events/hub.ts` | SSE 事件集线器 |
| `src/verify/` | 验证脚本（见下文命令矩阵）——不是单元测试，全部走真实 SQLite / 真实 Pi SDK / 真实模型 |

## web/ —— 前端

React 19 + TypeScript + Vite 7 + Tailwind v4，无组件库。三栏布局：左侧 Space / 会话树（`sidebar/`）、中间对话流（`chat/`：Markdown + KaTeX + Mermaid 渲染、SSE reducer、消息与工具调用折叠、输入框的 IME / `@` 文件补全 / `/` 命令）、右侧固定助教与卡片提议池（`aside/`）。`settings/` 是 `/app` 之上的路由覆盖层 modal（模型、用户偏好、Agents Md、高级配置、账号）。`api/` 封装 HTTP 与 SSE；`app/` 是路由与全局 context。

## skills/ —— 内置 skill

五个目录，目录名即各自 `SKILL.md` frontmatter 的 `name`：

| 目录 | 形态 |
| --- | --- |
| `tavily-search` / `exa-search` / `pullpage` | 零依赖 Node 单文件脚本（脚本本身即源码，`scripts/` 下直接改） |
| `sbx` | esbuild bundle 单文件（4.4M，重建方法见 `skills/sbx/sourcecode/README.md`） |
| `tingwu-transcribe` | 零依赖 Node skill（Cookie 鉴权，详见 ADR-0042）；已在上游基础上扩展听悟服务器直链转写（net_source，见 skill 内 references/net-source.md） |

机制（ADR-0029 / 0040 / 0041 / 0042）：`skills/` 在构建时 COPY 进镜像 `/app/skills`；`docker-entrypoint.sh` 每次启动把每个内置 skill **先删同名目录再整目录复制**进 `~/.pi/agent/skills`——升级镜像即升级内置 skill，用户自建 skill 目录不受影响。Pi 自动发现 `~/.pi/agent/skills/` 下含 `SKILL.md` 的目录，把 `name` / `description` 注入系统提示词的 `<available_skills>`；「何时用哪个 skill」只写在各自 description 里，**不进全局 AGENTS.md**。新增 skill 只需往 `skills/` 加目录 + 重建镜像，后端零改动；若需要新密钥，才动 `BUILTIN_USER_ENV`（`server/src/config/user-env.ts`）。

## 数据库设计

单文件 SQLite，12 张表（11 张业务表 + 1 张认证 `user`）。设计原则：**前端要渲染的、卡片与调度进数据库；模型读写的散文留在文件系统**。Pi 的会话历史（JSONL）与业务库分库不合库——迁移历史各自演进、写锁互不干扰。

```
space ──< pi_session
              ├──> agents_md      提示词模板（type 过滤适用范围）
              ├──> teach_style    教学风格（可空）
              └──> topic          review_topic_id，仅复习对话有值

topic ──< card ──1:1── card_schedule    仅 status='normal' 的卡有调度行
                 └──< review_log       复习记录，供 FSRS 参数优化

glossary / user_env / setting           三张孤立表，无外键
```

| 表 | 职责 |
| --- | --- |
| `space` | 收纳容器，`type` 区分 `learn` / `review` / `ta`。`id=0`（助教）与 `id=1`（复习）是固定容器，由部分唯一索引 + 触发器 + 代码三层保护不可删改；只有 `learn` 可建可删 |
| `pi_session` | 一次 Pi 对话：独立 `work_path`、JSONL 路径、选定的模板 / 风格 / 制卡开关、复习主题过滤。助教会话由部分唯一索引限定全局唯一。id 分配用 `MAX(sqlite_sequence.seq, MAX(id))+1` 预占，先占 id 再建目录避免目录冲突 |
| `agents_md` | 提示词模板库，「做什么」（新学 / 新学不制卡 / 复习 / 助教）。单独建表而非存正文：模板跨对话复用，存正文则每次开对话复制全文、改模板还得批量更新历史行 |
| `teach_style` | 教学风格库，「怎么说话」，与模板正交自由组合 |
| `topic` | 卡片归类维度 + FSRS 参数配置粒度（`request_retention` / `maximum_interval` 主题级可调） |
| `card` | 卡片内容。`status` 三态 `proposed` / `normal` / `deleted`：**AI 只能写 proposed 或 deleted，确认权在用户**；读取（到期队列、统计）只认 `normal` |
| `card_schedule` | FSRS 调度状态，与 card 一对一、按需创建（转为 normal 时才有）；软删除不删调度行，回收站恢复即复习进度原样回来 |
| `review_log` | 复习记录，字段对齐 ts-fsrs 的 `ReviewLog`，可直接喂 FSRS 参数优化器；评语不入库（一次性反馈），只有 rating 四档入库 |
| `glossary` | 已彻底掌握的术语，全局用户模型。无任何外键——挂上主题或来源它就退化成局部数据；内容不注入上下文，全局 AGENTS.md 引导模型按需自查 |
| `user_env` | 用户环境变量（ADR-0034）：key 主键、值明文存储明文回显；后端启动与每次保存都写 `process.env`，Pi bash 工具每次 spawn 复制环境，skill 子进程立即拿到新值 |
| `setting` | 业务运行设置：`reminder_interval_turns` 与四段提醒文案，缺行取代码出厂值，与 Pi 自己的 settings.json 无关 |
| `user` | 单用户认证（scrypt） |

关键设计取舍：

- **软删除不级联 `review_log`**：已删卡的复习记录仍是 FSRS 优化有效样本；物理删除只在清空回收站时发生。
- **两个 type 字段不建外键**：`space.type`（会话属于哪类）与 `agents_md.type`（模板适用于哪类）是不同概念，取值恰好对应而已。
- **模板正文存库、投影成文件**：`AGENTS.md` / `style.md` 是数据库的投影，开对话时整份覆盖写进 `work_path`；想知道某次对话当时用的哪套模板查 `pi_session.agents_md_id`，文件会被后续对话覆盖，外键不会。
- **幂等迁移**：schema 变更（如 ADR-0039 删 `card.source_essence_path` 列）写成「列存在才删」的幂等语句，旧库升级不动行数据。
- **时间列统一 SQLite 空格分隔格式**（`datetime('now')`），ts-fsrs 直接消费，不存 ISO 串。

## 运行时目录设计

容器内完全遵循 Pi 的约定（root 用户，`~` = `/root`），代码里没有任何容器专用路径；宿主机上放哪由 compose 的 `HOST_PI_TEACHER_HOME` / `HOST_PI_AGENT_DIR` 决定。

### `~/pi-teacher/` —— 业务数据

```
~/pi-teacher/
├── AGENTS.md               ← 全局规则（资料库说明、工具调用原则、制卡规则）
├── USER.md                 ← 全局用户偏好（用户手写 / 设置页编辑）
├── data/                   ← SQLite 数据库（含 WAL 文件）
├── materials/              ← 全局资料库（三种会话共用）
│   ├── index.md            ← 索引，模型自己维护
│   └── origins/            ← 排版混乱、待整理的原件
├── assets/                 ← 跨会话复用的样式、图表工具、HTML 模板
├── llm-text-to-img/        ← AI 生成的图片
├── learn/<space_id>/pi/<pi_session_id>/    ← 每条学习会话一个独立目录
│   ├── AGENTS.md           ← 本次对话选定的模板投影
│   ├── style.md            ← 教学风格投影
│   ├── pi-session-user.md  ← 会话级偏好，模型自行维护，程序不读不写
│   ├── files/              ← 用户上传给本会话的原始文件（待阅读判断的输入）
│   ├── essence/            ← 学习精华（仅学习会话默认建空目录）
│   └── *.jsonl             ← Pi 会话历史
├── review/pi/<pi_session_id>/              ← 复习会话（同构，无 essence）
└── ta/pi/<pi_session_id>/                  ← 助教会话（无 style.md）
```

三条铁律：

1. **目录名即数据库 id**：`learn/2/pi/42/` = learn Space 2 的 pi_session 42。删除会话只删数据库行与 JSONL，目录与其余产出保留（ADR-0037）。
2. **资料分流由模型执行，程序不代办**（ADR-0039）：上传先落会话 `files/`，模型阅读判断后移入全局 `materials/`；混乱原件进 `origins/`；程序不自动搬移、不自动归档。
3. **AGENTS.md 由 Pi 祖先遍历自动拼接**：`~/pi-teacher/AGENTS.md`（全局）+ `<work_path>/AGENTS.md`（本次对话），无需程序干预。

### `~/.pi/agent/` —— Pi 配置

```
~/.pi/agent/
├── models.json             ← 供应商与 API Key（Pi 的格式，本应用不生成）
├── settings.json           ← Pi 的默认模型设置
└── skills/                 ← skill 发现目录：内置 skill 每次启动由入口脚本覆盖；用户自建目录不碰
```

### 用户偏好的三层注入

| 层 | 文件 | 进上下文的方式 |
| --- | --- | --- |
| 全局 | `~/pi-teacher/USER.md` | 开会话时读一次 |
| 风格 | `<work_path>/style.md` | 同上，与 USER.md 合并成一段 `appendSystemPrompt` |
| 会话级 | `<work_path>/pi-session-user.md` | 程序不读不写，只在注入段固定加一句引导；维护提醒（每 30 轮默认）让模型自行更新它 |

优先级会话级 > 风格 > 全局。每轮动态状态（到期卡数、制卡开关）由 `context` 钩子以 custom 消息注入，不落 JSONL、不受压缩影响。

## 本地开发

```bash
cd server && npm install
npm run dev                 # 后端，默认端口 39871，数据目录由 PI_TEACHER_HOME 指定

cd web && npm install
npm run dev                 # 前端 Vite，代理到后端
```

### 验证命令矩阵（在 `server/` 下运行）

验证不是单元测试——全部走真实 SQLite、真实 Pi SDK、真实模型；需要隔离时用临时目录，不引入 mock。

| 命令 | 覆盖 |
| --- | --- |
| `npm run verify:schema` | schema 约束、触发器、旧库删列迁移、学习精华目录边界 |
| `npm run verify:config` | models.json 脱敏、三态写入、原子替换（用临时 agent 目录，不碰真实 `~/.pi`） |
| `npm run verify:attachments` | 附件落盘与读取边界 |
| `npm run verify:lifecycle` | 会话生命周期、空闲回收、助教常驻 |
| `npm run smoke` / `npm run verify` | 工具层冒烟 / 真模型端到端 |
| `npm run http-smoke` | 起真实后端跑完整 HTTP 面 |
| `PI_TEACHER_BASE_URL=… npm run verify:remote` | 对已运行实例（容器或别机）只走 HTTP 的验收，含真模型与 skill 挂载 |

改动涉及哪一层就跑对应脚本；改桥接层或工具时至少跑 `verify:lifecycle` 与 `http-smoke`；改内置 skill 需重建镜像才进容器。

### 工程约束

- secret（API key、header 值）只在 `server/src/config/pi-config.ts` 内处理，出口一律折叠为布尔或 `SECRET_MASK`；日志、测试输出、错误响应、commit 同样不含 secret。例外：`user_env` 表明文存储明文回显（ADR-0034），日志只打 key 名。
- 写用户配置文件一律临时文件 + 原子替换。

