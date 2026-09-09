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
bug影响与触发条件: 想临时用一行命令验证 SDK 行为（不写文件）时必踩��工程内 `.ts` 文件不受影响。
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
