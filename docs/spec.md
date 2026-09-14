# spec — 经验库

> 记录开发中的 bug 与重要经验。检索时只看三级标题（grep "### "），禁止整读本文件。
> 格式：### bug 简要描述（50 字内）/ bug原因（150 字内）/ bug影响与触发条件 / 解决方法（可详细写）

### due 存 ISO 格式导致到期查询永假
bug原因: card_schedule.due 存了 `toISOString()` 产物（`T` 分隔），查询条件 `due <= datetime('now')` 是 SQLite 空格分隔格式。TEXT 比较时 `'T'`(0x54) > `' '`(0x20)，ISO 字符串恒大于任何 SQLite 格式时间串。
bug影响与触发条件: 任何「字段既被 datetime('now') 比较又由 JS Date 写入」的场景必踩。到期查询永远空集，复习流程静默失效——不报错、最难发现。
解决方法: 写库统一 `dateToSqliteText()`（`toISOString().replace('T',' ').replace(/\.\d+Z$/,'')`）；V8 的 `new Date('YYYY-MM-DD HH:MM:SS')` 可解析该格式，读侧直接构造。schema 的 `DEFAULT (datetime('now'))` 列同理。

### ts-fsrs 关多步学习后的行为边界
bug原因: ts-fsrs 5.x 默认 `learning_steps: ['1m','10m']`，新卡首判后 due 在当天；AI 对话式批量复习与同天重弹不匹配。
bug影响与触发条件: 开启默认 steps 且不在 card_schedule 加 learning_steps 列时，持久化丢步骤进度，卡永远困在 Learning 小循环。
解决方法: `learning_steps: [], relearning_steps: []` 关闭多步（实测全路径最短 24h：新卡 Good→48h、Again→24h、成熟卡 Again→168h），表无需加列，字段恒 0 映射层丢弃。

### typebox 1.3.7 拆分包导入路径
bug原因: 新版 typebox 把 schema builders 拆到子路径导出，`typebox/type/index.mjs` 等子模块没有 `Type` 命名空间；只有根入口 `typebox` 有。
bug影响与触发条件: 按旧文档 `import { Type } from "typebox/type"` 或直接 require 子路径时报 undefined。
解决方法: 统一 `import { Type } from "typebox"`（根入口）；对齐 pi-coding-agent 的依赖版本（1.3.7）避免双实例。

### 会话注册表键名不统一：注册用 SDK 内部 id，查询用 jsonl 路径
bug原因: pi 的 SessionManager 不传 id 时 `sessionId = uuidv7()`（随机短 id），而宿主业务层习惯用 `sessionFile`（jsonl 路径）寻址会话。两者是不同字符串，注册与查询键不一致必然 miss。
bug影响与触发条件: 任何「桥接 SDK 会话 + 外部按文件路径寻址」的宿主架构必踩（pi-web 自己用 sessionId 与路径混用，本宿主一路用路径就撞上）。表现为会话「不在运行」、SSE 订阅 404、事件永不达。
解决方法: 注册表双 key——`wrapper.sessionId`（SDK id）与 `sessionFile`（jsonl 路径）都映射到同一 wrapper，destroy 时两个都清；遍历列表按 wrapper 对象去重。对外统一用 jsonl 路径，SDK id 仅内部事件。

### AgentSessionWrapper 生命周期回调设成单槽会被互相覆盖
bug原因: `onDestroy(cb)` 用私有单字段赋值，第二次调用（如测试打点）会替换掉第一次（注册表清理），被覆盖的回调永远不执行。
bug影响与触发条件: 凡是「框架注册清理逻辑 + 外部监听并存」的表层都会踩——外部一旦注册回调，框架自身的销毁清理悄悄失效，内存泄漏级 bug 且无报错。
解决方法: 生命周期回调一律用监听器数组（push + 逐个 try/catch），不要单槽赋值；这同时让框架内部与调用方可安全共存。

