# PRD：助教常驻与简化、维护提醒、会话删除、files/ 目录、Docker 预生产（preproduction-readiness）

> 基线：user-env-in-database 实现完成（未 commit，`139538f` 之后）。决策见 ADR-0035（助教常驻 / 去 style.md / 清除）、ADR-0036（维护提醒）、ADR-0037（真删除）、ADR-0038（`files/` 与路径注入）；Docker 沿用 ADR-0015 / ADR-0029 / ADR-0034 的约束。
> 一句话：把助教收敛成「常驻、无风格、可一键清空」的答疑入口；用户消息按轮次追加维护提醒；对话可以真删除；上传文件落 `files/` 并按路径告诉模型；最后打成容器进预生产。
> 六项按用户排定顺序实施（1 → 6），每项独立可验收。

## 1. 目标与边界

### 做什么

1. **助教常驻**：`space_type = "ta"` 的 Pi Session 首次打开后不再被空闲回收，只随进程 SIGTERM 关闭；`/close` 对助教 400。
2. **维护提醒**：`POST /:id/command` 组装 prompt 时，`轮次 % N === 0` 就把 `<system-reminder>…</system-reminder>` 直接拼到用户消息末尾；三种文案按「学习 / 复习 × 制卡开关」与「助教」选取；`N` 存新表 `setting`，键 `reminder_interval_turns`，默认 30，可在「高级配置」改。
3. **助教简化**：不再投影 `style.md`（已有文件启动时删除）；`POST /:id/clear` 删 JSONL 重建空会话并立即重开常驻；前端助教面板加「清除对话」。
4. **真删除**：`DELETE /api/conversations/:id` 删行 + 删 JSONL，保留 `work_path`；`DELETE /api/workspaces/:id` 改为同样删除其下全部 JSONL；助教 403；前端左树加删除入口。
5. **`files/`**：`attachments/` 改名 `files/`，已有部署启动时一次性 `rename`；非图片附件按「用户上传了文件「x」，路径 files/x（大小）」注入，图片仍作图片块且不再列路径；前端放开文件类型。
6. **Docker**：多阶段 `Dockerfile`、`compose.yaml`、`.dockerignore`、`docs/deploy.md`、对已运行实例的 `verify:remote`。

### 不做什么

- 不改桥接层结构：常驻只是 wrapper 多一个布尔选项，`resetIdleTimer` 提前返回。
- 提醒不走 `context` / `before_agent_start` 钩子、不做自定义消息、不做前端折叠；不对模型是否维护做行为断言。
- 不做软删除、回收站、孤儿工作目录清理工具。
- 后端不做任何文件内容转换（PDF / 视频 / Office 交给后续 skill）；不改上传大小上限。
- Docker 不引入 Python、不用 alpine、不用 named volume（ADR-0015 / ADR-0029）；不写 README。

## 2. 现状事实（已核实）

