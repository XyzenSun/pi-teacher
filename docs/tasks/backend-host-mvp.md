# PRD：后端宿主（Express + 桥接层 + 会话管理 + 投影/注入 + CRUD 路由）

> 任务简称：backend-host-mvp
> 阶段范围（用户已定）：后端全数据面，做到前端可全程真实联调的程度。**不做** 前端 web/ 包、不做 Dockerfile/部署、不做回退（已废弃）、不做导出（留部署阶段）、不做 ask_user（已废弃）。
> 相关决策：ADR-0022（单用户，认证段按本轮修订）、ADR-0024（进程内 SDK）、ADR-0025（Express + React + Vite）、ADR-0027（插件载体）、ADR-0029（资源目录与挂载）。
> 前置核实（2026-09-08 子代理 + 人工抽查）：pi-web 真实仓库 `agegr/pi-web`（MIT）；「8 项 API 漂移」全部证伪——锁 0.84.2 无 API 缺口；除 rpc-manager 外桥接文件与调研快照逐字节一致，调研文档行号仍有效。

## 目标

新建 `server/` 包（ADR-0025 两包形态的后端半边），实现：

1. **桥接层**——pi-web 裁剪移植：AgentSessionWrapper、模块级会话注册表、SSE 事件流、命令分发
2. **会话管理**——工作区目录扫描、jsonl 读取（session-reader 等价物）、对话标题生成
3. **投影/注入**——agents_md 模板投影成工作区 AGENTS.md、`context` 事件注入（哨兵占位）、cwd 契约、env-sync 启动钩子
4. **认证**——user 表 + 登录页后端 + cookie
5. **CRUD 路由**——前端需要的全部数据面
6. **验证随迁**——smoke + run-real 从 tools-dev 拷入 server/，ask_user 相关断言删除（16→15）

## 需求对齐结论（2026-09-08 grill-doc 五轮确认）

| 问题 | 结论 |
| --- | --- |
| 任务边界 | 全数据面（桥接 + 投影注入 + CRUD），前端可真实联调即验收 |
| 代码落点 | 新建 `server/` 包，db/tools/fsrs 从 tools-dev **拷入**（tools-dev 冻结为历史脚手架，README 注记） |
| pi-web 移植方式 | 混合：SSE 流/类型/安全模块直接拷（MIT，保留版权声明），rpc-manager 裁剪重写（嵌 SessionToolContext 装配） |
| verify 脚本 | 随代码迁入 server/，75 断言 − ask_user 组 |
| 回退 | **废弃**（性价比低，用户有需求再议） |
| 认证 | 登录页 + cookie + **user 表存 scrypt 哈希**（首启动表空 → 强制设密码页）；ADR-0022 相应修订 |
| ask_user | **删除工具**（16→15）。Web 上选择框与文字问答语义等价，出题走正文 |
| abort | 保留（停止按钮）+ agent_settled；fork/clone/fork_branch 全砍（回退废弃，无消费者） |
| SSE 事件集 | 最小闭环：connected / startup_error / message_start / message_update / message_end / prompt_done / prompt_error / agent_settled / tool_execution_start/end + 30s 心跳。砍：UI 请求、subagent、widget、fork、turn_start/end |
| SDK 版本 | **维持 0.84.2**（验证资产全部建立其上；升级随时可回头） |
| 会话目录布局 | **平铺工作区**（`~/pi-teacher/learn/5/*.jsonl`），SessionManager 第二参指工作区，照旧 |
| rpc-manager 移植基线 | 调研快照版（v0.8.11，rpc-manager 2067 行），不跟 main（新增三处均不需要：fork_branch 砍、session-liveness 不抄、终端不碰、避免 node-pty） |
| 导出（zip） | 不做，留部署阶段 |

## 工程骨架

