# PRD：用户环境变量存库与运行期注入（user-env-in-database）

> 基线：global-layout-prompt-layering 实现完成（未 commit）。决策见 ADR-0034。
> 一句话：`~/pi-teacher/.env` 与 `env-sync.ts` 取消，用户环境变量存 SQLite `user_env` 表（内置 Tavily 三项，用户可自行增删），后端启动与保存时写入自己的 `process.env`，模型调用 skill 时靠子进程继承拿到。
> 修订（2026-09-10）：实现后用户判断「数据库都没加密，前端隐藏没意义」，去掉了隐藏值（`secret`）：值明文存、明文回显，`PATCH` 只有「字符串覆盖」；旧表的 `secret` 列由幂等迁移删除。下文以此为准，涉及隐藏值的旧描述已改写。

## 1. 目标与边界

### 做什么

1. 新表 `user_env(key, value)`；内置项常量 `BUILTIN_USER_ENV`：`TAVILY_API_KEY`、`TAVILY_BASE_URL`、`TAVILY_TIMEOUT`。内置项未设置时也出现在列表里，不可删行只可清值。
2. 用户可添加任意合法变量名（`^[A-Z_][A-Z0-9_]*$`）；受保护的变量名（见 3.2）拒绝。值明文存储、明文回显。
3. 启动：先做一次性导入（表无而 env 有 → 写表，仅内置项；表无而旧 `.env` 有 → 写表，任意 key），再把表里全部行写入 `process.env`。
4. WebUI 保存 / 删除后立即同步 `process.env`。
5. `GET/PATCH/DELETE /api/config/user-env`；「高级配置」Tab 末尾新增「用户环境变量」区块。
6. 删除 `env-sync.ts`、`ServerOptions.envFilePath`、`index.ts` 里的 `.env` 读写；SKILL.md 去掉 `--env-file`。
7. 修正 `env-sync.ts` 里的白名单错字：`TAVILY_TIMEOUT_MS` 实际应为 `TAVILY_TIMEOUT`（Go CLI 读的是后者，现状这条同步从来没生效过）。

### 不做什么

- 不改 tavily-search 的 Go 源码，不重新编译；CLI 的 `--env-file` 参数保留（不用即可）。
- 不删用户已有的 `~/pi-teacher/.env`；导入一次后不再读，文档告知可删。
- 不加密存储：SQLite 文件在 `data/` 下 0600，与 cookie.key 同级别。
- 不做 `PI_TEACHER_PROVIDER` / `PI_TEACHER_MODEL` 等后端自身配置的入库，它们仍是部署期环境变量（并列入受保护前缀）。

## 2. 现状事实（已核实）

| 事实 | 位置 |
| --- | --- |
| Pi bash 工具每次执行现拷 `{ ...process.env }`，运行期改 env 立即对下一次工具调用生效 | pi-coding-agent 0.84.2 `dist/core/tools/bash.js:120`、`dist/utils/shell.js:103` |
| tavily-search `getSetting()`：env 非空即用，否则查 dotenv；`.env` 不存在时 `readEnvFile` 静默返回空 map | `skills/tavily-search/sourcecode/main.go:258-338` |
| 现有同步白名单写的是 `TAVILY_TIMEOUT_MS`，CLI 读的是 `TAVILY_TIMEOUT` | `server/src/env-sync.ts:13`、`main.go:279` |
| `index.ts` 启动时读 `.env` 填 `process.env`，再 `syncEnvToFile` 反写 | `server/src/index.ts:95-102` |
| `SECRET_MASK`、三态语义、`configured` 布尔出口已在 `pi-config.ts` 实现 | `server/src/config/pi-config.ts:40`、ADR-0032 |
| 业务表 10 张（含 user），`schema-check` 断言表集合精确匹配 | `server/src/verify/schema-check.ts:84-95` |
| 真实 `~/pi-teacher/.env` 存在，含三个 TAVILY 键 | 部署环境 `ls` |

## 3. 需求详述

### 3.1 schema

```sql
CREATE TABLE IF NOT EXISTS user_env (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
```

不加 `updated_at`。`schema-check` 的 `BUSINESS_TABLES` 加 `user_env`。`initializeSchema` 里一条幂等迁移：`PRAGMA table_info(user_env)` 发现 `secret` 列就 `ALTER TABLE user_env DROP COLUMN secret`，行数据不动。

### 3.2 `server/src/config/user-env.ts`

