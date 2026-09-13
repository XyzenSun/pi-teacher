# TODO

## 本阶段：两个新任务立项（2026-09-13，待实施）

**prompt-and-skill-polish（提示词优化与 skill 完善）**：PRD 见 `prompt-and-skill-polish.md`。两个子目标：① sbx 源码从上游 `sandbox-cli` 仓库转入 `skills/sbx/sourcecode/`，**权威转移**（用户已定：上游归档，本仓库成为唯一源），分发保持 esbuild 单文件 node cli，决策记 ADR-0043 并给 ADR-0040 补状态行；② 提示词优化——**围绕使用痛点**（用户已定范围，痛点清单待用户补充），提示词面为 `defaults.ts` 六类常量 + 五个 SKILL.md，每条痛点定位到具体提示词段、改点确认后再动手。

**logging-system（日志系统）**：PRD 见 `logging-system.md`。已定约束：第三方库、统一输出到 stderr（「stdr」所指待确认）、debug / info / warn / error 四等级；库选型、格式、等级开关、HTTP 访问日志扩面与否等待商量清单共 7 项，实施前与用户逐项过。

## 上一阶段：模型目录脱节与高级设置白屏修复（已完成，WebUI 用户验收通过）

**model-catalog-fingerprint（2026-09-12）**：两个前端 bug 的根因均在后端，已修复并重启 dev 后端（端口 39871），**用户 WebUI 验收通过**（模型选择器恢复、高级设置正常）。

- **`/api/models` 503 → 对话框「未配置模型」**：`getModelCatalog()` 是进程级单例，原本只在界面内保存配置时 refresh；用户用 pi CLI 升级（0.84.2→0.85.1 迁移产生 `.bak`）与手动编辑改了 `~/.pi/agent/models.json`（provider 改名扩模型）与 `settings.json`（设默认模型）后，运行中的后端永远拿着旧快照——`selectDefaultModel` 现读 settings 要新组合、旧快照里找不到 → 503；而设置页 `/api/config/models` 现读文件显示已配置，两个接口数据源脱节。修复：`session/models.ts` 加 models.json+auth.json 的 (mtimeMs,size) 指纹检测，`getModelCatalog()` 发现磁盘变化自动 `refresh({ allowNetwork: false })`（重载失败退回旧目录）；`refreshModelCatalog()` 排队双检避免并发重复刷新。
- **GET /api/models 降级**：默认模型不可用时不再整接口 503（用户连可用模型都看不到），改为列表照常返回 + `defaultModel: null`（前端已支持该形态）；开会话路径（agent-session-wrapper）保持抛 503——不能静默换模型开课。
- **高级设置白屏**：后端进程是 Sep10 启动的旧代码（`setting` 表与 `/api/config/settings` 的 `app` 字段都是 `97dd87c` Sep11 才落地），Vite 前端热更新是新代码，`settings.app.reminderIntervalTurns` 上 TypeError → 无 ErrorBoundary → 整页白屏；其他 tab 不依赖 `app` 所以正常。修复：重启后端（新代码幂等补建 `setting` 表，实测已补、admin 账号保留）+ 前端新增顶层 `ErrorBoundary`（`web/src/ui/ErrorBoundary.tsx`），未来渲染错误显示可读错误页而非白屏。
- 验证：后端 typecheck、`verify:catalog`（新增，12/0：指纹检测自动重载、auth.json 变化、显式刷新、503 语义、路由层降级）、`verify:config` 108/0（顺手修复 BUILTIN_USER_ENV 扩到 13 项后硬编码期望过期的既有失败断言，改为动态构造）、`verify:lifecycle` 18/0、`http-smoke` 522/0（octopus / deepseek-normal-latest）、前端 build 通过；踩坑（setsid 残留进程写覆盖日志造成假失败）记入 spec.md。修复代码已随 commit `0ec44f9` 推送。
- 后续（同日）：根 CLAUDE.md 改名为 AGENTS.md（pi 项目上下文标准名）并按 edit-agents-md 审查修订 6 处过时项（目录结构行、ADR 编号到 0042、文档表补 0040–0042、技术事实补模型目录指纹检测与 /api/models 降级、编码约束精简历史句与补 setsid 日志坑），删除旧 CLAUDE.md 避免双份漂移；已随 commit `ea091c1` 推送。
- 分支结构（同日）：仓库双分支化——`dev-codeup`（原 main 改名，推 codeup 私有仓，主开发分支，含全部历史与 docs/）与 `main`（孤儿分支开源快照，推 GitHub `XyzenSun/pi-teacher`，基于原 LICENSE 提交 `b1fc6ad` 叠加 `init: open-source`，共 151 文件）。开源排除项写入 main 分支的 .gitignore：`/docs/`、`/.claude/`、`/AGENTS.md`、`/CLAUDE.md`、`/skills/sbx/sourcecode/README.md`（含 codeup 上游地址，仅私有分支保留）；`doc-for-dev/README.md` 开源但已修正 2 处对私有 docs/ 的引用。codeup 上旧 main 分支保留未删（默认分支需网页切换）。同步方式：dev-codeup 开发，cherry-pick 到 main 推 GitHub；skills 目录确认无任何嵌套 .git；AGENTS.md 已写入分支模型一节（commit `39261ae`）。

