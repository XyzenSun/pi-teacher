# 使用 Pi 作为 Agent 底座，全栈 TypeScript

学习助手需要 Agent Loop、流式对话、tool calling 和自动上下文压缩，这些都是已被反复实现过的底层能力，自研会挤占学习业务本身的开发精力。我们选择 `earendil-works/pi`（Pi Agent Harness）作为执行器

由于 Pi 的 SDK 以 TypeScript 为主，项目采用全栈 TypeScript，避免为了接入 Pi 而引入独立进程或跨语言 IPC 边界。

## Consequences

- 必须保留并使用 Pi 的自动上下文压缩：即使很短的学习对话也可能触及模型上下文上限。
- Pi 核心没有官方交互式 Web UI，前端需要自行实现；后端负责把 Pi 的事件流转换为浏览器可消费的推送。
- Pi 处于 0.x 阶段且迭代很快，需要锁定精确版本，目前锁定 v0.84.2（`server/package.json`），决策日期 2026-09-05，并把嵌入点收敛到少量适配代码中。
