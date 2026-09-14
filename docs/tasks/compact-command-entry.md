# compact 命令入口（/ 菜单支持 Pi 原生命令）

## 背景

用户在对话框输入 `/` 只能看到 skill 与插件注入的命令，调不了 Pi 原生的 `/compact`。

根因（已核实）：

- Pi 的原生命令分两层：`BUILTIN_SLASH_COMMANDS`（compact / model / export 等 22 个）是 **TUI 交互层**命令；RPC 模式的 `get_commands` 只返回 **extension 注册命令 + prompt 模板 + skill** 三类（`rpc-mode.js` 的 `get_commands` case），原生命令永远不进这个列表。
- 直接把 `/compact` 当消息发也**不生效**：SDK 的 `prompt()` / `steer()` / `followUp()` 只展开 skill 命令与 prompt 模板，原生命令会作为普通文本发给模型。
- 后端链路其实全通：`POST /api/conversations/:id/command` 支持 `{type:"compact", customInstructions?}`（运行中 409）与 `{type:"abort_compaction"}`；前端 `SessionCommand` 类型也已包含两者。**唯一缺的是 UI 入口。**
- 附带缺口：SDK 会发 `compaction_start` / `compaction_end` / `auto_compaction_end` 事件（bridge 全量转发），但前端 `useConversation` 不处理——压缩完成后界面历史不刷新，`isCompacting` 运行态也只在拉 context 时才更新。

## 决策（用户拍板）

- 入口形态：`/` 菜单合并静态白名单 + 支持后缀参数（`/compact 保留代码示例` → customInstructions）；压缩中菜单显示 `abort_compaction`。
- 实施顺序：本任务先行，灯箱任务随后。

## 实现

1. `web/src/chat/native-commands.ts`（新）：WebUI 支持的原生命令静态表（`compact`、`abort_compaction`）+ `parseNativeCommand()` 文本解析（命令名整词匹配，余文作参数）+ `nativeCommandsFor(runtime)` 按运行态过滤菜单项。原生命令与 skill 重名时原生命令优先（与 Pi TUI 的优先级一致）。
2. `ChatInput`：新增 `onNativeCommand` prop；`submit()` 在 prompt/steer 分流**之前**先解析原生命令，命中即走命令通道——避免运行中被 steer 成字面文本。
3. `ChatPanel`：把 `nativeCommandsFor(runtime)` 合并进 `/` 菜单列表；`onNativeCommand` 映射到既有 `sendCommand({type:"compact", customInstructions})` / `{type:"abort_compaction"}`。
4. `useConversation`：处理 `compaction_start`（置 `isCompacting`）、`compaction_end` / `auto_compaction_end`（复位并 `refreshContext`——压缩后历史含 compaction 摘要条目，必须重拉）。

后端零改动（命令面已完整）。

## 验证

- 前端 typecheck；浏览器手验：`/compact` 菜单出现、带参执行、压缩中 abort、压缩后历史刷新出现「上下文压缩摘要」、运行中提交 `/compact` 得到 409 文案而不是把命令发给模型。