## 上一阶段：tingwu-transcribe 接入为第五个内置 skill（已实现，待容器验收）

**tingwu-transcribe（2026-09-12）**：决策见 ADR-0042。上游已改版为 skill 形态（`scripts/cli.js` 纯命令行入口 + 零第三方依赖），「必须常驻网关」这一阻塞点消失，**原样接入、一行不改**；接入时仅删除随目录带来的 `.git`。两个已知取舍经用户确认接受：① 登录 Cookie 默认落在 skill 目录内，容器重启 / 升级镜像后需重新设置（Cookie 本来就会过期、失效时 CLI 明确提示 `COOKIE_INVALID`；要跨重启保留可设 `TW_COOKIE_FILE` 指向挂载卷，已写进 deploy.md）；② `server.js` 默认 `0.0.0.0:8787` 无鉴权，但容器未 EXPOSE 该端口且不自启动，风险被容器边界隔离。不走 `user_env` 表——Cookie 需要程序验证后回写，与人工维护的配置表语义不符。验证：宿主与容器内 `cli.js` help / `cookie check`（`COOKIE_MISSING`，退出码 1）/ 假 Cookie 真实打到听悟返回 `CMN.NotLogin` 且不落盘；`.dockerignore` 的 `*.md` 只匹配根目录，`SKILL.md` 与 `references/` 实测完整进镜像。待做：重建镜像 → 更新验证容器 → `verify:remote`（skill 探针是否扩到五个待定）。

## 上一阶段：tavily-search Node 重写（仓库 Go 归零）已部署到验证容器，待用户 WebUI 验收

**tavily-search-node-rewrite（2026-09-12）**：PRD 见 `tavily-search-node-rewrite.md`，决策见 ADR-0041（取代 ADR-0040「tavily-search 保持 Go 不动」一句）。最后一个 Go skill 换成零依赖 Node 单文件（12638 字节，ESM，与 `pullpage` 同范式），`sourcecode/` 整目录删除，**仓库内 `*.go` 归零**。有意的行为变更只有两处：缺 key 报错指向设置页（旧版让用户复制 `.env.example`，与 ADR-0034 相悖且容器里无该文件）、移除 `--env-file`（文档本就明令不要传；实测 Node 24 还会截获脚本后的 `--env-file` 参数并 exit 9，三个 Node skill 一致）。21 项功能直测全过（真 key 真调用：markdown 渲染、`--include-answer` 的 `## Answer` 段、参数在 query 前后、`--json`/`--pretty`、重复 `--include-domain` 真实限定结果、`--include-raw-content` 的 `<details>` 折叠、`.env` 兜底与环境变量优先、非法 timeout / max-results 报错文案与 Go 版一致）。`BUILTIN_USER_ENV` 的 `TAVILY_TIMEOUT` 描述去「Go duration」字样；`SKILL.md` 删 Pi 不解析的 `allowed-tools`；`references/advanced-cli.md` 同步。验证：typecheck 通过、`http-smoke` **522/0/0**（换 octopus / deepseek-normal-latest 后一次过）；镜像重建后 `/app/skills` 由 13M 降到 **4.9M**，备份 117M → `up -d`，`verify:remote` **51 通过 / 0 失败**（四个 skill 全部由真模型在容器内跑通）。代码与文档已随 commit `7dc02b7` 推送到 `origin/main`。浏览器由用户在验证容器（端口 39873）上验收。

