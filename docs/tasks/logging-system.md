# 日志系统

2026-09-13 立项。方案细节用户明说「到时候需要商量」，本 PRD 先固定已定约束与待商量清单，实施前逐项过。

## 背景

- 生产代码（`server/src/` 除 `verify/`）`console.*` 约 25 处，手拼 `[server]` / `[bridge]` / `[security]` / `[user-env]` / `[attachments]` / `[title]` / `[hub]` 前缀区分来源
- 无等级、无时间戳、无统一开关：排查问题靠翻 `docker logs` 全文，无法按等级过滤，事件发生时刻只能靠容器日志顺序推断
- `verify/` 脚本里还有约 130 处 `console.*`，那是测试断言输出不是运行日志，默认不在本任务范围

## 已定约束（用户 2026-09-13）

- **用第三方库**，不手写 logger
- **统一输出到 stderr**（用户原话「stdr」，docker logs 对 stdout / stderr 均可见；stderr 是日志惯例，stdout 留给程序正常输出——最终流待商量确认，见下）
- **等级**：debug / info / warn / error 四级

## 待商量清单（实施前与用户逐项确认）

1. **库选型**：pino（性能最好、JSON 优先、transport 生态成熟、无原生依赖）/ winston（使用最广、偏重、transport 模型老）/ consola（轻量、终端输出友好）等；倾向 pino，容器场景成熟
2. **输出流**：stderr（惯例，`docker logs` 与 `docker compose logs` 均直接可见）vs stdout——需用户确认「stdr」所指
3. **输出格式**：纯文本单行（人读友好，含时间戳 + 等级 + 模块名 + 消息）vs JSON（机器可解析，可接 Loki / ELK）；容器内无 TTY，着色默认关
4. **等级开关**：环境变量（如 `PI_TEACHER_LOG_LEVEL`，与 `PI_TEACHER_*` 前缀族一致）？默认等级（info？debug 只在开发用）？是否要 `user_env` 表里可调（倾向不要——日志等级属于部署姿态，由部署环境定，与 `PI_TEACHER_REQUEST_SECURITY` 同类）
5. **范围**：仅生产代码，还是含 `verify/`（倾向不含，理由见背景）；Pi SDK 内部日志是否顺带接管（`pi-agent-core` 自身输出，能接管则接管，不能则记边界）
6. **HTTP 访问日志**：是否加每请求一行（method / path / status / 耗时），还是本轮只替换现有 `console.*` 不扩面
7. **模块字段**：现有 `[xxx]` 前缀语义保留为结构化字段（logger child / module 名），保持既有排查习惯

## 实施要点（待商量定案后细化）

- 统一 logger 模块（如 `server/src/logging/`），生产代码 `console.*` 全部替换；替换时顺带审视每处输出的等级是否恰当（现状全是 log/warn/error 混用，无 debug）
- 启动横幅（端口、安全姿态、迁移结果等一次性信息）保持 info；桥接层会话生命周期（打开 / 回收 / SIGTERM 关闭）考虑 debug 级
- secret 边界不变：日志不打 API key、`$ENV` 引用、header 值（AGENTS.md 编码约束）

## 验证

- 容器内 `docker logs` 按等级可见、时间戳与模块字段正确
- `PI_TEACHER_LOG_LEVEL` 过滤生效（低等级被抑制）
- 后端 typecheck、`http-smoke`（若断言了启动输出需同步）
- 踩坑记 `docs/spec.md`