### tsx 的 `-e` 内联脚本走 CJS，无法 import 仅有 ESM exports 的包
bug原因: `npx tsx -e "..."` 以 CommonJS 求值，`@earendil-works/pi-coding-agent` 的 package.json 只声明 ESM `exports`，Node 报 `ERR_PACKAGE_PATH_NOT_EXPORTED`。
bug影响与触发条件: 想临时用一行命令验证 SDK 行为（不写文件）时必踩；工程内 `.ts` 文件不受影响。
解决方法: `node --import <tsx>/dist/loader.mjs --input-type=module -e "..."`，或直接写临时 `.ts` 文件用 `npx tsx file.ts`。

### 真模型验收不能用「注入文本里的字样」做断言
bug原因: 助教一次性注入的主会话简介包含主会话标题；真模型在回答里复述了标题，导致「下一轮不再注入」的字样断言误判为泄漏。
bug影响与触发条件: 任何用真模型做「上下文不再出现」类断言的验收，只要模型在历史里回显过该内容就会抖动。
解决方法: 断言注入的**信封**（`<pi-teacher-context>` 自定义消息）出现次数，而不是简介正文字样；JSONL 不落历史也按信封判断。

### Pi SDK 工具结果会把真实 cwd/JSONL 路径带进对话上下文
bug原因: `read_file`/`list_dir` 等工具输出、`session.cwd` 都含服务端绝对路径；`/context` 与 SSE 直接透传 SDK 消息就把部署路径给了前端。
bug影响与触发条件: 只过滤「列表接口」字段不够，模型一调文件工具就泄漏；验收里对所有 JSON 响应做 `homeDir` 全文断言才发现。
解决方法: 统一出口投影 `clientView(value, row, homeDir)`（递归替换 `row.path`→业务 ID 标记、`work_path/`→相对路径、`homeDir`→固定前缀），HTTP 与 SSE `encode` 共用，只改展示，不改 SDK 内存与持久化内容。

### Tailwind v4 里 `@layer components` 定义的类不能被 `@apply`
bug原因: v4 的 `@apply` 只识别 utility 与 `@utility` 声明的类，普通 `.btn {}` 即使放在 `@layer components` 也是「未知工具类」。
bug影响与触发条件: 想写 `.btn-primary { @apply btn ... }` 这类组合式组件类时构建直接失败 `Cannot apply unknown utility class`。
解决方法: 复用类改用 `@utility btn { ... }`，其它规则即可 `@apply btn`；设计令牌放 `@theme`。

### EventSource `onerror` 的异步状态探针会盖掉重开后的新连接状态
bug原因: 会话回收时旧 EventSource 报 error，处理器异步查 `/status` 得 404 后写「已回收」；若用户此时点「重新打开」并建立了新连接，迟到的回调把新连接状态改回「已回收」。
bug影响与触发条件: 回收→立即重开这条路径必现：后端已 alive，UI 却显示已回收且不可发送。
解决方法: `connect()` 递增代次 `generationRef`，异步回调只在代次仍是当前时才写状态；`sendCommand` 遇 `session_recycled` 先按稳定 ID `open` 再重试一次，用户无需手动重开。

### Pi SDK 图片块是扁平 `{type:"image", data, mimeType}`，不是 Anthropic 的 `source` 包装
bug原因: 按 Anthropic Messages 结构写 `block.source.mediaType`，实际 SDK JSONL/事件里是 `block.data` + `block.mimeType`，渲染时抛 TypeError。
bug影响与触发条件: 发送带图附件后，整个对话页 React 树因单条消息崩溃白屏。
解决方法: 类型按 SDK 定义（`ImageContent { data, mimeType }`）；同时给每条消息包一层 ErrorBoundary，单条渲染失败只降级该条。

### `pkill -f "tsx src/index.ts"` 会把发出命令的 bash 自己一起杀掉
bug原因: `pkill -f` 匹配完整命令行，发起 pkill 的 shell 命令行里也含同一字串，于是自己被 SIGTERM（退出码 144）。
bug影响与触发条件: 任何用 `pkill -f <脚本名>` 停开发服务的场景；后台服务和当前 shell 一起死，后续命令全部失联。
解决方法: 按端口找 pid（`ss -lptn 'sport = :PORT'` 提取 `pid=`）再 `kill`；或后台任务用 `kill %1`。要让服务活过启动它的 shell，用 `(setsid npx tsx src/index.ts &)`。

