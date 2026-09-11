# Pi Teacher

基于 Pi Coding Agent SDK 的 Web 学习助手：用多种教学风格讲解资料、制卡、按 FSRS 复习。领域语言以 `docs/CONTEXT.md` 为准（Space / Pi Session / Agents Md / Teach Style / Briefing），文档与代码里的命名跟随它。

## 目录结构

```
pi-teacher/
  CLAUDE.md                     ← 本文件；根目录只放它，其余文档一律进 docs/
  server/                       ← Express 5 后端宿主（Node 24 ESM，NodeNext，tsx 直跑）
    src/index.ts                ← 启动入口：homeDir、端口、env 同步
    src/bridge/                 ← Pi SDK 桥接：AgentSessionWrapper（准入串行化、空闲回收）
    src/session/                ← 会话仓储、附件、模型目录、标题生成
    src/tools/                  ← Pi 插件工厂 + 15 个业务工具（card_/topic_/glossary_/review_/md_/file_）
    src/projection/             ← 开会话时把 agents_md / teach_style 投影为工作目录文件
    src/db/ src/fsrs/           ← better-sqlite3 schema 与 ts-fsrs 调度
    src/routes/ src/auth/       ← HTTP 形状与单用户密码鉴权
    src/config/                 ← models.json / settings.json 脱敏读写、homeDir 下 Markdown、用户环境变量（user_env 表 → process.env）、业务设置（setting 表）
    src/prompts/defaults.ts     ← 全部出厂提示词常量：全局 AGENTS.md、agents_md / teach_style 模板、基础三段 + 学习精华提醒；调提示词只改这一个文件
    src/verify/                 ← 真环境验证脚本（不是单元测试，见下文）
  web/                          ← React 19 + Vite 7 + Tailwind v4 前端
    src/api/ src/app/ src/chat/ src/settings/ src/sidebar/ src/aside/ src/ui/ src/lib/
  docs/
    CONTEXT.md                  ← 领域语言（术语唯一出处）
    数据库与目录结构设计.md      ← Schema 快照 + ~/pi-teacher/ 目录布局，实现以此为准
    adr/                        ← 决策记录 0001–0039（0002 已被 0013 取代并删除），冲突时以编号大者为准
    tasks/TODO.md               ← 阶段状态与待办；tasks/*.md 为各阶段 PRD
    spec.md                     ← 踩坑经验库（只 grep `### ` 标题，禁止整读）
    工具定义.md                  ← 15 个工具的签名、可见性矩阵、返回形态
    前端模板/                    ← 设计稿与配色（改视觉前看 DESIGN.md）
    THIRD-PARTY-NOTICES.md      ← 自 pi-web 移植代码的许可声明
    deploy.md                   ← Docker 部署：挂载变量、内置 skill 覆盖规则、升级、备份、常见错误
  Dockerfile / docker-entrypoint.sh / compose.yaml
                                ← 容器内完全按 Pi 约定（~/pi-teacher、~/.pi/agent、~/.pi/agent/skills）；宿主路径由 HOST_* 变量决定，默认 ./pi-teacher 与 ./pi-agent
  skills/                       ← 内置 skill（当前仅 tavily-search）：COPY 进镜像，entrypoint 每次启动覆盖进 ~/.pi/agent/skills 同名目录