## 上一阶段：内置 skill 接入（pullpage / exa-search / sbx）已部署到验证容器，待用户 WebUI 验收

**skills-integration（2026-09-12）**：PRD 见 `skills-integration.md`，决策见 ADR-0040。`skills/` 从 1 个扩到 4 个：`pullpage`（单 URL 抓取，四家自动回退）与 `exa-search`（Exa 搜索 / 问答）由上游 Go 重写为**零依赖 Node 单文件**（复用镜像 Node 24，不装 Go 工具链、不存编译产物；`pullpage` 上游只读 `.env` 不读环境变量，本就必须改才能配合 ADR-0034），`sbx`（三家云沙箱）以 esbuild 4.4M 单文件分发（`npm i` 445M、`npx` 首拉 286 秒且缓存不持久，均否决）。沙箱载体由「插件」（ADR-0015 / 0027）改为 skill。`BUILTIN_USER_ENV` 新增 10 项，`EXA_*` 等共用变量按服务命名；`pullpage` 反代变量统一 `*_BASE_URL`。提示词不动——Pi 自动把 `SKILL.md` 的 name / description 注入 `<available_skills>`。验证：后端 typecheck 通过、`http-smoke` 522/0/0、宿主机直测全过（缺 key 文案指向设置页、环境变量优先、假 key 打到平台 401、`--provider all` 与布尔参数正确）；镜像重建后按 `deploy.md` 停止 → 备份 112M → `up -d` 更新验证容器（`pi-teacher-verify`，端口 39873），entrypoint 同步四个内置 skill 且用户自建 skill 未被触碰、`.env` 未进镜像，`verify:remote` **51 通过、0 失败**（含真模型在容器里跑通四个 skill 命令）。`外部资源/` 三个原目录已删（tingwu 保留），删前 tar 归档到宿主机 `/tmp`。**本阶段尚未 commit**；浏览器由用户在该容器上验收。

## 上一阶段：资料归档与学习精华已部署到验证容器，待用户 WebUI 验收

**materials-and-learning-essence（2026-09-11）**：PRD 见 `materials-and-learning-essence.md`，决策见 ADR-0039。全局资料分流规范、学习专属空 `essence/` 与同轮提醒、第四段可编辑文案、卡片来源字段移除及旧库迁移均已落地；代码与根 `CLAUDE.md` 审查通过。`http-smoke` 的自动标题 payload 误判已修正，完整重跑 **522 通过、0 失败、0 跳过**，后端 typecheck 同轮通过。`verify` 本次 27 通过、1 失败（模型把全局偏好写进会话文件），按用户决定不再追测，保留失败记录，不记为通过。ADR-0033–0039 与 Docker 部署已随 commit `97dd87c` 推送到 `origin/main`；镜像 `pi-teacher:local` 已重建，隔离验证容器（`pi-teacher-verify`，端口 39873）按 `deploy.md` 流程停止 → 备份 → `up -d` 更新：旧库 `card.source_essence_path` 已自动删列，账号、会话、`user_env` 保留，`verify:remote` **49 通过、0 失败**（含真模型跑 skill）。浏览器由用户在该容器上验收。

以下保留前阶段进度记录；各轮测试数字仅代表当轮结果。