### 会话级工具上下文是启动时闭包快照，只改数据库会得到假开关
bug原因: `SessionToolContext` 在会话构造时捕获 `enable_make_card` / `teach_style_id`，后续 PATCH 只更新数据库，运行中的会话看不见。
bug影响与触发条件: 任何「会话运行期可切换」的设定。制卡开关 UI 显示已关但工具仍放行；教学风格切换后 system prompt 不变。
解决方法: 分两类处理。制卡开关改为工具执行时实时查库（`isMakeCardEnabled()`）；教学风格因走 `appendSystemPrompt`（只在构造时读一次）必须重投影 `style.md` + 按稳定 ID 重开同一 JSONL（ADR-0031）。

### 模型目录是进程内单例缓存，配置写盘后界面看起来「保存无效」
bug原因: `server/src/session/models.ts` 的 `ModelRuntime` 首次创建后缓存，`models.json` 变更不会自动重载。
bug影响与触发条件: 通过 WebUI 保存 provider / 模型配置后，模型选择器与默认模型仍是旧目录。
解决方法: 每次成功写 `models.json` / `settings.json` 后显式调用 `refreshModelCatalog()` 失效重建；`PI_TEACHER_PROVIDER` / `PI_TEACHER_MODEL` 存在时界面必须显示被环境固定并禁用编辑。

### 脱敏 JSON 视图直接回存被白名单拒绝
bug原因: provider 的脱敏视图为了「便于核对」保留了 Pi 管辖字段（`compat`、`models[].reasoning`、`contextWindow`），而 `readProviderPatch` 对这些字段一律 400。
bug影响与触发条件: 「打开高级 JSON → 不改 → 保存」这一最自然动作必然失败——真浏览器验收才发现，脚本验证没覆盖。
解决方法: 视图→补丁的路径（`providerPatchFromJson`）过滤而非拒绝 Pi 管辖字段，`mergeProvider` 原样保留它们，并把被忽略的字段名以 warning 回报；`config-check` 增加「视图原样回存」回归块。教训：脱敏出口与写入白名单必须同一个人同一次对齐。

### 掩码占位符不能被当成新 secret 写回
bug原因: 前端把 `••••••••` 回传，若后端按「非空字符串=覆盖」处理，真实 apiKey 会被掩码字符串替换。
bug影响与触发条件: 任何带脱敏回显的编辑表单；用户只改了名字也会把凭据毁掉。
解决方法: 三态语义——字段缺省=保持、`null`=清除、非空字符串=覆盖，但等于固定掩码的字符串视为保持；空串也视为保持（清除必须显式 `null`）。写盘用同目录临时文件 + `renameSync`，候选文件先过 `ModelRuntime.create` 校验，保持 0600（ADR-0032）。

### Material Symbols 靠连字渲染，祖先 `text-transform: uppercase` 会让图标显示成字面文字
bug原因: 图标字体按 `support_agent` 这样的连字名匹配字形；`uppercase` 把文本变成 `SUPPORT_AGENT`，连字失配，浏览器直接画出字母。
bug影响与触发条件: 图标 span 放进任何带 `uppercase` 的容器（本项目是 `label` 工具类）。
解决方法: `icon` 工具类显式 `text-transform: none`；并从 `label` 上去掉 `uppercase`（本产品领域术语如 `Agents Md` 有固定大小写，强制大写本身就不对）。

### agent-browser 真浏览器验收的几个非直觉点
bug原因: 工具语义与 DOM 事件不完全对应。
bug影响与触发条件: `fill` 不触发键盘事件（斜杠菜单要用 `type`）；`has-text()` 伪类不可用；`select` 的值是 `<option value>` 而非显示文本；无障碍快照里 `<option>` 常标 `[disabled]` 但真实 DOM 并未禁用；合成 `MouseEvent` 的 `target` 不等于 `currentTarget`，测遮罩点击关闭要用 `mouse move/down/up` 真实坐标。
解决方法: 先 `snapshot` 拿 `@eN` ref 再操作；DOM 状态疑点用 `eval` 直接查属性；任何断言以文件系统 / 数据库 / 网络响应为准，不以快照文本为准。