| 事实 | 位置 |
| --- | --- |
| `resetIdleTimer()` 对所有 wrapper 一视同仁，`PI_TEACHER_IDLE_TIMEOUT_MS`（默认 10 分钟）到期 `shutdown()`；SIGTERM / SIGINT 由 `registerSignalHandlers` 对全部会话 `shutdown()` 后 `process.exit(0)` | `server/src/bridge/agent-session-wrapper.ts:40-44, 157-170, 474-491` |
| `startWorkspaceSession(sessionKey, workPath, toolContext, { sessionFile, thinkingLevel, homeDir })`；`openConversation` 对助教与学习会话调用方式相同 | 同上 `:529`；`routes/conversations.ts:49-52` |
| `/close` 对任何会话 abort + shutdown | `routes/conversations.ts:271-277` |
| 前端 `useConversation` 打开时 `runtime.alive === false` 才调 `/open`；收到 `session_recycled` 置 `recycled` 状态并显示「重新打开」；助教面板挂在 `AppShell` 侧栏，页面加载即打开助教 | `web/src/chat/useConversation.ts:69-75, 180-192`；`web/src/aside/AssistantPanel.tsx` |
| `createPiSession`：IMMEDIATE 事务内取 `MAX(sqlite_sequence.seq, MAX(id)) + 1` 分配 id，目标目录已存在 409，`SessionManager.create(workPath, workPath, { id: sessionKeyFor(id) })` 生成 `<时间戳>_<id>.jsonl`，header 以 `wx` 0600 写入；建 `attachments/` 目录；对所有类型都 `projectTeachStyle`（空风格也写空 `style.md`） | `server/src/session/repository.ts:51-108`；`projection/agents-md.ts` |
| `seed.ts` 用 `allowFixedTa` 建助教，补建 `attachments/`，`style.md` 缺失时投影 | `server/src/db/seed.ts:91-97` |
| `buildAppendedSystemPrompt` 读 `work_path/style.md`，`USER.md` 与 `style.md` 都空时返回 `undefined`（会话级引导块也随之省略，`http-smoke` 有断言「偏好与风格都空时不追加段落」） | `server/src/projection/system-prompt-builder.ts:33-42` |
| prompt 组装：`message + "\n\n本轮附件：\n- attachments/<name>"`（所有附件都列），png / jpeg / gif / webp 另作图片块；`attachmentIds` ≤ 8、合计 ≤ 32MB；`steer` / `follow_up` 走同一分支 | `routes/conversations.ts:218-237` |
| SDK `prompt()` 把用户消息构造成 `[{ type: "text", text }, ...images]`；`getSessionStats().userMessages` 统计全部条目里 `role === "user"` 的消息 | pi-coding-agent 0.84.2 `dist/core/agent-session.js:870-877, 2491-2506` |
| `context` 钩子每轮只注入状态行（活动 / 到期卡数 / 制卡开关）；助教走一次性简介 | `server/src/projection/context-inject.ts` |
| `GET/PATCH /api/config/settings` 只有 Pi `settings.json` 的受控字段（`defaultProvider` / `defaultModel` / `retryEnabled`），`readSettingsJsonPatch` 对白名单外字段 400 | `server/src/config/pi-config.ts:476-527`；`routes/config.ts:79-86` |
| 业务表 11 张（含 `user_env`）；`schema-check` 的 `BUSINESS_TABLES` 与 `smoke` 的 `EXPECTED_TABLES` 精确匹配 | `server/src/verify/schema-check.ts:84-95`；`smoke.ts` |
| `pi_session.path` 与 `work_path` 都是 UNIQUE；没有任何表 `REFERENCES pi_session` | `server/src/db/schema.ts:60-71`；全库 grep |
| `DELETE /workspaces/:id`：有运行中会话 409，否则 shutdown 后删 `pi_session` 行与 `space` 行，文件全留 | `routes/workspaces.ts:45-58` |
| `conversationView` 用 `statSync(row.path)` 取 `modifiedAt`，文件缺失时为 `null` | `server/src/session/session-reader.ts:128-131` |
| file-index 跳过隐藏文件、`*.env`、`.jsonl`、`node_modules` | `server/src/session/attachments.ts:66-69, 551-559` |
| 前端 `ChatInput`：`MAX_IMAGES = 5`、`accept="image/*"`、粘贴只收 `image/*`、按钮文案「添加图片附件」；附件 chip 已是通用样式 | `web/src/chat/ChatInput.tsx:9, 98, 204-214` |
| 左树对话行是一个无操作按钮；Space 头部有 hover 删除 / 新建；Space 删除用 `ConfirmDialog` | `web/src/sidebar/Sidebar.tsx:90-135, 218-222` |
| 仓库无 `Dockerfile` / `compose.yaml` / `.dockerignore`；开发机 Docker 29.7.2、Node 24.19.0 | 根目录 `ls` |
| `better-sqlite3` 13.x `engines.node >= 22`，自带 `prebuilds/linux-x64.node`（glibc）；`pi-coding-agent` `engines.node >= 22.19.0` | 两者 `package.json` |
| Node 原生类型剥离跑不了本项目：`HttpError` 用参数属性、`auth/middleware.ts` 用 `declare global namespace`，`ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX`；`node --import tsx` 可用；`tsc --rewriteRelativeImportExtensions`（TS 5.9.3）能把 `.ts` 导入改写为 `.js` 产出 `dist/` | 本机实测 |
| `getAgentDir()` = `PI_CODING_AGENT_DIR` 或 `~/.pi/agent`；后端 `PI_TEACHER_HOME` 或 `~/pi-teacher`；`index.ts` 用 `new URL("../../web/dist", import.meta.url)` 托管前端；`seed.ts` 原用 `new URL("../../../docs/提示词设计/提示词模板/agentsmd/")` 读模板（实施中改为从 `server/src/prompts/defaults.ts` 取常量，不再读文件） | pi `dist/config.js:412-418`；`server/src/index.ts:34, 78`；`db/seed.ts:8` |
| Pi 的 `loadSkills` 按 realpath 去重、同名 skill 记 collision 诊断（先加载者胜） | pi `dist/core/skills.js:299-327` |
| `node:*-slim` 自带 bash 与 GNU 工具，不带 curl / wget / python3 | ADR-0015 实测表 |

## 3. 需求详述

### 3.1 助教常驻（ADR-0035）

**桥接层**（`agent-session-wrapper.ts`，增量）：

```ts
export interface AgentSessionWrapperOptions {
  onAgentRunComplete?: AgentRunCompleteListener;
  /** 常驻：不设空闲计时器，只随进程 SIGTERM 关闭（固定助教，ADR-0035）。 */
  resident?: boolean;
}
private resetIdleTimer(): void {
  if (this.idleTimer) clearTimeout(this.idleTimer);
  if (!this._alive || this.resident) return;
  ...
}
```

