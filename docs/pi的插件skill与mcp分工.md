> **修订（ADR-0027）**：MCP 已否决，不引入（含社区桥接插件）。下表 MCP 行仅作历史判据参考——落到本项目时，那些需求全部收敛到插件：结构化参数用 `defineTool`，外部服务（沙箱、生图）由插件或 skill 封装。

只是告诉模型一套做事方法？	是	Skill
只是一个本地 CLI 或脚本？	是	Skill + CLI
需要结构化参数，不想让模型写 shell？	是	Extension 或 MCP
需要被多个 Agent/IDE 复用？	是	MCP
需要远程部署、认证、独立进程？	是	MCP
需要访问当前 Pi session？	是	Extension
需要拦截、阻止或修改工具调用？	是	Extension
需要修改 system prompt 或上下文？	是	Extension
需要 /command、快捷键或 TUI？	是	Extension
只需要换颜色？	是	Theme