**user-env-in-database（2026-09-10 实现）**：ADR-0034，PRD 见 `user-env-in-database.md`。`user_env` 表取代 `~/pi-teacher/.env` 与 `env-sync.ts`：`server/src/config/user-env.ts` 负责列表 / 补丁 / 删除 / 启动引导（容器 env 与旧 `.env` 只在 key 尚不在表里时首次导入一次），保存后立即写 `process.env`，Pi bash 工具每次 spawn 复制 `process.env`，skill 子进程无需重开会话即拿到新值；值**明文存储、明文回显**（用户审核后去掉了最初实现的隐藏值 / 掩码，旧表的 `secret` 列由幂等迁移删除）；`GET/PATCH /api/config/user-env`、`DELETE /api/config/user-env/:key`；「高级配置」Tab 末尾「用户环境变量」section（`UserEnvSection.tsx`：内置 `TAVILY_*` 三项 + 用户自加项、行内编辑、`ConfirmDialog` 清除 / 删除）；`skills/tavily-search` 文档改为「后端注入、不带 `--env-file`、缺 key 让用户去设置页」。验证面：`verify:config` 103/0（新增第 8 节，含 secret 列迁移）、`http-smoke` 309/0（新增 [8b]，含真模型 `echo $TAVILY_TIMEOUT` 读到刚保存的值）、`smoke` 88/0、`verify` 28/0、`verify:schema` 71/0、`verify:attachments` 116/0、`verify:lifecycle` 15/0；隔离环境真浏览器验收通过。

**global-layout-prompt-layering（2026-09-09 立项，2026-09-10 实现）**：ADR-0033。已完成：`seed.ts` 幂等补建全局布局；`system-prompt-builder.ts` 合并 `USER.md` + `style.md` 并附会话级引导；`GET/PUT /api/config/user-preferences` + 「用户偏好」Tab；`GET/PUT /api/config/global-agents-md` + Agents Md Tab 顶部的全局 AGENTS.md 编辑器；默认模板去重；`verify:config` 四态断言、`http-smoke` API 节、`run-real` 真模型验证会话级偏好行为。原立项说明：PRD 见 `global-layout-prompt-layering.md`。基线 commit `d10ea07`。补建 `数据库与目录结构设计.md` 定义但从未创建的 `~/pi-teacher/` 全局文件（`AGENTS.md`、`USER.md`、`materials/`、`assets/`、`llm-text-to-img/`）；全局 `USER.md` + 会话 `style.md` 经 `appendSystemPrompt` 固定段落注入，段落里引导模型自行维护会话级 `pi-session-user.md`；设置面板新增「用户偏好」Tab。

**仓库整理（2026-09-09，本轮）**：删除冻结脚手架 `tools-dev/server/`、过时 `README.md`、空文件 `docs/助教设计.md`、残稿 `提示词设计/提示词追加位置.md`；`tools-dev/tasks/` → `docs/tasks/`，`tools-dev/doc/spec.md` → `docs/spec.md`；根 `todo.md` 合并入本文件；新增根 `CLAUDE.md`；全部文档（`CONTEXT.md`、`数据库与目录结构设计.md`、`提示词设计/`、`前端模板/`、`THIRD-PARTY-NOTICES.md`）收进 `docs/`，根目录只留 `CLAUDE.md`。

**下一轮待做**：8 组同一决策在多份文档重复书写（Teach Style 可切换、space→pi_session、glossary 不注入、materials 自读自写、镜像无 Python、四档 Rating、复习节奏、角色声明位置），各只保留 ADR 权威版本，其余改为一句引用。

## 上一阶段：预生产准备（2026-09-10 立项，历史说明）

六项均已落地：助教常驻与清除、周期维护提醒、会话真删除、`files/` 及 Docker 部署文件。镜像已包含资料精华阶段代码并在隔离容器上通过 `verify:remote`（见上）。部署的最终形态以 `docs/deploy.md` 为准：Node 24、tsx、容器 root、两个默认相对路径挂载，内置 skill 随镜像覆盖同名目录，出厂提示词集中在 `prompts/defaults.ts`，全局 AGENTS.md 不入库，提醒文案存 `setting`。