`startWorkspaceSession` 的 `options` 增加 `resident?: boolean`，透传给 wrapper。`openConversation` 传 `resident: row.space_type === "ta"`。`registerSignalHandlers` 与 `shutdownAllSessions` 不变——常驻会话也在注册表里，SIGTERM 时一起关。

**路由**：`POST /:id/close` 对 `space_type === "ta"` 抛 `HttpError(400, "助教常驻，不能关闭；要清空对话请用清除")`。

**不在启动时打开助教**：首次部署可能还没配 provider，启动即开只会把「模型未配置」变成启动报错；前端挂载侧栏时本来就会打开。

### 3.2 维护提醒（ADR-0036）

**`setting` 表**（`schema.ts` 追加，无 seed，缺行即默认）：

```sql
CREATE TABLE IF NOT EXISTS setting (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
```

**新模块 `server/src/config/app-settings.ts`**——pi-teacher 自己的业务运行设置，与 Pi 的 `settings.json`（`pi-config.ts`）无关：

```ts
export const REMINDER_INTERVAL_DEFAULT = 30;   // 0 = 关闭
export const REMINDER_INTERVAL_MAX = 10_000;
export interface AppSettings { reminderIntervalTurns: number }
export function readAppSettings(db): AppSettings          // SELECT value FROM setting WHERE key = 'reminder_interval_turns'，非法或缺失 → 默认
export function readAppSettingsPatch(body): Partial<AppSettings>  // 只认 reminderIntervalTurns：整数、0..MAX，否则 400
export function writeAppSettings(db, patch): void         // INSERT ... ON CONFLICT(key) DO UPDATE
```

> 2026-09-11 实施变更（用户决定）：三段提醒文案也存 `setting` 表（`reminder_text_make_card_on` / `reminder_text_make_card_off` / `reminder_text_ta`），`AppSettings` 增加 `reminderTexts: Record<ReminderKind, string>`，`PATCH` 的 `reminderTexts` 里空串 = 删行恢复出厂文案，单条上限 4000 字符；出厂文案与全局 AGENTS.md、模板一起收在 `server/src/prompts/defaults.ts`（`REMINDER_TEXT_DEFAULTS`），`docs/提示词设计/` 整目录删除，镜像不带 `docs/`。下文的「模板文件」描述保留为设计过程记录。

**新模块 `server/src/projection/maintenance-reminder.ts`**：

```ts
/** 模板：docs/提示词设计/提示词模板/reminder/{制卡开,制卡关,助教}.md，启动时读一次；文件内容就是要追加的整段（含 <system-reminder> 标签）。（已改：文案从 setting 表现读，见上方变更说明） */
export function countUserTurns(entries): number     // 活动分支上 type === "message" && role === "user" 的条数
export function pickReminder(row: PiSessionRow, makeCardEnabled: boolean): string   // ta → 助教；否则按开关
export function shouldRemind(turn: number, interval: number): boolean   // interval > 0 && turn % interval === 0
```

**路由接线**（`POST /:id/command`，prompt / steer / follow_up 分支末尾）：

```ts
const turn = countUserTurns(wrapper.inner.sessionManager.getBranch()) + 1;
const { reminderIntervalTurns } = readAppSettings(state.db);
const trailer = shouldRemind(turn, reminderIntervalTurns) ? pickReminder(row, isMakeCardEnabled(state.db, row.id)) : "";
command.message = [message, filesNote, trailer].filter(Boolean).join("\n\n");
```

制卡开关从数据库现读（`isMakeCardEnabled`），不用闭包快照（`spec.md`「会话级工具上下文是启动时闭包快照」）。轮次从会话历史现数：助教清除后归零；`compact` 不减少 JSONL 条目，不影响；`steer` / `follow_up` 也是 user 消息，同样计入并可能命中。

**三份模板**（用户原文，文件内容与此逐字一致）：

- `制卡开.md`：`<system-reminder>已与用户对话多轮，可以考虑更新用户偏好、用户信息与制卡。如果当前会话下用户针对本次会话提出了要求，而不是全局性要求你以后在其他任务也这么做，更新到 pi-session-user.md。此消息为系统提醒，如果你认为不需要维护，在回复用户时无需提及本消息</system-reminder>`
- `制卡关.md`：同上，去掉「与制卡」
- `助教.md`：`<system-reminder>已与用户对话多轮，可以考虑更新用户对你的要求，更新到 pi-session-user.md。此消息为系统提醒，如果你认为不需要维护，在回复用户时无需提及本消息</system-reminder>`

**设置 API**：`GET /api/config/settings` 响应增加 `app: { reminderIntervalTurns }`；`PATCH` 同时接受 Pi 字段与 `reminderIntervalTurns`，路由先拆出 app 字段（`readAppSettingsPatch`）再把剩余交给 `readSettingsJsonPatch`（剩余为空则跳过 Pi 写入，避免它的「至少一个字段」400）。