```
server/
  package.json           -- type: module，ESM；Express 5
  tsconfig.json          -- NodeNext，strict（沿用 tools-dev/server 配置）
  src/
    index.ts             -- Express 入口：中间件装配、路由挂载、启动钩子（env-sync、user 表初始化检查）
    bridge/              -- pi-web 移植（版权声明保留）
      agent-session-wrapper.ts   -- rpc-manager 裁剪重写：wrapper 核心、注册表（模块级 Map）、
                                     启动锁、10 分钟空闲回收、send() 命令表（prompt/abort/get_state/
                                     get_tools/set_model/compact…）、emit/onEvent/destroy/shutdown
      agent-event-stream.ts      -- 直接拷（132 行）：握手、事件缓冲、快照补发、30s 心跳
      agent-event-wire.ts        -- 直接拷（107 行）：事件过滤与投影
      streaming-message.ts       -- 直接拷（144 行）：流式增量拼接
      pi-types.ts                -- 直接拷（205 行）：Pi 事件与消息类型
    routes/
      auth.ts            -- POST /api/login、/api/logout、GET /api/me；强制设密码流程
      workspaces.ts      -- 工作区列表（名称、到期卡片数、最近活动）、新建
      conversations.ts   -- 对话列表（读 pi_session 表 + jsonl 扫描）、开新对话（选模板/风格/
                            制卡开关 → 写 pi_session 行 + 投影 AGENTS.md/style.md + 建 wrapper）、
                            关闭/重开、POST 发消息、abort、SSE 端点 /api/agent/:id/events
      cards.ts           -- 提议列表、确认（proposed→normal + createInitialSchedule）、拒绝、编辑、
                            软删、恢复、合并视图
      glossary.ts        -- 提议列表、确认、拒绝
      topics.ts          -- 列表、FSRS 参数编辑
      prompts.ts         -- agents_md 与 teach_style 增删改查
    session/
      directory-scan.ts  -- 工作区目录下 jsonl 枚举（平铺布局，逻辑比 pi-web 简单）
      session-reader.ts  -- jsonl → 前端消息（id/parentId 树、分支、compaction 条目），参考 pi-web 重写
      title-generator.ts -- 对话标题生成（pi-web session-title.ts 移植：独立 LLM 调用，不进会话上下文）
    projection/
      agents-md.ts       -- 开对话时把 agents_md.prompt 整份覆盖写出到工作区 AGENTS.md
      teach-style.ts     -- 同上，投影 style.md
      context-inject.ts  -- context 事件组装：待复习卡数等动态状态（哨兵占位，真实内容等提示词设计）
    auth/
      password.ts        -- scrypt 哈希/校验（Node 内置 crypto，SHA-256 归一长度 + timingSafeEqual，
                            照搬 pi-web web-auth.ts:9-11 的写法）
      middleware.ts      -- cookie 校验中间件（保护全部 /api，/api/login 与强制设密码页除外）
      session-store.ts   -- 登录态存储（内存 Map 足够，单进程）
    db/                  -- 从 tools-dev/server/src/db 拷入 + 新增 user 表（id、username、password_hash）
    fsrs/                -- 从 tools-dev/server/src/fsrs 拷入（零改动）
    tools/               -- 从 tools-dev/server/src/tools 拷入，**删除 ask-user.ts**，
                             factory.ts 去掉注册，pi-tui 依赖移除
    env-sync.ts          -- ADR-0029 spec：白名单 env 覆盖写 ~/pi-teacher/.env，启动时一次
    verify/
      smoke.ts           -- 随迁，删 ask_user 组（16→15 工具断言）
      run-real.ts        -- 随迁；扩展断言：经 bridge 创建会话、SSE 事件收发
      http-smoke.ts      -- 新增：起 Express（随机端口 + 临时 DB），curl 断言登录→列表→开对话→
                             发消息→收 SSE 首批事件→abort→CRUD 全路由状态码与落库
```

依赖新增：`express@5`（仅此一个运行时新依赖；cookie 解析手写或用 express 内置能力，不引 cookie-parser——若实践中 express 不带，再评估）。其余沿用 tools-dev 清单，`@earendil-works/pi-tui` 移除。

## 实现要点（从调研与 ADR 继承，只列容易做错的）