**以下六项保留立项快照，不代表当前实现仍缺失。** 原 PRD 见 `preproduction-readiness.md`；ADR-0035–0038 记录定稿，ADR-0039 进一步细化资料与精华职责，早期「待确认」和提示词文档路径不再作为当前实施依据。

### 1. 助教 Pi Session 长期存活，不走空闲回收

- 现状：`AgentSessionWrapper.resetIdleTimer()`（`server/src/bridge/agent-session-wrapper.ts`）对所有会话一视同仁，10 分钟无活动即 `shutdown()`，固定助教（`space_type = "ta"`，唯一一条）也会被回收，用户再打开要等重建。
- 目标：助教在后端进程生命周期内常驻——启动即打开（或首次访问后不再回收），只有 SIGTERM 优雅退出时才关闭；学习 / 复习会话维持现有回收策略。
- 实现要点：回收策略按 Pi Session 类型分流，而不是全局关掉计时器；`startWorkspaceSession` 传入「常驻」选项，`resetIdleTimer` 对常驻会话直接返回；`/close` 对助教改为无操作或 400（界面上助教不该有「关闭」）。
- 验证：`verify:lifecycle` 加一节，把 `PI_TEACHER_IDLE_TIMEOUT_MS` 调到秒级，断言学习会话被回收、助教仍 `isAlive()`；`http-smoke` [7] / [9] 相应调整（[9] 用的是学习会话，应不受影响）。
- 决策记录：新 ADR（助教常驻的理由：它是跨对话入口，冷启动成本直接落在每次点开；内存代价只有一条会话）。

### 2. 周期性维护提醒：按轮次直接追加在用户消息后

- 现状（已核实）：`context` 钩子每轮只注入状态（活动 / 到期卡数 / 制卡开关）；`appendSystemPrompt` 固定段只在会话开始说一次 `pi-session-user.md` 的读写规则；全局 `USER.md` 谁写、何时写没有任何机制，全靠模型自觉。属于 MVP 实现。
- 设计（用户定稿，不走 custom 消息、不做异步）：在 `POST /:id/command` 组装 prompt 时判断 `当前轮次 % N === 0`（轮次 = 本会话 user 消息数 + 1，从会话历史现数，不另存计数器），命中就把提醒**直接拼在用户消息末尾**：
  - `学习 / 复习 && 制卡开`：`<system-reminder>已与用户对话多轮，可以考虑更新用户偏好、用户信息与制卡。如果当前会话下用户针对本次会话提出了要求，而不是全局性要求你以后在其他任务也这么做，更新到 pi-session-user.md。此消息为系统提醒，如果你认为不需要维护，在回复用户时无需提及本消息</system-reminder>`
  - `学习 / 复习 && 制卡关`：同上去掉「与制卡」
  - `助教`：`<system-reminder>已与用户对话多轮，可以考虑更新用户对你的要求，更新到 pi-session-user.md。此消息为系统提醒，如果你认为不需要维护，在回复用户时无需提及本消息</system-reminder>`（助教不维护全局用户偏好 / 用户信息）
  - 提醒文案放 `docs/提示词设计/` 模板文件由程序读取，便于调词；`N` 做配置项：新建 `setting(key TEXT PRIMARY KEY, value TEXT)` 表（业务运行设置，与 Pi 的 `settings.json` 无关），键 `reminder_interval_turns`，默认 30，`GET/PATCH /api/config/settings` 扩一个字段、「高级配置」Tab 加输入框；`schema-check` 的 `BUSINESS_TABLES` 加 `setting`