```ts
export const BUILTIN_USER_ENV = [
  { key: "TAVILY_API_KEY",  description: "Tavily 搜索 API Key" },
  { key: "TAVILY_BASE_URL", description: "Tavily API 地址，默认 https://api.tavily.com" },
  { key: "TAVILY_TIMEOUT",  description: "Tavily 请求超时，Go duration 写法，如 60s" },
] as const;

/** 拒绝会改变后端进程自身行为的变量：精确名 + 前缀。 */
const PROTECTED_KEYS = ["PATH", "HOME", "USER", "SHELL", "PWD", "TMPDIR", "NODE_OPTIONS", "NODE_ENV", "PORT",
  "LD_PRELOAD", "LD_LIBRARY_PATH", "DYLD_INSERT_LIBRARIES", "NODE_EXTRA_CA_CERTS", "UV_THREADPOOL_SIZE"];
const PROTECTED_PREFIXES = ["PI_TEACHER_", "PI_CODING_AGENT_", "NODE_", "npm_"];

/** 启动：一次性导入（内置项从 env、任意 key 从旧 .env），再把表里全部行写入 process.env。返回导入的 key 名。 */
export function bootstrapUserEnv(db, homeDir): { fromEnv: string[]; fromDotenv: string[] }
/** 出口：内置项永远在列（未设置 configured=false、无 value），用户项按表；已设置的项明文带 value。 */
export function listUserEnv(db): UserEnvItem[]
/** 补丁 { [key]: string }：值必须非空；受保护 / 非法名 400。 */
export function readUserEnvPatch(body): UserEnvPatch
export function applyUserEnvPatch(db, patch): void   // 事务 upsert + 同步 process.env
export function deleteUserEnv(db, key): void         // 内置项 → 只清值（删行但仍在列表）；用户项 → 删行；都 delete process.env[key]
```

`UserEnvItem`: `{ key, builtin, configured, value?: string(已设置时), description?: string(仅内置) }`。

补丁校验：
- key 必须匹配 `^[A-Z_][A-Z0-9_]*$` 且长度 ≤ 64；受保护名 / 前缀 400（错误信息点名）
- `value`：必须是字符串，去空白后非空（要移除用 DELETE），≤ 4000 字符
- 至少一个 key

导入规则（`bootstrapUserEnv`，顺序固定）：
1. 内置项：表里没有且 `process.env[key]` 非空 → 写表。
2. 旧 `homeDir/.env` 存在：用 `node:util` `parseEnv` 解析；每个表里没有、名字合法且不受保护的 key → 写表。
3. 把表里全部行写入 `process.env`。
4. 日志只打 key 名与来源：`[user-env] 已从环境变量首次导入：TAVILY_API_KEY`；`[user-env] 已从 .env 首次导入：…（该文件不再被读取，可删除）`。

### 3.3 路由（挂在 `routes/config.ts`）

- `GET /api/config/user-env` → `{ items: UserEnvItem[] }`
- `PATCH /api/config/user-env` body `{ [key]: string }` → `{ success: true, items }`；保存后 `process.env` 立即反映
- `DELETE /api/config/user-env/:key` → `{ success: true, items }`；非法名 400；不存在的用户项 404；内置项 → 清值

### 3.4 前端

`AdvancedTab` 末尾挂 `UserEnvSection`（独立文件 `web/src/settings/UserEnvSection.tsx`）：

- 列表：每行 key（内置项带「内置」chip 与说明，未设置时再带「未设置」chip）、行内输入框预填当前值、右上角「清除（内置）/ 删除（用户项）」
- 编辑：改了值且非空才能保存；保存按钮逐行提交（每行一个 PATCH，不做批量脏检查）；服务端返回的列表用 `key=<name>:<value>` 重建行，输入框回到最新值
- 新增：一行「变量名 + 值」，变量名输入自动转大写，前端只做正则提示，拒绝仍由服务端判定
- 删除 / 清除走 `ConfirmDialog`，文案说明「立即从运行环境移除，依赖它的 skill 会失败」
- 说明文字：「保存后立即生效，老师下一次调用 skill 即使用新值。值明文保存在本机数据库。」

### 3.5 清理

- 删除 `server/src/env-sync.ts`；`index.ts` 删除 `parseEnv`、`syncEnvToFile`、`getSyncKeys`、`envFilePath`；`buildApp` 内 `initializeSchema` 之后调用 `bootstrapUserEnv(db, homeDir)`（http-smoke 走 `buildApp` 即可覆盖）
- `skills/tavily-search/SKILL.md`「密钥配置」改为：由 Pi Teacher 后端注入环境变量，命令**不带** `--env-file`；缺 key 时报错给用户，让用户到「系统设置 → 高级配置 → 用户环境变量」填写。`references/advanced-cli.md` 同步
- ADR-0029 顶部状态行补「密钥注入一节被 ADR-0034 取代」
- `数据库与目录结构设计.md`：表关系与表清单加 `user_env`；「存储边界」表加一行；目录布局不再提 `.env`
- `CLAUDE.md`：secret 处理模块仍只有 `pi-config.ts`，注明 `user_env` 明文；技术事实加一条「运行期 `process.env` 由后端维护」；`.gitignore` 的 `**/.env` 保留（防误提交）