```

## 常用命令

```bash
cd server && npm run dev            # 后端，默认端口 39871；PI_TEACHER_HOME 指定数据目录
cd web && npm run dev               # 前端 Vite，代理到后端；PI_TEACHER_API_PORT 可改代理目标端口
cd server && npm run typecheck      # 后端类型检查
cd web && npm run build             # 前端 typecheck + 构建（typecheck 单独跑用 npm run typecheck）
docker compose build && docker compose up -d   # 容器部署；docker compose stop 走 SIGTERM 优雅关会话（docs/deploy.md）
```

验证脚本全部走真实 SQLite / 真实 Pi SDK / 真实模型，在 `server/` 下运行：

| 命令 | 覆盖 |
| --- | --- |
| `npm run verify:schema` | schema 约束、触发器、旧库删列迁移与学习精华目录边界 |
| `npm run verify:config` | models.json 脱敏、三态写入、原子替换（临时 agent 目录，不碰真实 ~/.pi） |
| `npm run verify:attachments` | 附件落盘与读取边界 |
| `npm run verify:lifecycle` | 会话生命周期、空闲回收（`PI_TEACHER_IDLE_TIMEOUT_MS` 调到秒级） |
| `npm run smoke` / `npm run verify` | 工具层 / 真模型端到端 |
| `npm run http-smoke` | 起真实后端跑 HTTP 面 |
| `PI_TEACHER_BASE_URL=… npm run verify:remote` | 对已运行实例（容器或别机）只走 HTTP 的验收，含真模型与 skill 挂载 |

改动涉及哪一层就跑对应脚本；改桥接层或工具时至少跑 `verify:lifecycle` 与 `http-smoke`。

## 技术事实（已核实，直接引用）

- Pi SDK 锁定 **0.84.2**，工具注册走 `extensionFactories`（`createAgentSessionServices({ resourceLoaderOptions: { extensionFactories } })`），工厂内 `pi.registerTool(defineTool(...))`。
- 工具名只允许 `^[a-zA-Z0-9_-]{1,128}$`，用下划线前缀分组；参数 schema 用 `typebox` 1.3.7 拆分包写法（`import { Type } from "typebox"`）。
- 提示词分层（ADR-0033）：全局与工作目录 `AGENTS.md` 由 Pi 祖先遍历自动发现；全局 `USER.md` + 会话 `style.md` 开会话时读一次合并经 `appendSystemPrompt` 追加，末尾固定引导模型自行维护 `pi-session-user.md`（程序不读不写）；每轮状态由 `context` 钩子以 `<pi-teacher-context>` custom 消息注入，不落 JSONL。出厂文案全在 `server/src/prompts/defaults.ts`：全局 `AGENTS.md` 只在文件缺失时写一次（之后是用户的文件），模板只在表里没有时 seed。维护提醒（ADR-0036 / ADR-0039）为三段基础文案 + `learningEssence` 学习专属追加段，均存 `setting`、缺行即出厂值、设置页可改；共用 `reminder_interval_turns`，只有学习会话同轮追加精华段，制卡开 / 关均适用。
- 资料与精华（ADR-0039）：上传先入会话 `files/`，模型按全局提示词判断并分流至 `materials/` 或 `materials/origins/` 后整理，程序不自动搬移或维护索引。仅学习会话新建 / 正常打开时幂等补 `essence/` 空目录，助教与复习不创建、已有产出不删；卡片不再保存精华来源路径，旧库仅幂等删列。
- 教学风格切换 = 改数据库 + 重新投影 + 按稳定 ID 重载会话（ADR-0031）；会话级工具开关必须从数据库现读，闭包快照会得到假开关。
- FSRS：`learning_steps: []`、`relearning_steps: []`，一卡一天最多出现一次；时间列统一 SQLite 空格分隔格式（`dateToSqliteText()`），不能存 ISO 串。
- 学习 / 复习会话空闲 10 分钟回收；固定助教按 ADR-0035 常驻、只随 SIGTERM 关闭（`resident` 选项，`registerSignalHandlers()` 只在 `startServer` 里注册）；`PI_TEACHER_PROVIDER` / `PI_TEACHER_MODEL` 设定后默认模型不可在界面修改（compose 传入空串视同未设置）。
- 用户环境变量（ADR-0034）：`user_env` 表是唯一源，后端启动与每次保存都写进自己的 `process.env`；Pi 的 bash 工具每次 spawn 都复制当前 `process.env`，所以 skill 子进程立即拿到新值，不用重开会话。容器 env 与旧 `~/pi-teacher/.env` 只在 key 尚不在表里时首次导入一次，之后不再读；没有 `.env` 文件也没有 `env-sync`。

## 编码约束

- 这是已有 MVP 的细节打磨：桥接层与会话架构只做增量修改，需要改结构先与用户确认。
- 验证只用真实数据与真实模型；需要隔离时用临时目录（参考 `verify/config-check.ts` 的做法），不引入 mock DB / fake attachment / 假模型结果。
- secret（API key、`$ENV` / `!command` 引用、header 值）只在 `server/src/config/pi-config.ts` 内处理，出口一律折叠为布尔或 `SECRET_MASK`；日志、测试输出、错误响应、commit 同样不含 secret。`user_env` 表的值不属于这条边界：明文存、明文回显（ADR-0034），只有日志仍只打 key 名。
- 写用户配置文件一律临时文件 + 原子替换，校验失败保持原文件字节与权限不变。
- 端口探测用 `ss -lptn 'sport = :PORT'`，停后台服务用 `kill %1` 或记录的 PID；后台起服务用 `(setsid cmd &)`。
- 已有用户修改与 docs 下被 staged 删除的外部设计文档保持原状，不恢复不覆盖；开发阶段不写 README，新文档放 `docs/` 而不是根目录。
- 未经用户明确要求不 commit、不 push。
- 子代理统一用 `haiku`。

## 什么时候读哪份文档

| 场景 | 读 |
| --- | --- |
| 开始新阶段任务前 | `docs/tasks/TODO.md` 看当前状态，再读对应 PRD |
| 碰到奇怪的行为、准备写测试断言、起停服务前 | `grep -n "^### " docs/spec.md` 找标题，再读命中段落 |
| 改 schema、改 ~/pi-teacher 目录布局 | `docs/数据库与目录结构设计.md` |
| 实现或改工具签名 / 可见性 | `docs/工具定义.md` |
| 疑问某个约定为何如此 | `docs/adr/` 对应编号；0027（不用 MCP）、0028（不替换默认 system prompt）、0030（工作目录归属）、0031（风格切换）、0033（提示词四层来源）、0034（用户环境变量）、0035–0038（助教常驻与清除、维护提醒、真删除、`files/`）、0039（资料归档与学习精华、卡片解耦）最常用 |
| 改前端视觉 | `docs/前端模板/DESIGN.md`；Tailwind v4 用 `@utility`，不用 `@layer components` |
| 浏览器验收 | `docs/spec.md` 的「agent-browser 真浏览器验收的几个非直觉点」与「浏览器验收不知道真实账号密码」（隔离环境起法） |

## 任务收尾

更新 `docs/tasks/TODO.md`；把不易复现的问题（原因、触发条件、解法）以 `### 标题` 追加到 `docs/spec.md`；决策变更写新 ADR 并在被取代的 ADR 顶部加状态行。写完中文文件后用 `grep -rn $'\\xef\\xbf\\xbd'` 检查替换字符乱码。
