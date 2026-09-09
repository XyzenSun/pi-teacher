# Pi Teacher WebUI（桌面版）

React 19 + TypeScript + Vite 7 + Tailwind v4 + react-router-dom 7；状态管理只用 hooks/context。视觉令牌来自 `前端模板/DESIGN.md`（Atelier Mind）。

## 开发

```bash
# 终端 1：后端（默认 39871）
cd server && PORT=39871 npm run dev
# 终端 2：前端（5174，/api 代理到后端 39871）
cd web && npm run dev
```

## 生产

```bash
cd web && npm run build      # 产出 web/dist
cd server && npm run dev     # Express 检测到 web/dist/index.html 即托管，并对非 /api 路径做 SPA fallback
```

## 目录

- `src/api/` 后端契约类型与 fetch 封装（401 统一跳登录）
- `src/auth/` 登录 / 初始化页与 AuthContext
- `src/app/` 三栏外壳、Workspace 数据上下文、统一新建面板
- `src/sidebar/` Space → Pi Session 两级树
- `src/chat/` SSE reducer、`useConversation`、Markdown（KaTeX/Mermaid）、消息与工具折叠、输入框
- `src/aside/` 全局 Card Proposal 池、固定助教（一次性注入按钮）
- `src/settings/` `/settings` 单页：Card / Glossary / Topic / Agents Md / Teach Style
- `src/lib/` 自 pi-web 移植的纯函数（见 `THIRD-PARTY-NOTICES.md`）
