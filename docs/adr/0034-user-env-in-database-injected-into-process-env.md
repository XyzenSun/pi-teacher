# 用户环境变量存库、运行期注入 process.env，取消 .env 文件

- 状态：已采纳
- 日期：2026-09-10
- 相关：ADR-0015（容器优先）、ADR-0027（skill 作为外部能力载体）、ADR-0032（models.json 的 secret 边界——本表**不**沿用它）
- supersedes：ADR-0029「密钥注入：env > .env，启动时单向同步」一节及其否决项；`server/src/env-sync.ts`

## 背景

tavily-search 这类 skill 以 CLI 形式被模型调用，凭据靠 `os.Getenv` 或 `--env-file ~/pi-teacher/.env` 取得。ADR-0029 为此设计了两个可写的源（容器 env、`.env` 文件）加一套「env 优先、启动时单向覆盖同步」规则，还要靠运维守则解释「谁管哪个 key」。这个结构的问题不是不优雅，而是**双源**：同一个 key 两处可写，必然需要同步规则与优先级说明，而每条规则都是一次排障时要回忆的东西。用户以后自己接 skill，还要再改一次代码里的白名单。

事实核对（Pi 0.84.2 源码）：bash 工具每次执行都 `{ ...process.env }` 现拷（`core/tools/bash.js` 的 `resolveSpawnContext` → `utils/shell.js` 的 `getShellEnv()`），不是启动时缓存。因此后端在**运行期**修改 `process.env`，模型下一次调用 CLI 就拿到新值，无需重启会话。tavily-search 的 `getSetting()` 先查 env 再查 dotenv，env 命中时 `.env` 文件根本不需要存在。

## 决策

**SQLite 是用户环境变量的唯一源；后端把它们注入自己的 `process.env`；`.env` 文件取消。**

- 新表 `user_env(key TEXT PRIMARY KEY, value TEXT NOT NULL)`。任意合法变量名都能存，不限白名单——用户接自己的 skill 时直接在界面加一行，不改代码。
- **内置项**是代码常量（起步：`TAVILY_API_KEY`、`TAVILY_BASE_URL`、`TAVILY_TIMEOUT`）：未设置时也出现在列表里，让用户知道产品自带的 skill 要填什么；不可删行只可清值。
- **明文存储、明文回显**：值原样进表、原样回给浏览器，`PATCH` 语义就是「字符串覆盖」，没有掩码 / 三态；清除走 `DELETE`。这一点与 ADR-0032 的 models.json 出口规则**不同**，理由见下。
- **受保护的变量名**不允许从界面设置：会改变后端进程自身或动态链接器行为的（`PATH`、`HOME`、`NODE_OPTIONS`、`LD_PRELOAD` 等）以及 `PI_TEACHER_` / `PI_CODING_AGENT_` 前缀。设错这些，服务本身就起不来。
- 注入时机：启动时把表里全部行写入 `process.env`；界面每次保存 / 删除后立即同步（设值或 `delete`）。子进程继承，skill 走 env 分支。
- 容器 env 只做**首次导入**：启动时表里没有某个内置项而 `process.env` 有，就把 env 的值写进表。之后表为准——容器 env 后来改了也不覆盖表里的值。这是「env 帮你把第一次部署配好」，不是「env 是另一个源」。
- 旧 `~/pi-teacher/.env`：启动时若存在，其中表里没有的 key 导入一次，然后**不删文件也不再读写**。文档告知用户可以删掉它。
- WebUI：设置面板「高级配置」末尾加「用户环境变量」区块。
- `env-sync.ts` 删除；`ServerOptions.envFilePath` 删除。

## 为什么不是别的

- **只用容器 env、去掉一切文件**：改一个 key 要重建容器；宿主机直跑没有可配的地方；否决。
- **保留 `.env` 作为唯一源、去掉同步**：文件手工维护，WebUI 要做就得再做一次原子写 + 掩码，等于把 models.json 那套再抄一遍到另一种文件格式；而数据库已经有事务、有 UI 数据通路；否决。
- **每次调用 skill 前临时拼 env 传给子进程**：Pi 的 bash 工具不暴露按次注入 env 的钩子（`spawnHook` 在 0.84.2 是内部实现），要绕就得改桥接层；`process.env` 一处赋值即可，否决。
- **只存白名单**：每接一个 skill 改一次代码，用户自己的 skill 没法配；否决。
- **加密存储**：加密密钥本身无处安放，只是把明文挪个地方；SQLite 在 `data/` 下 0600，与 cookie.key、models.json 同级别；否决。
- **界面隐藏值（`secret` 标记 + 掩码回显）**：实现过又撤掉。库不加密、单用户本机部署，前端遮一层只是让用户看不到自己填的值，排障时反而要「删掉重填」才能确认；它还把 ADR-0032 的三态语义、掩码常量、「隐藏标记不可切换」等一整套规则拖进这张表。用户明确判断「数据库都没加密，前端隐藏没意义」，否决。

## 后果

- `~/pi-teacher/` 目录里不再有密钥明文文件；密钥只在 SQLite 和进程内存里。备份数据库即备份密钥，与 ADR-0022「复制整个目录就是备份」一致。
- 删除某个内置项后重启，若容器 env 仍带该变量，会再次导入——「首次导入」以「表里没有」为判据，不做墓碑。要彻底去掉就同时从容器 env 移除。
- 运行期 `process.env` 会被后端主动修改；验证脚本用独立的 key 名并在结束时清理。
- secret 边界仍只有一处：`pi-config.ts`（models.json）。`user_env` 的值在 HTTP 响应里是明文，验证脚本对它不做「响应不含 secret」断言；日志仍只打 key 名。
- 曾短暂存在的 `secret` 列由 `initializeSchema` 的幂等迁移（`PRAGMA table_info` 探测 + `ALTER TABLE … DROP COLUMN`）去掉，行数据不动。
- 密钥进入模型可执行的 shell 环境是本来就成立的事实（skill 靠它工作），本决策不改变该边界；ADR-0029 的挂载与 skill 位置约定不变。