### 真模型会把注入信封标签原样复述进回答，再随历史污染后续 payload 断言
bug原因: http-smoke「下一轮不再注入主会话简介」对整段 provider payload 做 `includes("<pi-teacher-context>")`。某轮真模型在回答里照抄了标签名，这段 assistant 文本进入会话历史后，下一轮 payload 必然含该字样，断言误报泄漏。
bug影响与触发条件: 任何「注入内容不落历史」类断言，只要模型有可能复述标签/关键字就会随机失败；失败片段只截 payload 前 300 字，看到的永远是系统提示词开头，定位不到来源。
解决方法: 解析 payload 的 `messages`，只把非 assistant 消息里出现信封算作我们的注入（`payloadHasNonAssistantEnvelope`）；诊断片段用 `excerptAround` 取命中点前后而不是开头。与「真模型验收不能用注入文本里的字样做断言」是同一原则的 payload 侧版本。

### 浏览器验收不知道真实账号密码，也不能碰真实 ~/pi-teacher
bug原因: 开发环境的后端跑在用户真实数据目录上，账号密码只有用户知道；用 http-smoke 的密码去登只会得到「用户名或密码错误」，改真实库又违反「不动用户数据」。
bug影响与触发条件: 任何需要登录的真浏览器验收。
解决方法: 起第二套隔离环境：`PI_TEACHER_HOME=$(mktemp -d) PORT=39872 npm run dev` 后 `curl POST /api/auth/setup` 建一次性账号；前端 `PI_TEACHER_API_PORT=39872 npx vite --port 5177`（`vite.config.ts` 用 `loadEnv` 读该变量决定代理目标）。验收完 kill 两个 PID 并删临时目录，用户自己的 39871 / 5176 不受影响。

### 运行期改 `process.env` 对 Pi 的 bash 工具立即生效，不必重开会话
bug原因: 直觉上子进程环境在会话创建时就固定了。实际 pi-coding-agent 0.84.2 的 bash 工具每次执行都走 `resolveSpawnContext` → `getShellEnv()`，后者当场 `{ ...process.env }`（`dist/core/tools/bash.js`、`dist/utils/shell.js`），没有任何缓存。
bug影响与触发条件: 决定「保存用户环境变量要不要 reload 会话」时容易多做一步；反过来，验证脚本若只查 `process.env` 而不真的 spawn，证明不了 skill 能看到。
解决方法: 保存后只写 `process.env`（`config/user-env.ts`）；断言用真模型让 bash 执行 `echo $KEY` 并检查 toolResult 内容（http-smoke [8b]）。注意 `tsx` 的 `--env-file` 等启动期注入不在此列——那些只影响进程启动时的初值。

### `pkill -f "PORT=39872"` 同样会杀掉发出命令的 shell
bug原因: 与上面 `pkill -f "tsx src/index.ts"` 同一机制——模式字串出现在自己的命令行里。用环境变量赋值当匹配串（`PORT=`、`PI_TEACHER_HOME=`）时尤其容易忽略这一点。
bug影响与触发条件: 一条复合命令里先 `kill <pid>` 再 `pkill -f` 兜底，兜底反而把后续的 `rm -rf` 临时目录、`ss` 检查全部截断（退出码 144），看起来像清理成功实则没做。
解决方法: 清理隔离验收环境只按记录的 PID `kill`，再用 `ss -lptn 'sport = :PORT'` 确认端口空了；不要用 `pkill -f` 兜底。