## 4. 改动清单

| 文件 | 变更 |
| --- | --- |
| `server/src/db/schema.ts` | 加 `user_env` 表 |
| `server/src/config/user-env.ts` | 新增 |
| `server/src/index.ts` | 删 `.env` 读写；`buildApp` 内调用 `bootstrapUserEnv` |
| `server/src/env-sync.ts` | 删除 |
| `server/src/routes/config.ts` | 三条路由 |
| `server/src/verify/schema-check.ts` | 表集合加 `user_env` |
| `server/src/verify/config-check.ts` | 新节：secret 列幂等迁移、导入优先级、补丁校验、受保护名、process.env 同步、明文回显 |
| `server/src/verify/http-smoke.ts` | 新节：API 契约 + `process.env` 立即生效 + 模型子进程 `echo` 看到新值 |
| `web/src/api/client.ts`、`types.ts` | 新增 |
| `web/src/settings/AdvancedTab.tsx` | 末尾挂载 `UserEnvSection` |
| `web/src/settings/UserEnvSection.tsx` | 新增：列表行 / 添加表单 / 清除删除确认框（独立文件，保持 AdvancedTab 可读） |
| `skills/tavily-search/SKILL.md`、`references/advanced-cli.md` | 去 `--env-file`，改来源说明 |
| `docs/adr/0029` | 状态行 |
| `docs/数据库与目录结构设计.md`、`CLAUDE.md`、`docs/tasks/TODO.md` | 同步 |

## 5. 验收标准

1. 空库 + `TAVILY_API_KEY=x` 环境变量启动 → 表里有该行；再次以 `TAVILY_API_KEY=y` 启动 → 表里仍是 x；启动后 `process.env.TAVILY_API_KEY === "x"`
2. 空库 + 无 env + 旧 `.env` 含 `TAVILY_BASE_URL` 与自定义 `MY_SKILL_TOKEN` → 两者都导入；`.env` 文件字节不变
3. `GET` 响应明文回显已设置的值；内置项未设置时仍在列且 `configured=false`、无 `value`
4. `PATCH` 空串 / 非字符串 → 400；字符串 → 覆盖且 `process.env` 立即等于新值；新增用户项 → 表里出现且 `process.env` 出现
5. `DELETE` 用户项 → 行删除、`process.env` 中 `delete`；`DELETE` 内置项 → 行删除但列表仍有该项且 `configured=false`
6. `PATH`、`NODE_OPTIONS`、`PI_TEACHER_HOME`、`lowercase`、`1ABC` → 400，表与 `process.env` 不变
7. 真模型：保存新的 `TAVILY_TIMEOUT` 后让模型执行 `echo $TAVILY_TIMEOUT`，回答含新值（不依赖 Tavily 网络、不涉及 API key）
8. `grep -rn "env-sync\|envFilePath\|syncEnvToFile" server/src` 为零；`grep -rn "\-\-env-file" skills/tavily-search/SKILL.md` 为零
9. 全部验证脚本与 typecheck / build 通过；日志只含 key 名

## 6. 实现顺序

1. schema + `user-env.ts` + `schema-check` / `config-check`
2. `index.ts` 接线、删 `env-sync.ts` → `verify:lifecycle`、`http-smoke` 跑通
3. 路由 + http-smoke 新节（含真模型 `echo`）
4. 前端区块 → build → 隔离环境真浏览器验收
5. skill 文档、ADR-0029、设计文档、CLAUDE.md、TODO

## 7. 风险

| 风险 | 对策 |
| --- | --- |
| 用户把 `PATH` 之类设坏导致服务起不来 | 受保护名单拒绝；名单只拦「改变后端进程自身行为」的，不拦业务变量 |
| 验证脚本改了 `process.env` 影响同进程后续断言 | 用 `PI_TEACHER_VERIFY_` 之外的独立 key 名（如 `VERIFY_USER_ENV_*`），结束时删除 |
| 用户真实环境 `.env` 里的旧 key 与 env 不一致 | 导入优先级 env > .env，与旧规则一致 |
| 删除内置项后重启被 env 再次导入 | ADR 已写明：要彻底去掉需同时移除容器 env |
