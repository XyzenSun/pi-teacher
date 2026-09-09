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