### 同一会话挂两条 SSE 时，第二条收不到 `session_recycled`
bug原因: `AgentSessionWrapper.emit` 直接 `for…of this.listeners`，而 SSE 流的 `forwardEvent` 收到 `session_recycled` 后同步 `cleanup` → `unsubscribe`，即 `listeners.splice(i, 1)`。遍历中删除当前元素让下一个监听者被跳过。
bug影响与触发条件: 只要同一会话有 ≥2 个监听者（浏览器重连后旧流未断、验收脚本先 `openEvents` 再 reopen 又 `openEvents`），destroy 时只有第一条流收到回收事件并关闭，第二条一直挂着；`waitFor(session_recycled)` 超时，看起来像删除没 shutdown。单条 SSE 的场景完全正常，所以此前没暴露。
解决方法: `emit` 遍历 `[...this.listeners]` 快照。http-smoke [10] 故意在 [9] 留下的第二条流上断言也收到 `session_recycled`。

### 清除助教后新 JSONL 不是「只有 header」
bug原因: `createEmptySessionFile` 只写 SDK header，但 `startWorkspaceSession` 重开时 `createAgentSessionFromServices` 立即把默认模型与思考等级落盘（`model_change`、`thinking_level_change` 两条），空历史文件实际有 3 行。
bug影响与触发条件: 断言「清除后 JSONL 只有一行」必然失败；按行数判断「空对话」也会误判。
解决方法: 判断空历史只看有没有 `type === "message"` 条目，header 的 `id` 仍等于 `sessionKeyFor(id)`。

### `npm ci --omit=dev` 在 slim 镜像里对 better-sqlite3 合成 `node-gyp rebuild`
bug原因: better-sqlite3 13 的 package.json 写了 `gypfile: false` 且自带 `prebuilds/linux-x64.node`，宿主机 `npm install` 从不编译。但 `npm ci` 按 lockfile 建树，lockfile 只记 `hasInstallScript`，不记 `gypfile`；npm 11 的 `@npmcli/arborist/lib/install-scripts.js` 看到磁盘上有 `binding.gyp` 就合成一条 `install: node-gyp rebuild`，`node:24-slim` 没有 Python / make / g++，构建在 `server-deps` 阶段失败。
bug影响与触发条件: 任何在 lockfile 驱动下装 better-sqlite3 的精简镜像；宿主机复现方法是把 `package.json` + `package-lock.json` 拷到空目录跑 `npm ci --omit=dev --foreground-scripts`，能看到 `> better-sqlite3@13.0.3 install / > node-gyp rebuild`。
解决方法: Dockerfile 用 `npm ci --omit=dev --ignore-scripts`。运行时 `lib/binding.js` 直接 `require('../prebuilds/linux-x64.node')`，不需要 `build/`；其余带 install 脚本的生产依赖（esbuild 的 `install.js` 只校验 `@esbuild/linux-x64`、protobufjs 的 postinstall 只整理版本号、`@google/genai` 的 preinstall 是 echo）跳过也不影响运行。镜像里依旧没有 python3，`verify:remote` 已在容器上跑通。

### compose 的 `${VAR:-}` 会把未设置的环境变量变成空串
bug原因: `compose.yaml` 用 `PI_TEACHER_PROVIDER=${PI_TEACHER_PROVIDER:-}` 透传可选变量，宿主没设时容器里得到的是 `PI_TEACHER_PROVIDER=`（空串）而不是「没有这个变量」。后端 `selectDefaultModel` 与 `readDefaultModel` 用 `??` 取值，空串不是 nullish，默认模型变成 `""`，`settings.json` 的默认值被空串遮住。
bug影响与触发条件: 只在容器里、且没有显式设 `PI_TEACHER_PROVIDER` / `PI_TEACHER_MODEL` 时；宿主机直跑不会出现（变量真的不存在）。
解决方法: 读这两个变量的地方一律 `||`（`session/models.ts`、`config/pi-config.ts`），`assertDefaultModelEditable` 本来就是真值判断不受影响。新增可选透传变量时照此办理，或者在 compose 里不写默认值让变量整体缺席。