**前端**：`AdvancedTab` 在重试开关下方加「维护提醒间隔」数字输入（说明「每隔多少轮对话提醒老师维护偏好、用户信息与卡片；0 表示关闭」），失焦或 Enter 保存，`configApi.saveSettings({ reminderIntervalTurns })`；`PiSettingsResponse` 加 `app` 字段。历史里的 `<system-reminder>` 原样显示（`UserBubble` 是纯文本渲染，标签不会被当 HTML 吞掉）。实施时同一节还加了三个提醒文案的编辑框（每个带「保存」与「恢复默认」，恢复默认即提交空串）。

### 3.3 助教简化：去 style.md、清除上下文（ADR-0035）

**不投影 `style.md`**：

- `createPiSession`：`if (space.type !== "ta") projectTeachStyle(...)`。
- `seed.ts`：助教分支不再调用 `projectTeachStyle`；改为 `rmSync(path.join(ta.work_path, "style.md"), { force: true })`——它是程序投影而非用户内容，删除不违反「seed 只补不覆盖」。
- `projectTeachStyle` 本身不改；`system-prompt-builder` 不改（助教目录没有 `style.md` 就没有风格块，全局 `USER.md` 仍读）。

**清除**：把 `createPiSession` 里「`SessionManager.create` → 取 `sessionFile` / `header` → `writeFileSync(wx, 0600)`」抽成 `createEmptySessionFile(workPath, id): string` 复用。

```
POST /api/conversations/:id/clear          只允许助教，其余 403（与 options / teach-style 对助教的 403 同风格）
  1. wrapper 运行中 → send abort；wrapper 存在 → shutdown（SSE 收到 session_recycled）
  2. newPath = createEmptySessionFile(row.work_path, row.id)      // 文件名带新时间戳，不与旧文件冲突
  3. 事务：UPDATE pi_session SET path = newPath WHERE id = ?
  4. unlink 旧 path（失败只 console.error，不回滚——孤儿 JSONL 与保留的工作目录同类）
  5. openConversation(state, updated)（resident）
  → { success: true, conversation, runtime }
```

`work_path`、`pi-session-user.md`、`files/` 一律不动。

**前端**：`AssistantPanel` 头部状态文字旁加图标按钮「清除对话」（`delete_sweep`）→ `ConfirmDialog`（「清空助教的全部对话记录？助教对你的要求（pi-session-user.md）与上传的文件会保留。」）→ `conversationsApi.clear(taSessionId)` → 成功后 `session.reopen()`（后端已重开，`/open` 幂等，前端只是重连 SSE 并刷新空历史）。

### 3.4 会话删除（ADR-0037）

**仓储层**新增 `deletePiSession(db, row): void`：事务删行，然后 `unlinkSync(row.path)`（`force`，失败记日志）。

**路由**：

```
DELETE /api/conversations/:id
  助教 → 403「助教不可删除，请用清除」
  wrapper 运行中 → abort；存在 → shutdown
  deletePiSession
  → { success: true, filesRetained: true }

DELETE /api/workspaces/:id（改）
  learn 以外 403（不变）
  对每条 pi_session：运行中 abort → shutdown → deletePiSession   // 取消现有 409，用户已在 ConfirmDialog 确认
  删 space 行
  → { success: true, filesRetained: true }
```

删除后原 id 一律 404（`getPiSession` 已如此）；前端 `useConversation` 只对 `code === "session_recycled"` 的 404 自动重开，普通 404 不会。

**前端**：左树对话行改为 `group` 容器，hover 出现删除图标 → `ConfirmDialog`（「删除对话「x」？聊天记录会被删除，工作目录里的文件保留在磁盘上。」）→ `conversationsApi.remove(id)` → `refresh()`；删的是当前打开的对话时，`Sidebar` 通过新增回调 `onConversationDeleted(id)` 让 `AppShell` `navigate("/app")`。Space 删除确认文案改为「…对话记录会被删除，各对话的工作目录文件保留在磁盘上」。

### 3.5 `files/` 目录与路径注入（ADR-0038）

**改名**：`ATTACHMENTS_DIR_NAME` → `SESSION_FILES_DIR_NAME = "files"`（模块与路由名保留 `attachments`）；`createPiSession`、`seed.ts` 建目录处、`AttachmentMeta.relativePath` 注释、`verify:attachments` 的符号链接用例同步。

**一次性迁移**（`session/attachments.ts` 新增，`buildApp` 在 `initializeSchema` 之后调用）：

```ts
export function renameLegacyAttachmentDirs(db): { renamed: number; skipped: number }
  // 遍历 SELECT work_path FROM pi_session：
  //   lstat(work_path/attachments) 是真目录 && work_path/files 不存在 → renameSync
  //   两者都在 → skipped++ 并 console.warn（只打相对信息，不打绝对路径）
```

之后程序不再认识 `attachments/` 这个目录名。

