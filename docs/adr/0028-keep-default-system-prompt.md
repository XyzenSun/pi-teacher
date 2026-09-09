# 不替换 Pi 的默认系统提示词

不用 `--system-prompt` 替换 Pi 的默认系统提示词，也不用 `--append-system-prompt` 注入业务内容。教学角色、判据、原则全部走 AGENTS.md 体系（全局 `AGENTS.md` + `agents_md` 模板投影）。

## 事实（核实于 0.84.2，`dist/core/system-prompt.js` 的 `buildSystemPrompt`）

`customPrompt`（即 `--system-prompt`）一旦给出，默认模板整体丢弃，包括三样**动态生成**的内容：

1. Available tools 段——每个工具的描述由 `toolSnippets` 动态注入，我们的 15 个扩展工具（`defineTool` 的 `promptSnippet`）也走这条路
2. Guidelines 段——按 `hasBash && !hasGrep && !hasFind` 这类条件现场生成，工具开关变了它自动跟着变
3. Pi documentation 段——docs/examples 的绝对路径按安装位置现算

无论哪条路径都会保留的：AGENTS.md 等上下文文件（包在 `<project_context>`）、skills 段、`Current working directory`。

即：替换不是「换掉身份、保留能力」，而是把动态拼接的机器换成一份会过期的静态快照。

## 理由

- **漂移不可见。** Pi 升级、扩展增删、工具开关变化，都会让自维护的静态描述失真，而模型是默默用着错误描述的——没有任何报错提示。
- **「提示词都在库里、WebUI 可编辑」是既定规则**（`数据库与目录结构设计.md`）。系统提示词定制是代码级配置，把教学角色放进它，就等于一部分角色行为脱离了模板库的增删改切换体系。
- **身份张力是一句话的事。** 默认模板自称 "expert coding assistant"，与教师角色有表层冲突——全局 AGENTS.md 首句的角色声明即可盖过，不需要重武器。且默认模板里 "you may have access to other custom tools depending on the project" 已为扩展工具留了位，我们的业务工具注入后模型已被告知它们的存在。
- **两层正交。** 默认提示词管工具使用素养（读文件、跑命令、写文件的规矩），AGENTS.md 管角色与判据。这与 ADR-0014 的「行为倾向归提示词、硬约束归代码」同构：素养是 harness 给的底座，角色是业务叠上去的内容。

## Consequences

- 全局 AGENTS.md 的第一句必须是角色声明（例如「你是 pi-teacher，用户的私人 1 对 1 老师」），把默认身份的张力压在最前面解决。
- Pi 升级时新工具的描述自动获得注入，零维护。
- `--append-system-prompt` 通道保留不用——若未来真出现「必须进系统提示词层、又不能进 AGENTS.md」的内容（目前预见不到），它在那里。