### HTTP payload 验收会误取自动标题生成请求
bug原因: `session/title-generator.ts` 为独立标题调用创建临时 Agent 时复用来源 Agent 的 `onPayload`，因此同一捕获数组也会收到标题请求。最后一次请求的最后一条 user 消息可能是 `TITLE_PROMPT`，不是本轮用户输入。
bug影响与触发条件: 尚未命名的 Pi Session 首轮结束后自动生成标题；真实复习会话复现为同一轮捕获两次请求，按数组末项断言基础提醒会失败，第二轮不再生成标题时又能通过。这不等于精华提醒泄漏进复习会话。
解决方法: `verify/http-smoke.ts` 用 `payloadForPrompt()` 按本轮原始输入定位对话请求，再严格比较整条用户消息与基础 / 精华文案；历史检查也读取该请求。不要禁用标题生成来规避，也不要只检查整个 payload 是否包含提醒字样。

### `parseArgs` 的 `allowNegative` 要声明正向名，不能声明 `no-xxx`
bug原因: Node `node:util.parseArgs` 开 `allowNegative: true` 后，`--no-cache` 的含义是「把布尔项 `cache` 置为 false」。若在 `options` 里直接声明一个名叫 `no-cache` 的布尔项，`--no-cache` 会被当成「否定 `no-cache` 这一项」，解析结果是 `{ "no-cache": false }`——读 `values["no-cache"]` 得到 `false`，与用户意图正好相反，缓存永远关不掉。
bug影响与触发条件: 写 CLI 时凭直觉按命令行字面量声明选项名就会踩；`--no-xxx` 默认值为 `false` 时更隐蔽，因为不传和传都是 `false`，只有对照上游行为才发现开关失效。
解决方法: 声明正向名（`cache: { type: "boolean", default: true }`），读 `values.cache`；`--no-cache` 自然得到 `false`。`skills/pullpage/scripts/pullpage` 里 `cache` 与 `only-main` 都按此写，并在 options 上留了注释说明原因。

### esbuild 打包 npm CLI 必须 `--format=esm` 外加 `createRequire` banner
bug原因: 把 `@xyzensun/sbx` 打成单文件时，`--format=cjs` 会让依赖里的 `createRequire(import.meta.url)` 退化成用未定义的 `__filename`，运行即 `ERR_INVALID_ARG_VALUE ... Received undefined`；只给 `--format=esm` 又会因为依赖内部有同步 `require("util")` 死在 `Error: Dynamic require of "util" is not supported`。两种单一格式都不可用。
bug影响与触发条件: 依赖树里同时存在 CJS 与 ESM 写法的包（云沙箱 SDK 这类聚合包很常见）；只跑 `--version` 可能侥幸通过，真正调用到相关代码路径才崩。
解决方法: `--format=esm` 配 `--banner:js='import{createRequire as __cr}from"module";const require=__cr(import.meta.url);'`，给 ESM 产物补一个真实的 `require`。完整重建命令与验证步骤记在 `skills/sbx/sourcecode/README.md`，升级换版本只改安装命令。

### 无扩展名的 ESM 脚本会被上层 package.json 的 `type` 判成 CJS，症状是静默退出 0
bug原因: skill 的可执行脚本按 Pi 约定不带扩展名（`scripts/tavily-search`），Node 判定它是 ESM 还是 CJS 的依据是**向上查找到的最近一个 `package.json` 的 `type` 字段**。若该文件写着 `"type": "commonjs"`（或没有 `type`），脚本里的 `import` 就被当 CJS 解析——而 Node 对这种情形**不报错**，直接什么都不做、退出码 0。
bug影响与触发条件: 把脚本复制到临时目录测试时最容易踩。我在 `/tmp` 下验证 `.env` 兜底时，`/tmp/package.json`（一个与本项目无关的遗留文件，`"type": "commonjs"`）让同一份字节在仓库目录正常、在 `/tmp` 下零输出退出 0，排查了很久才定位。真实部署路径（容器 `/root/.pi/agent/skills/`、宿主 `~/.pi/agent/skills/`）上无 `package.json`，现网不受影响。
解决方法: 在临时测试目录放一个 `{"type":"module"}` 的 `package.json`，或直接在 skill 原目录测。遇到「脚本无输出、退出码 0」先查 `ls` 各级父目录的 `package.json`，不要怀疑脚本逻辑——真有逻辑错误会抛异常而不是静默成功。