**注入**（`routes/conversations.ts`）：

```ts
const isImage = (file) => /^image\/(png|jpeg|gif|webp)$/.test(file.mimeType);
command.images = attachments.filter(isImage).map(...);           // 不变
const filesNote = attachments.filter((file) => !isImage(file))
  .map((file) => `用户上传了文件「${file.name}」，路径 ${file.relativePath}（${formatBytes(file.size)}）。`)
  .join("\n");
```

图片不再出现在文本里（图已随消息发送）；`formatBytes` 输出 `12 KB` / `1.5 MB` 这类人类可读值。用户只发图片、不写文字时，现状靠「本轮附件」列表保证文本块非空；改后文本块会变成空串，而 Anthropic 拒绝空 text block——此时用 `用户发送了 N 张图片。` 作为文本块兜底，`http-smoke` 加一条只带图片的 prompt 断言真模型正常回复。

**前端**：`ChatInput` 去掉 `accept`，粘贴收任意文件，按钮文案「添加附件」，`MAX_IMAGES` → `MAX_ATTACHMENTS = 8`（与后端 `attachmentIds` 上限一致）。

### 3.6 Docker 预生产

**版本与运行方式（建议，见 §7 待确认）**：

- 基础镜像 `node:24-slim`：开发与全部验证都在 24.19 上跑过，两处依赖 `engines` 都 ≥ 22；ADR-0015 的 slim vs alpine 结论不受影响，在其顶部加状态行「基础镜像升至 node:24-slim（本 PRD）」。
- 运行方式 `node --import tsx src/index.ts`：与开发完全一致、零代码改动；代价是 `tsx` 从 devDependencies 移到 dependencies（含 esbuild，约 10MB）与启动时几百毫秒的转换缓存。预编译（`tsc --rewriteRelativeImportExtensions` 已实测可行）留作后续优化。
- 容器内以 root 运行，**完全遵循 Pi 约定、不覆盖任何路径**：数据在 `~/pi-teacher`（`/root/pi-teacher`），Pi 配置在 `~/.pi/agent`，skills 在 `~/.pi/agent/skills`。宿主侧两个挂载点由 compose 变量 `HOST_PI_TEACHER_HOME`（默认 `./pi-teacher`）/ `HOST_PI_AGENT_DIR`（默认 `./pi-agent`）决定，可以是任意路径；skills 随 `~/.pi/agent` 整目录挂进来，不单独挂、不只读（实施时由用户定，取代最初的 `/data/*` 显式路径方案与后来的独立只读 skills 挂载）。非 root 需要宿主目录 uid 对齐，本机部署目录属 root，先不做。

**镜像布局**（相对路径必须与仓库一致，`index.ts` 靠 `import.meta.url` 相对定位前端产物）：

```
/app/server/{package.json,package-lock.json,node_modules,src}
/app/web/dist                          ← 第一阶段构建产物
/app/skills                            ← 仓库自带的内置 skill，entrypoint 每次启动覆盖进 ~/.pi/agent/skills
/usr/local/bin/docker-entrypoint.sh    ← 同步内置 skill 后 exec CMD
```

`docs/` 不进镜像：出厂提示词（全局 AGENTS.md、`agents_md` / `teach_style` 模板、三段提醒文案）全部收在 `server/src/prompts/defaults.ts`。内置 skill 随镜像走：`docker-entrypoint.sh` 对 `/app/skills/*/` 逐个 `rm -rf` 同名目录再 `cp -pr` 进 `~/.pi/agent/skills`——内置的归镜像管、用户自己放进去的其他目录不碰；新增内置 skill 只需往仓库 `skills/` 加目录，不改后端代码。宿主机直跑的用户自己把 `skills/` 里的目录移进 `~/.pi/agent/skills`（README 待写）。

**`Dockerfile`**（多阶段）：`web-build`（`npm ci` + `npm run build`）→ `server-deps`（`npm ci --omit=dev --ignore-scripts`，tsx 已在 dependencies；`--ignore-scripts` 的原因见 `docs/spec.md`「`npm ci` 会对 better-sqlite3 合成 node-gyp rebuild」）→ `runtime`（`node:24-slim`，COPY 上述几处，`ENV NODE_ENV=production PORT=39871`，`mkdir -p /root/pi-teacher /root/.pi/agent/skills`，`WORKDIR /app/server`，`ENTRYPOINT ["docker-entrypoint.sh"]` + `CMD ["node", "--import", "tsx", "src/index.ts"]`）。不声明 `VOLUME`（ADR-0029 不用匿名卷）。

**`compose.yaml`**（实际文件为准，这里只列骨架）：