- 实现要点：拼接发生在后端，不改桥接层；提醒直接进用户消息，会落 JSONL、在历史里**保持可见**（用户定稿，不折叠不隐藏）。
- 验证：`http-smoke` 断言第 N 轮的 provider payload 用户消息末尾含提醒、第 N+1 轮不含（沿用 `payloadHasNonAssistantEnvelope` 思路），三种文案按类型 / 开关各命中一次；真模型不做行为断言（是否维护由模型判断，本就允许不写）。
- 决策记录：新 ADR「维护提醒按轮次直接追加在用户消息后，判断在程序、内容由模型决定」。

### 3. 助教简化：去掉 style.md，加「清除上下文」

- 观点（用户定稿）：助教的本意是解答疑惑，上下文与记忆不重要；为它做风格投影、记忆维护是反模式。`数据库与目录结构设计.md` 目录树里助教目录已删掉 `style.md`（本地未提交改动）。
- 现状（已核实）：`projectTeachStyle` 对助教同样写空 `style.md`（真实 `~/pi-teacher/ta/pi/1/` 下存在）；`PATCH /teach-style` 对助教已 403；前端 `SessionControls` 对助教已隐藏风格与制卡控件；`POST /:id/close` 只是回收进程，历史仍在。
- 要做：
  - 助教不再投影 `style.md`（创建 / 重载时按 `space_type` 跳过，已有文件启动时删掉或忽略）；`system-prompt-builder` 对助教只带全局 `USER.md`——按第 2 项，助教也不维护它，是否连读都不读待实现时定，先按「读但不提醒维护」
  - **清除上下文**：`POST /api/conversations/:id/clear`（只允许助教，其余 400）——停掉运行中的 wrapper，删除 `pi_session.path` 指向的 JSONL，重新创建空会话文件（`path` 更新），`work_path` 与其中的 `pi-session-user.md` / 附件保留；不做标记、不做归档。前端助教面板加「清除对话」按钮 + `ConfirmDialog`
  - 与第 1 项（助教常驻）的关系：清除后立即重建并常驻，用户不感知重启
- 验证：`http-smoke` [7] 后加：清除前有历史 → 清除后 `context` 为空、旧 JSONL 不存在、`pi-session-user.md` 仍在、对非助教会话 400；`verify:lifecycle` 断言清除不破坏常驻。

### 4. 会话删除（真删除）

- 现状（已核实）：只有 `DELETE /api/workspaces/:id`（整个学习 Space 连同其 Pi Session 行一起删，文件全保留）；单条 Pi Session 没有删除接口；`pi_session` 有 `path`（JSONL）与 `work_path`（工作目录）两列。
- 设计（用户定稿）：`DELETE /api/conversations/:id` = 删除数据库记录 + 删除 `path` 指向的 JSONL 文件；**不删 `work_path`**（学习产出保留）；不做软删除、不做回收站、不做标记。固定助教不可删（403，用第 3 项的清除）；运行中先 abort + shutdown 再删，与 Space 删除一致。
- 实现要点：`card` 等表不引用 `pi_session`（卡片归 Topic），删行无级联顾虑；`review_log` 同理；前端左树对话行加「删除」入口 + `ConfirmDialog`（文案写明「聊天记录删除，工作目录文件保留」），删除当前打开的对话时跳回 Space 列表。`DELETE /workspaces/:id`（用户定稿）：删除该 Space 下全部 `pi_session` 行 + 各自 `path` 指向的 JSONL，同样不删 `work_path`。
- 不做软删除（已核实）：`pi_session.id` 是 `AUTOINCREMENT`，`createPiSession` 取 `MAX(sqlite_sequence.seq, MAX(id)) + 1` 分配 id，删掉 42 后新建得到 43，目录是 `learn/2/pi/43/`，旧 `42/` 的 `AGENTS.md` / `style.md` / `pi-session-user.md` 不会被新会话读到（内存库实测：删 42 后 next_id = 43）；目标目录已存在时 `createPiSession` 还会 409 而不是复用。留下的 `work_path` 是孤儿目录，按「不删 workpath」原样保留。
- 验证：`http-smoke` 新节：删除后 GET 404、JSONL 不存在、`work_path` 仍在、助教 403、运行中先停再删。