### Node 24 会截获脚本参数里的 `--env-file`
bug原因: `--env-file` 是 `node` 本身的 CLI 选项，且即使出现在脚本路径**之后**也会被 Node 吃掉，不会传给 `process.argv`。文件不存在时 Node 直接报 `node: <path>: not found` 并退出 9，看起来像脚本报的错。
bug影响与触发条件: 三个 Node skill（`tavily-search` / `pullpage` / `exa-search`）一致。验证「`--env-file` 已废除」时会看到 Node 的报错而非预期的「未知参数」，容易误判成脚本没拦住。
解决方法: 不必在脚本里显式拒绝 `--env-file`，Node 已经让它不可用；断言时改用其他未知 flag（如 `--bogus-flag`）验证 `parseArgs` 的 `strict: true` 生效。

### `verify:remote` 的 skill 探针轮偶发 240 秒超时，重跑即过
bug原因: 该轮要求真模型在一次回复里用 bash 跑完四条 skill 命令（`remote-check.ts` 的 `skillProbePrompt`），比普通对话重得多。手动复现同一 prompt 实测约 60 秒，但模型偶尔会在这一轮上耗尽 240 秒的 `waitFor`，报「等待超时：SSE prompt_done（真模型完成回复）」。
bug影响与触发条件: 与被验证的代码无关，换慢模型（如 agnes-2.5-flash）时更容易命中。`http-smoke` 末尾的真模型轮同理，曾因同一原因超时，换 octopus / deepseek-normal-latest 后 522 项一次过。
解决方法: 先重跑一次再怀疑代码；跑之前把默认模型指向快的 provider——`http-smoke` 用 `PI_TEACHER_PROVIDER=octopus PI_TEACHER_MODEL=deepseek-normal-latest npm run http-smoke`（脚本内是 `??=`，环境变量能覆盖默认的 agnes），容器则在 `docker compose up -d` 时带上同名变量。排查时不要手搓 curl 复现：`POST /api/conversations` 的字段是 `spaceId` + `agentsMdId`（不是 `workspaceId`），`POST /command` 的字段是 `message`（不是 `text`），且 SSE 在独立的 `GET /api/conversations/:id/events`，猜错字段只会收到 400 而看起来像「模型不回」。

### 模型目录单例与界面外配置修改脱节，表现为「设置页已配置、模型列表 503」
bug原因: `getModelCatalog()`（`server/src/session/models.ts`）是进程级单例，只在界面内保存 provider 配置时经 `refreshModelCatalog()` 重载。用户在界面外改 `~/.pi/agent/models.json` 或 `auth.json`（pi CLI 配置、手动编辑、CLI 版本升级迁移）后端无从得知；`selectDefaultModel` 的 provider/modelId 每次 `SettingsManager.create` 现读 settings.json，而 available 快照停在启动时——settings 要新组合、旧快照里没有，`GET /api/models` 抛 503。同机的 `/api/config/models` 每次现读 models.json 显示「已配置」，两个接口数据源脱节是定位线索。
bug影响与触发条件: 长期运行的后端 + 任何界面外的配置修改。症状是对话框模型选择器只剩「未配置模型」（前端在 models 为空时的兜底文案），设置页却一切正常。
解决方法: `getModelCatalog()` 里比较 models.json + auth.json 的 (mtimeMs,size) 指纹，发现磁盘变化自动 `refresh({ allowNetwork: false })`，重载失败退回旧目录而不是 500；验证脚本 `npm run verify:catalog`。settings.json 不用纳入指纹——默认模型本来就每次现读。另注意 `GET /api/models` 对默认模型不可用已降级为列表照常返回 + `defaultModel: null`，开会话路径仍抛 503。