```yaml
services:
  pi-teacher:
    build: .
    init: true                                  # PID 1 不是 node：SIGTERM 才能进 registerSignalHandlers 优雅关会话
    restart: unless-stopped
    ports: ["${PI_TEACHER_PORT:-39871}:39871"]
    volumes:
      - ${HOST_PI_TEACHER_HOME:-./pi-teacher}:/root/pi-teacher       # 默认平铺在 compose.yaml 旁，首次启动自动创建
      - ${HOST_PI_AGENT_DIR:-./pi-agent}:/root/.pi/agent               # skills/ 子目录随之挂入（ADR-0029），可写
    environment:
      - PI_TEACHER_PROVIDER=${PI_TEACHER_PROVIDER:-}
      - PI_TEACHER_MODEL=${PI_TEACHER_MODEL:-}
      - PI_TEACHER_HOSTNAME=${PI_TEACHER_HOSTNAME:-}                 # 用域名访问时必填，否则 Host 校验 403
    healthcheck:
      test: ["CMD", "node", "-e", "fetch('http://127.0.0.1:39871/api/auth/status').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
      interval: 30s
      timeout: 5s
      start_period: 20s
```

slim 镜像没有 curl / wget，healthcheck 用 node `fetch`。`user_env` 已入库，容器 env 只做首次导入（ADR-0034），compose 不再列 `TAVILY_*`。`PI_TEACHER_PROVIDER` 未设置时 compose 传入空串，后端把空串视同未设置（`models.ts` / `pi-config.ts` 用 `||`）。

**`.dockerignore`**：`node_modules`、`web/dist`、`**/dev-data`、`**/.env`、`.git`、`docs`（整目录）、`pi-teacher` / `pi-agent`（默认挂载目录，绝不能打进镜像）、根目录 `*.md` 草稿（`我的草稿-ai不用读.md` 等；`skills/*/SKILL.md` 不受影响）。`.gitignore` 同步加 `/pi-teacher/`、`/pi-agent/`。

**`verify:remote`**（`server/src/verify/remote-check.ts`）：对**已运行实例**做 HTTP 面验收，`PI_TEACHER_BASE_URL` 必填，`PI_TEACHER_VERIFY_USERNAME/PASSWORD` 可选（未设且实例 `needsSetup` 时自己 setup 一个）。覆盖：`/api/auth/status`、登录、`/api/workspaces` 含助教、创建学习 Pi Session、真模型 prompt 走完 SSE、bash 里 `./scripts/tavily-search --help` 的 toolResult 含 `tavily`（证明 skill 挂载可用）、`/api/config/user-env` 列表含内置项、SPA fallback。不用 `buildApp`，不碰实例的数据目录。

**`docs/deploy.md`**：构建、首次启动、目录挂载含义、升级（`docker compose build && up -d`）、备份（复制两个挂载目录）、日志、常见错误（provider 未配置、端口占用、宿主目录权限）。

## 4. 改动清单