### 5. 会话工作目录新增 `files/`，非图片附件按路径注入提示词

- 现状（已核实）：上传 API 收任意类型，落在 `work_path/attachments/`（`open-questions.md` 当时的对齐结论）；prompt 时 png/jpeg/gif/webp 作为图片块直接喂模型，**所有**附件已在消息末尾追加 `本轮附件：- attachments/<name>` 列表（`routes/conversations.ts:227`）；前端选择框 `accept="image/*"`，按钮文案「添加图片附件」，粘贴只收图片。设计阶段的目录树（`学习区设计.md` 早期版本）只有 essence / assets / learning-records，**没有** files 目录——用户记忆中的「会话级 files」应在本阶段正式定义。
- 目标：目录层面把「用户上传给本会话的文件」定名为 `<work_path>/files/`（`CONTEXT.md` 增术语，与全局 `materials/` 区分：files 是本会话的输入，materials 是全局资料库）；非图片附件上传后，本轮提示词明确注入「用户上传了 `<文件名>`，路径 `files/<文件名>`」，让模型知道有文件、去哪读；图片仍直接作为图片块发送。文件内容的理解（PDF / 视频 / office）交给后续 skill（document 转 markdown、视频理解），后端不做转换。
- 实现要点：`attachments/` → `files/` 改名（`ATTACHMENTS_DIR_NAME`、`createPiSession` 建目录、file-index 跳过规则、`docs/数据库与目录结构设计.md` 目录树）；已有部署的旧目录做一次性重命名或兼容读取——先与用户确认取舍；注入文案区分图片与非图片（图片已随消息发送，不必再列路径；非图片列文件名 + 相对路径 + 大小）；前端放开 `accept`、改文案、粘贴放开为任意文件；`verify:attachments` 与 `http-smoke` [3]/[4] 同步。
- 决策记录：ADR（目录命名 + 注入形态 + 「后端不做内容转换，交给 skill」）。

### 6. Docker 实现，转预生产

- 现状：仓库里还没有 Dockerfile / compose；后端 `index.ts` 已能托管 `web/dist`（SPA fallback，`http-smoke` [9] 有断言）；`skills/tavily-search/scripts/tavily-search` 是静态链接的 Go 二进制，直接挂载即可；开发机 Node 24.19，ADR-0015 写的基础镜像是 `node:22-slim`——需先核对 `better-sqlite3` / `tsx` 对 Node 22 与 24 的兼容，决定镜像 Node 版本并回写 ADR-0015。
- 约束（ADR-0015 / ADR-0029 / ADR-0034，直接引用）：单一语言运行时 Node，不装 Python；`node:*-slim` 非 alpine；目录挂载不用 named volume：`~/pi-teacher/`（数据库、materials、AGENTS.md、USER.md、会话工作目录）、`~/.pi/agent/`（models.json、settings.json、skills）；用户环境变量已入库，容器 env 只做首次导入，compose 里只需 `PI_TEACHER_HOME`、`PORT`、可选 `PI_TEACHER_PROVIDER` / `PI_TEACHER_MODEL`。
- 交付：多阶段 `Dockerfile`（web 构建 → server 依赖 → 运行镜像，`tsx` 直跑或预编译二选一，需确认）、`compose.yaml`（端口、两个挂载目录、restart 策略、healthcheck 打 `/api/auth/status`）、`.dockerignore`；镜像内以非 root 用户运行时 `~/pi-teacher` 与 `~/.pi` 的 HOME 解析要与 `getAgentDir()` 一致，先核实 Pi 如何定位 agent 目录。
- 验证：真容器起来后跑 `http-smoke` 的 HTTP 面（进程内脚本不适用，需要一个「对已运行实例」的验收入口，可能新增 `verify:remote`）；`skills` 挂载后模型能真实调到 tavily-search；重启容器后会话、卡片、用户环境变量全部保留。
- 文档：部署文档放 `docs/deploy.md`（不写 README，开发完成后再写）；`CLAUDE.md` 常用命令加容器起停；ADR-0015 若改 Node 版本补状态行。

