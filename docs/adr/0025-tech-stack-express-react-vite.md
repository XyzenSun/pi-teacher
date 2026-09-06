# 技术栈：Express + React + Vite + Tailwind

前后端框架的选型。前提是 ADR-0001 的全栈 TypeScript 与 ADR-0024 的进程内会话模型。

| 层 | 选择 |
| --- | --- |
| 后端框架 | Express 5 |
| 前端框架 | React + TypeScript |
| 构建 | Vite |
| 样式 | Tailwind CSS |
| 状态管理 | React 内置 hooks，不引状态库 |

## 后端：Express 5

后端框架实际只做四件事：URL 路由、中间件（登录校验）、SSE 推流、静态文件服务。最重的两件事——AgentSession 管理（ADR-0024）与 SSE 长连接——本质是 Node 原生 API，**任何框架都只是给它们挂路由**，框架之间没有实质差异。既然如此，选择标准只剩：

- **资料厚度。** Express 是 Node 后端十几年的默认选择，出任何问题都能搜到答案。这对「AI 写代码」的开发模式是硬通货——训练语料最多，生成错误率最低，排错时先例最多。
- **概念数量。** 中间件模型（`app.use()` 一层层过）是一层理解终身受用，没有插件体系、依赖注入、schema DSL 这些额外心智。

Express 5 已原生支持 async 路由，历史上被诟病的主要包袱已消除。性能差距对单用户负载无意义。

**Fastify / Hono**：能力都够用。Fastify 的优势（JSON Schema 校验、结构化日志）对几十个接口的项目收益有限；Hono 的核心卖点多运行时可移植，在「Docker 里一个固定 Node 进程」的形态下价值为零，且生态最年轻、答案最少。

**Next.js API Routes**（pi-web 的选择）：核心价值 SSR/SEO/边缘部署对本地单用户工具全部为零，却要背 App Router、Server Components、缓存语义的全套抽象。进程内会话模型与它的无状态路由心智还有一层摩擦（pi-web 为此挂 `globalThis` 打补丁）。否决——ADR-0024 已定桥接层移植到 Express，globalThat 补丁随之消失。

## 前端：React + Vite + Tailwind

决定性理由只有一条：**pi-web 的前端是 React，而我们要抄它。** Markdown 渲染管线、Mermaid 失败回退、SSE 消费、乐观消息恢复、对话窗口布局（`pi-web-研究/03a/03c/03e`）全是现成的 React 组件——抄是复制粘贴加适配，换成别的框架就是「读逻辑重写」，重写是新 bug 的唯一来源。Tailwind 跟着走，抄组件时类名原样可用。

**Vue**：模板语法对人肉入门最友好、中文资料极好，但本项目的开发者不写代码，入门曲线权重很低，而「React 组件翻译成 Vue」的改写成本是实打实的。
**Svelte**：写起来最省，但生态最小，且 Svelte 5 刚把响应式模型整体换代（runes），新旧两种写法的语料混杂，AI 生成时混用新旧心智是真实风险。

Vite 无可选项之争——前端构建的事实标准。

## 状态管理：不引库

单用户工具、页面间共享的主要是一份 SSE 事件流，React 内置的 `useState` / `useContext` / `useSyncExternalStore` 足够。不预装 Redux / Zustand——需要它的那天再增量引入，那是十分钟的决策而不是架构返工。

## Consequences

- 项目结构：`server/`（Express + 进程内 SDK）与 `web/`（Vite + React SPA）两个包，各自独立构建；后端顺手 serve 前端构建产物，Docker 里仍然只有一个进程。
- 全栈 TypeScript 满足 ADR-0001。
- 登录用 cookie 中间件（ADR-0022），导出接口流式生成 zip（大 `materials/` 目录不进内存）。
- 「无聊技术」是本 ADR 的底色：每一层都选资料最厚、AI 最熟、概念最少的那个，出问题时先例最多。