| 文件 | 改动 |
| --- | --- |
| `server/src/bridge/agent-session-wrapper.ts` | `resident` 选项；`resetIdleTimer` 对常驻直接返回；`startWorkspaceSession` 透传 |
| `server/src/routes/conversations.ts` | `openConversation` 传 `resident`；`/close` 助教 400；`/clear`；`DELETE /:id`；prompt 组装改为 `[message, filesNote, trailer]`；图片不列路径 |
| `server/src/routes/workspaces.ts` | 删除改为 abort + shutdown + `deletePiSession`，取消 409 |
| `server/src/routes/config.ts` | `/settings` 增加 `app` 字段与 `reminderIntervalTurns` 写入 |
| `server/src/session/repository.ts` | `createEmptySessionFile`、`deletePiSession`；助教跳过 `projectTeachStyle`；建 `files/` |
| `server/src/session/attachments.ts` | `SESSION_FILES_DIR_NAME`；`renameLegacyAttachmentDirs`；`formatBytes` |
| `server/src/db/schema.ts` | `setting` 表 |
| `server/src/db/seed.ts` | 助教建 `files/`、删 `style.md`、不投影风格 |
| `server/src/config/app-settings.ts`（新） | `reminder_interval_turns` 读写与校验 |
| `server/src/projection/maintenance-reminder.ts`（新） | 轮次统计、文案选取；文案从 `setting` 表现读（`app-settings.ts`） |
| `server/src/index.ts` | `buildApp` 调 `renameLegacyAttachmentDirs` 并打印计数 |
| `server/package.json` | `tsx` → dependencies；`verify:remote` 脚本 |
| `server/src/prompts/defaults.ts`（新） | 全部出厂提示词常量：全局 AGENTS.md、`agents_md` / `teach_style` 模板、三段提醒文案；`docs/提示词设计/` 整目录删除 |
| `server/src/config/app-settings.ts` | `reminderTexts` 读写校验：空串删行恢复默认、单条 ≤ 4000 字符 |
| `server/src/verify/lifecycle-child.ts` / `lifecycle.ts` | 同时打开助教；断言学习会话回收后助教仍活；清除不破坏常驻；SIGTERM 两条都关 |
| `server/src/verify/http-smoke.ts` | [3] `files/` 路径；[4] 非图片注入文案；[7] 后加清除节；新节：提醒命中 / 不命中 × 三文案、删除、Space 删除、`/close` 助教 400、`settings.app` |
| `server/src/verify/schema-check.ts`、`smoke.ts` | 表清单加 `setting` |
| `server/src/verify/attachments-check.ts` | 目录名；迁移函数用例（旧目录 → `files/`，两者并存跳过） |
| `server/src/verify/remote-check.ts`（新） | 对已运行实例的 HTTP 验收 |
| `web/src/api/client.ts` / `types.ts` | `conversationsApi.clear` / `remove`；`PiSettingsResponse.app`（含 `reminderTexts`）；`saveSettings` 接受 `reminderIntervalTurns` 与 `reminderTexts` |
| `web/src/aside/AssistantPanel.tsx` | 「清除对话」+ `ConfirmDialog` |
| `web/src/sidebar/Sidebar.tsx`、`web/src/app/AppShell.tsx` | 对话行删除入口 + `ConfirmDialog`；`onConversationDeleted` 回调；Space 删除文案 |
| `web/src/settings/AdvancedTab.tsx` | 「维护提醒间隔」输入框；三个提醒文案编辑框（保存 / 恢复默认） |
| `web/src/chat/ChatInput.tsx` | 放开 `accept` 与粘贴类型；`MAX_ATTACHMENTS = 8`；文案 |
| `Dockerfile`、`docker-entrypoint.sh`、`compose.yaml`、`.dockerignore`（新，根目录）；`.gitignore` | 见 §3.6 |
| `docs/deploy.md`（新） | 部署文档 |
| `docs/CONTEXT.md` | 新增 Session Files 术语；Reminder 定义改写 |
| `docs/数据库与目录结构设计.md` | `setting` 表；目录树加 `files/`（三种会话）；删除语义与孤儿目录说明；表清单 12 张（含 `user`） |
| `docs/adr/0015-*.md` | 顶部状态行：基础镜像升至 node:24-slim |
| `docs/adr/0006-*.md` | 顶部状态行：提醒载体由 ADR-0036 改为路由层直接拼接 |
| `CLAUDE.md` | ADR 范围 0001–0038；生命周期事实改为「学习 / 复习 10 分钟回收、助教常驻」；`files/`；容器起停命令 |

## 5. 验收标准

全部走真实 SQLite / 真实 Pi SDK / 真实模型 / 真容器，不用 mock。