## 本阶段：资料归档与学习精华（2026-09-11 用户定稿并实施）

完整需求、实现位置与用户 WebUI 清单见 `materials-and-learning-essence.md`；决策见 ADR-0039。

- [x] **全局提示词明确 `materials` 操作规范**：上传仍落会话 `files/`，模型阅读后判断正确性与可学习性；规整资料直接移入全局 `materials/`，混乱原件先保留到 `materials/origins/`，整理版本放入资料库并由模型维护索引。规范集中在 `GLOBAL_AGENTS_MD`，没有后端自动归档、转换或质量判断。
- [x] **仅学习默认提供空 `essence/`**：新建与旧学习会话正常打开共用幂等 helper；不全盘扫描，缺历史先拒绝打开，普通文件占用返回 409。助教 / 复习不自动创建，任何已有精华文件保留。
- [x] **仅学习同轮追加精华提醒**：复用 `reminder_interval_turns` 与原轮次，学习制卡开 / 关都追加，助教 / 复习原提醒不变。新增 `learningEssence` 设置项，原三段出厂与自定义文案保留；是否实际维护由模型判断。
- [x] **卡片与精华路径解耦**：移除 `source_essence_path` 与 HTTP / 前端的 `has_source_essence`；真实旧库重复迁移验证保留卡片、调度、复习日志、ID / 自增序列、约束 / 索引与精华文件，无替代绑定。
- [x] **文档与工程验收收尾**：ADR-0039、旧 ADR 状态、领域语言、数据库目录、工具定义、部署与 CLAUDE.md 已同步；schema 100/0、config 108/0、attachments 126/0、smoke 91/0、lifecycle 18/0、前端 build 通过。HTTP 的自动标题请求误判已修正，完整重跑 522/0、0 跳过，后端 typecheck 通过；中文替换字符与本阶段 diff 空白检查通过，隔离配置副本已清理。

`verify` 本轮 27 通过、1 失败：模型把全局偏好误写进 `pi-session-user.md`。按用户决定不再追测，保留原断言与失败记录，不记为通过；浏览器由用户验收。

升级注意：已有 `~/pi-teacher/AGENTS.md` 不自动覆盖，需手工合并新资料规范；原三段自定义提醒不重置，新精华文案缺行即有默认值。容器需重建镜像（验证容器已按此流程升级，生产实例升级时同样先备份）。详见 `docs/deploy.md`。

## 待设计 / 待实现（从根 todo.md 合并，仍有效）

- **FSRS 参数优化**（已定方案）：完全手动触发；后端接口 + 前端按钮；输入 `review_log` 该 Topic 全部序列，输出写回 `topic`；`topic` 需新增 `w` 数组字段（ts-fsrs 权重），目前只有 `request_retention` 与 `maximum_interval`
- **合并卡**（已定方案，`POST /api/cards/merge` 后端已有）：判据归提示词、动作归工具；FSRS 状态复制 `stability` 最低那张旧卡；前端尚无入口
- **复习 rubric 细化**：四档边界（尤其 Hard/Good 分界）等有 `review_log` 数据后回头收紧（ADR-0019）
- **资料获取 skill**：网页抓取已由 `pullpage` 覆盖（ADR-0040），音视频转写已由 `tingwu-transcribe` 覆盖（ADR-0042）；仍缺 yt-dlp 之类的媒体下载（听悟接收本地文件或 URL，但不负责从视频站抓流）；子代理只返回一行摘要（ADR-0016）
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
- [x] 投影/注入：agents_md / teach_style / context 哨兵 / env-sync 启动钩子（env-sync 已于 2026-09-10 被 `user_env` 表取代，ADR-0034）
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

- 生图 skill（沙箱已于 2026-09-12 以 `sbx` skill 接入，见 ADR-0040）
