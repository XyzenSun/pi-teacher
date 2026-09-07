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