1. **助教常驻**：`verify:lifecycle` 把 `PI_TEACHER_IDLE_TIMEOUT_MS` 调到 2 秒，同一子进程同时打开学习会话与助教：学习 wrapper 被回收（注册表不含它）、助教 `isAlive()` 仍为 true，之后 `shutdownAllSessions()` 能关掉助教并 0 退出；SIGTERM 分支两条会话都发出 `session_shutdown` 并 dispose。`http-smoke`：`POST /1/close` 400；[9] 对学习会话的回收与恢复断言不变。
2. **提醒**：`http-smoke` 把 `reminder_interval_turns` 通过 `PATCH /api/config/settings` 设为 2，对学习会话（制卡开）连续发两轮：第 2 轮 provider payload 的**最后一条** user 消息文本以 `制卡开.md` 内容结尾、第 1 轮不含；把制卡关掉再凑到第 4 轮命中 `制卡关.md`；助教凑到命中轮次含 `助教.md` 文案且不含「用户偏好」；`GET /api/context` 里该条用户消息原样含 `<system-reminder>`；`PATCH` 传 `-1`、`1.5`、`"30"` 均 400；`0` 时任何轮次都不追加。
3. **助教简化**：`verify:config` 或 `http-smoke` 断言助教目录没有 `style.md`（预置一个旧文件，初始化后消失），学习会话仍有；`http-smoke` [7] 后：助教有历史 → `POST /1/clear` 200 → `context.messages` 为空、旧 JSONL 不存在、新 JSONL 存在且 `pi_session.path` 已更新、`pi-session-user.md`（预先写入）仍在、`runtime.alive === true`；对学习会话 `/clear` 403；清除后再发一轮真模型 prompt 正常。
4. **删除**：`http-smoke` 新节：对一条有历史、运行中的学习会话 `DELETE` → 200 `filesRetained: true`，随后 `GET /context`、`/status`、`/events` 均 404（非 `session_recycled` 码），JSONL 不存在，`work_path` 与其中 `AGENTS.md` 仍在；`DELETE /1` 403；建两条会话的 Space `DELETE` → 两份 JSONL 都不存在、两个 `work_path` 都在、`GET /api/workspaces` 不再列出。
5. **files/**：`verify:attachments`：上传落 `work_path/files/<name>`，`relativePath` 为 `files/<name>`，`files` 是符号链接时上传被拒；迁移用例：预置 `attachments/` 有文件 → 调用后成为 `files/`，预置两者并存 → 都不动且返回 `skipped: 1`。`http-smoke` [3]/[4]：上传 `资料.md` 后 prompt，payload 最后一条 user 消息含 `用户上传了文件「资料.md」，路径 files/资料.md（`，且不含 `本轮附件`；带 png 的 prompt payload 含图片块且文本里不含 `files/` 该图片名；只带图片、不写文字的 prompt 被真实 preflight 接受且模型正常回复。
6. **Docker**：`docker compose build` 成功；`docker compose up -d` 后 healthcheck 变 healthy；`PI_TEACHER_BASE_URL=http://localhost:39871 npm run verify:remote` 全绿（含真模型跑通 `tavily-search --help`）；`docker compose restart` 后登录态外的数据（会话列表、卡片、`user_env`）全部保留；`docker compose stop` 在 10 秒宽限期内退出（退出码 0，日志有 `session_shutdown` 路径）；镜像内 `python3` 不存在；`server` / `web` typecheck 与 `web build` 通过。
7. 所有既有脚本仍绿：`verify:schema`、`verify:config`、`verify:attachments`、`verify:lifecycle`、`smoke`、`verify`、`http-smoke`；隔离环境真浏览器走一遍：助教清除、对话删除、上传 `.md` 与图片、修改提醒间隔。
8. 文档：`grep -rn $'\xef\xbf\xbd'` 无命中；`CONTEXT.md` / `数据库与目录结构设计.md` / `CLAUDE.md` 与实现一致。

## 6. 实施顺序

1. 助教常驻（3.1）+ `verify:lifecycle` 改造 → 2. 维护提醒（3.2，含 `setting` 表、设置 API、前端输入框）→ 3. 助教简化（3.3，复用 1 的常驻与 `createEmptySessionFile`）→ 4. 真删除（3.4，复用 3 的 abort/shutdown 序列）→ 5. `files/`（3.5）→ 6. Docker（3.6）。每步结束跑对应验证脚本；第 6 步之前先跑一遍全部脚本作为容器化基线。

## 7. 待确认（实施前定）

| 事项 | 建议 |
| --- | --- |
| 提醒是否覆盖复习会话 | 用户原话是「学习类型=学习」；建议学习与复习都提醒（复习也可开制卡、也会积累会话级要求），文案共用 |
| `USER.md` 为空且无风格时，`appendSystemPrompt` 整段省略，模型没被告知 `pi-session-user.md` 是什么，提醒却让它「更新到 pi-session-user.md」（助教几乎总处于这种状态） | 把 `<会话级用户偏好>` 引导块改为无条件输出，与 ADR-0033「无论文件是否存在都输出」的原话一致；`http-smoke` 一条断言随之改写 |
| Docker 基础镜像 Node 版本 | `node:24-slim`（理由见 3.6） |
| tsx 直跑还是预编译 | 预生产先 tsx 直跑；预编译作为后续优化 |
| 容器内用户 | root；路径按 Pi 约定（`~/pi-teacher`、`~/.pi/agent`、`~/.pi/agent/skills`），宿主侧两个挂载点靠 compose 变量、默认平铺在 compose.yaml 旁（`./pi-teacher`、`./pi-agent`）——用户在实施中定，取代原先的 `/data/*` 显式路径。非 root 留到有多用户或非 root 宿主需求时 |
| 出厂提示词与内置 skill 怎么进镜像 | 提示词不进镜像：全部收进 `server/src/prompts/defaults.ts`，三段提醒文案存 `setting` 表并可在设置页改，全局 AGENTS.md 仍是文件；内置 skill 随镜像 `COPY skills`，entrypoint 每次启动 `rm -rf` 同名目录后 `cp -pr` 进 `~/.pi/agent/skills`，用户自己的 skill 目录不碰——用户在实施中定 |
| 旧 `attachments/` 目录 | 启动时一次性 `rename`，两者并存则跳过并记日志 |

## 8. 风险

- 常驻会话若因模型配置错误启动失败，前端每次挂载都会重试 `/open`——现状已如此，不因常驻恶化。
- 提醒拼进用户消息后真模型可能在回答里复述 `<system-reminder>` 标签（`spec.md` 已记录的现象），验证只断言最后一条 user 消息，不断言回答。
- `DELETE /workspaces/:id` 取消 409 后会打断运行中的回复；用户在确认框里已被告知。
- `attachments/ → files/` 迁移只在后端启动时执行一次；用户在容器与宿主机之间切换部署时两边都会各跑一次，幂等。
- 内置 skill 每次启动都被镜像版本覆盖：用户若直接改了 `~/.pi/agent/skills/tavily-search`，重启即丢——`docs/deploy.md` 明说「想定制就复制一份改名」；用户自己的其他 skill 目录不受影响（实测：预置 `my-own-skill` 与同名目录里的杂文件，重启后前者原样、后者被清掉）。