1. **cwd 契约**（ADR-0029）：创建会话必须 `SessionManager.create(工作区目录, 工作区目录)`，cwd 退化 = 全局 AGENTS.md 注入失效。wrapper 构造函数的第一参数校验点。
2. **SessionToolContext 装配**：开对话路由从 `pi_session` 行读 space_id / enable_make_card / review_topic_id 构造上下文（tools-dev 是硬编码，接口形状已对齐），传入 `createPiTeacherExtension`，经 `createAgentSessionServices({ resourceLoaderOptions: { extensionFactories } })`。**生产宿主 noSkills 等开关全开**（与 run-real 的全关相反）。
3. **SSE 帧格式**：无名事件 `data: {json}\n\n`，type 字段区分；心跳注释帧 `:\n\n` 每 30s；连接先发一帧 `:\n\n` 刷头。握手 `connected` 区分「EventSource open」与「agent 就绪」；`startup_error` 让客户端停止重连。调研文档 `../pi-web-研究/01-桥接层.md` §3/§4 是权威转写（与最新源码逐字节吻合）。
4. **prompt 串行化**：wrapper 的 prompt 准入队列——同一会话并发 POST 只有一个在跑，其余排队（pi-web rpc-manager 已有，裁剪时保留）。preflightResult 两段式 ack 保留。
5. **空闲回收**：10 分钟（`resetIdleTimer`），运行中不回收；进程信号（SIGTERM/SIGINT）优雅退出（先 session_shutdown 再 dispose）。可配置（环境变量），默认 10 分钟。
6. **注册表形态**：模块级 `Map`（ADR-0024 简化决定），不用 globalThis。启动锁（同 id 并发 start 合并为一个 promise）保留。
7. **投影时机**：开对话时整份覆盖写 AGENTS.md / style.md（数据库是源，文件是投影，ADR-0014）。并发对话覆盖冲突**不处理**（数据库与目录结构设计.md 已定：概率低后果轻）。
8. **认证流**：首启动 user 表空 → `GET /api/auth/status` 返回 `needs-setup`，前端进设密码页 → `POST /api/auth/setup`（仅表空时可用）→ 登录。cookie：签名 HttpOnly（crypto 自签 HMAC，无第三方依赖）。登录失败响应不区分「用户名错」与「密码错」。
9. **安全模块照拷**：request-security 的 Host 白名单 + Origin/sec-fetch-site 校验（改写成 Express 中间件）、path-security 的路径穿越双段校验。先信任校验后认证（不合法的 Host 连 401 都不给）。
10. **标题生成**：独立 LLM 调用（pi-web session-title.ts 的时机与 prompt 原文），用 pi_session 行存结果。模型配置复用 `~/.pi/agent/models.json`（与主对话同 provider）。
11. **context 事件注入**：`context` 事件（每轮 LLM 调用前触发，返回值只进 payload 不落盘不进压缩）。注入内容用哨兵文本占位（`PI-TEACHER-CONTEXT-INJECT-MARKER`），链路通即验收，真实内容由提示词任务填充。
12. **env-sync**：按 `.scratch/env-key-sync-and-resource-locations/spec.md` 的五条语义（白名单外不碰 / env 持有的覆盖 / env 为空跳过 / 文件可创建 / 损坏行原样保留）。

## 验收清单

- [ ] `npm run smoke`：tools-dev 的 75 断言减 ask_user 组（约 74）全过——证明拷入无损
- [ ] `PI_TEACHER_PROVIDER=agnes PI_TEACHER_MODEL=agnes-2.5-flash npm run verify`：真模型 4/4 + 新增 bridge 断言（SSE 事件收到 connected/message 流/prompt_done/agent_settled）
- [ ] `npm run http-smoke`：登录 → 工作区列表 → 开对话（pi_session 行落库 + AGENTS.md 投影出现 + 15 工具注册）→ 发消息 → SSE 流式收事件 → abort → 卡片确认（card normal + card_schedule 行出现）→ 术语确认 → Topic 参数编辑 → 提示词库增删改 → 登出后 401。全链路真模型、真数据库、真文件，禁止 mock
- [ ] 首启动强制设密码页流程通（user 表空 → setup → login → me）
- [ ] 空闲回收：SSE 断开后 10 分钟（测试可配置为秒级）wrapper 销毁，jsonl 完整保留
- [ ] SIGTERM 优雅退出：session_shutdown 发出、进程 0 退出码
- [ ] ADR-0022 修订提交（认证段：哈希+cookie 落地为 user 表 + 登录页，OAuth 否决不变）
- [ ] 工具定义.md、CONTEXT.md（无 ask_user 后术语不变）、tools-dev README 冻结注记同步

## 附录：裁剪对照（rpc-manager 2067 行 → 预计 700-900 行）

保留：wrapper 核心字段与生命周期、模块级注册表、启动锁、startRpcSession、send() 命令表（prompt/abort/get_state/get_tools/set_model/compact/steer）、emit/onEvent、destroy/shutdown、10 分钟空闲回收、进程信号优雅退出。

砍掉：subagent 全套（createSubagentExtension / SUBAGENT_CONTROLLER / steer/abort subagent 等）、扩展 UI widget 与 custom-ui-terminal、web-push、project-trust（信任门控降级为直接加载）、startup-preferences、model-scope、PlainTextTheme/TuiKeybindingsManager、session-liveness、fork/clone/fork_branch、withExtensionTools。