### tsx 直跑的后端进程不会热重载，新前端 + 旧后端进程组合会把缺字段白屏
bug原因: `npm run dev` 用 tsx 直跑 TS，进程只在启动时编译加载一次，磁盘代码后续变更不影响运行中进程；而 Vite dev 是按需热更新的。两者版本错位时（本次：后端 Sep10 启动、`97dd87c` Sep11 才落地 `setting` 表与 `app` 字段），新前端渲染 `settings.app.reminderIntervalTurns` 在 undefined 上抛 TypeError，React 无 ErrorBoundary 时卸载整棵树——「加载中然后白屏、其他 tab 正常」。
bug影响与触发条件: 任何「改了后端代码但只重启了前端（或都没重启）」的 dev 流程；症状是特定 tab 白屏且浏览器控制台有 TypeError。
解决方法: 改后端代码后重启 `npm run dev` 进程；数据库缺表由 `initializeSchema` 幂等补建（`CREATE TABLE IF NOT EXISTS`），重启即自愈。前端已加顶层 ErrorBoundary（`web/src/ui/ErrorBoundary.tsx`），未来渲染错误显示可读错误页而非白屏。

### setsid 后台跑验证脚本，残留进程会往被覆盖的日志里写旧结果，造成「假失败」
bug原因: 用 `(setsid npm run http-smoke > log &)` 起的验证进程不受外层 bash 超时影响；外层超时后进程继续跑，最终把失败写进日志文件。下一轮验证用 `>` 截断同名日志时，残留进程仍持有旧句柄按原偏移写入——新日志里出现「上一轮的失败」，看起来像新代码失败。
bug影响与触发条件: 连续多轮后台跑同名日志的验证脚本，且前一轮因模型慢等原因超时未结束。
解决方法: 起下一轮前 `pkill -f <脚本名>` 确认清场，或每轮用不同日志文件名；判断真假失败以「断言计数 + 进程存活 + 耗时是否合理」交叉验证（180 秒的 waitFor 不可能 30 秒超时）。

### 展示类 URL 里的文件路径必须 percent-encode，否则被 clientView 路径投影改写成死链
bug原因: `projection/client-view.ts` 对所有出口字符串做字面子串替换（`/root/… → ~/…`、work_path → `.`）。img_display 的展示指令里若放裸绝对路径（`/api/images?p=/root/pi-teacher/…png`），`/root/` 前缀会被替换成 `~/`，浏览器请求一个不存在的路径；`encodeURIComponent` 之后子串不再匹配，投影不碰它。
bug影响与触发条件: 任何把服务端绝对路径拼进 URL 下发给前端的场景（图片展示是第一个）；症状是图 404 且 URL 里出现 `~/`。
解决方法: 路径进 URL 前一律 `encodeURIComponent`（`server/src/tools/images.ts`）；http-smoke 有断言钉住「历史重载后 URL 不被投影改写」。

### Pi 原生命令不进 RPC 的 get_commands，/ 菜单看不到 compact 是数据源问题不是命令缺失
bug原因: Pi 的 `BUILTIN_SLASH_COMMANDS`（compact/model/export 等 22 个）是 TUI 交互层命令；RPC 模式的 `get_commands` 只返回 extension 注册命令 + prompt 模板 + skill 三类（rpc-mode.js 的 get_commands case）。且 SDK 的 `prompt()/steer()/followUp()` 只展开 skill 与模板命令，把 `/compact` 当消息发会被模型当普通文本。
bug影响与触发条件: 任何「前端 `/` 菜单只吃 get_commands」的实现都永远看不到原生命令；症状是后端命令面完整（`{type:"compact"}` 全通）但界面无入口。
解决方法: 前端维护「WebUI 支持的原生命令」静态白名单合并进菜单（`web/src/chat/native-commands.ts`），提交时在 prompt/steer 分流之前解析并改走命令通道——否则运行中的 `/compact` 会被 steer 成字面文本。另：压缩事件（compaction_start/end）bridge 全量转发但前端要自己处理，压缩后必须 refreshContext（历史被改写为 compaction 摘要条目）。
