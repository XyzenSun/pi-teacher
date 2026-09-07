# PRD：插件注册与工具开发跑通

> 任务简称：plugin-tools-mvp
> 阶段范围（用户已定）：插件注册 + 16 个工具开发跑通（15 自研 + ask_user 移植）。**不做** UI 前端、不做 Express 路由、不做 pi-web 桥接层移植。
> 相关决策：ADR-0024（进程内 SDK）、ADR-0027（插件载体，不用 MCP）、`../CLAUDE.md` 技术事实节。

## 目标

在 `tools-dev/server/` 下实现：

1. **数据库层**——10 张表（`../数据库设计.md` 的 schema）、space 固定三行初始化
2. **FSRS 服务层**——ts-fsrs 封装：行 ↔ Card 映射、判定落库（`card_schedule` 更新 + `review_log` 写入）
3. **插件层**——15 个前缀式命名自研工具（`card_*` / `topic_*` / `glossary_*` / `review_*` / `md_*` / `file_*`），可见性矩阵裁决，extensionFactories 工厂注册
4. **验证脚本**——不起 Express，独立脚本进程内建 Pi 会话，确认工具注册成功、可被调用

## 需求对齐结论（2026-09-07 与用户确认）

| 问题 | 结论 |
| --- | --- |
| 验收标准 | 独立脚本进程内建会话，**真模型（用户提供 API key，禁止 mock）**调通至少一个工具，业务闭环落库 |
| 数据库位置 | dev 阶段 SQLite 落 `tools-dev/dev-data/pi-teacher.db`，不碰真实部署路径 `~/pi-teacher/` |
| 会话上下文注入 | dev 脚本硬编码 `SessionToolContext`（spaceId、enableMakeCard、reviewTopicId），接口形状与将来读 `pi_session` 行的查询对齐，接真实查询时零改动 |
| 多步学习 | 关闭（`learning_steps: [], relearning_steps: []`），`card_schedule`/`review_log` 不加列，详见 `../../数据库设计.md` topic 表说明 |
| 工具命名 | 前缀式定稿（本 PRD 附录 A），不改 |

## 工程骨架

```
tools-dev/server/
  package.json          -- type: module，ESM（Pi SDK 是 ESM）
  tsconfig.json         -- NodeNext，strict
  src/
    db/
      schema.ts         -- 建表 SQL + 初始化（space 三行、session 0 号助教行）
      connection.ts     -- better-sqlite3 单例，WAL 模式，dev-data 路径
    fsrs/
      service.ts        -- ts-fsrs 封装：行→Card、next() 落库、参数（关 steps）
    tools/
      context.ts        -- SessionToolContext 类型 + 可见性矩阵裁决函数
      cards.ts          -- card_propose / card_list / card_get / card_delete / card_merge
      topics.ts         -- topic_create / topic_list
      glossary.ts       -- glossary_propose / glossary_list / glossary_get
      review.ts         -- review_get_due_cards / review_submit_ratings
      files.ts          -- md_get_outline / md_get_section / file_get_size_and_length
      ask-user.ts       -- ask_user：移植官方 examples/extensions/question.ts 样例（自带 TUI，非薄包装）
      factory.ts        -- 插件工厂：按可见性注册工具，闭包捕获会话上下文
    verify/
      run-faux.ts       -- faux provider 验证：建会话 → 注册成功 → 工具直调
      run-real.ts       -- 真模型验证（依赖用户 provider 配置）
```

依赖：`@earendil-works/pi-coding-agent@0.84.2`（对齐本机）、`better-sqlite3@13`、`ts-fsrs@5.4.2`、`typebox@1.3.7`（对齐 Pi）、`typescript`、`tsx`（脚本直跑）。

## 实现要点（从设计文档继承，此处只列开发时容易做错的）

1. **可见性矩阵**（`../../docs/工具定义.md`）：写入类（card_propose / topic_create / card_delete / card_merge / glossary_propose / review_get_due_cards / review_submit_ratings）在助教对话硬拒；制卡类还受 `enable_make_card` 开关控制。两种实现层：注册层（不注册）与执行层（注册了但拒绝）——**采用执行层拒绝**，注册全量：拒绝返回值里说明原因，模型能感知并调整，且与 ADR-0026「学习对话取卡不硬拒、返回值照常给」的既定行为一致。
2. **时间戳由代码填**：所有 `created_at` 等由 schema `DEFAULT (datetime('now'))` 或代码写入，工具 schema 里不出现时间参数。
3. **归一化去重**（card_propose）：去首尾空白 + 压缩连续空白 + 统一中英文标点 + 忽略大小写。范围按 Topic。
4. **merge 算法**：复制 `stability` 最低旧卡的调度状态；新卡 `status = 'normal'`；旧卡全部 `deleted`；整个动作在一个 SQLite 事务里。
5. **card_schedule 行创建时机**：卡片转 `normal` 时（用户确认走 WebUI——本阶段无 WebUI，dev 验证用 SQL 直改 status 模拟确认）。
6. **ask_user**：移植官方样例 `$PI/examples/extensions/question.ts`（全自定义 TUI：选项列表 + 内联编辑器 + Esc 取消）。移植时保留其 UI 行为，参数 schema 对齐我们的三参形态 ````

ask_user（1 个，移植自官方样例，不薄包装）：

```
ask_user(question, choices?, multiline?)`；非交互模式（mode !== "tui"/"rpc"）返回提示让模型改用对话正文提问。
8. **md_get_section 边界**：从命中标题行到下一个**同级或更高级**标题前；重名命中多处全返回带起止行号。
9. **file_get_size_and_length**：characters 按 UTF-8 码点数（非字节数），lines 按 `\n` 计数，bytes 为文件大小。
10. **路径安全**：工具接受 path 参数，须限制在 `~/pi-teacher/` 工作根下（防模型读宿主任意文件）。dev 阶段工作根 = `tools-dev/dev-data/workspace/`。

## 验收清单

- [x] 建库成功（10 张表 + space 三行 + 助教 session 0 号行）
- [x] `run-real.ts`（真模型，API key 由用户提供，禁止 mock）：
  - Pi 会话创建成功，15 个自研工具 + ask_user 全部出现在会话工具列表
  - 真实对话「创建一个 Java topic 并提议一张卡」→ 模型实际调用 topic_create + card_propose → 数据库出现对应行（card 为 proposed 状态）
- [x] 工具直调冒烟（脚本内直调 execute，绕过模型，不涉及 mock——测的是真数据库真文件，2026-09-07 扩为 16 工具全覆盖 75 断言）：
  - card_propose 重复 front 被拒；助教上下文调 card_propose 被拒且返回原因
  - review_submit_ratings 走通 FSRS 落库：card_schedule 更新、review_log 生成、due 按关 steps 语义变化（最短 24h）
  - md_get_outline / md_get_section / file_get_size_and_length 对真实 md 文件返回正确行号与计数

## 附录 A：工具签名（定稿，15 个自研 + ask_user 移植）

自研 15 个：

```
card_propose(topic_name, front, back, reason_and_remark, source_essence_path?)
card_list(topic_id?)
card_get(card_id)
card_delete(card_id, reason?)
card_merge(target_front, target_back, merged_card_ids, reason_and_remark)
topic_create(name, description?)
topic_list()
glossary_propose(term, definition)
glossary_list()
glossary_get(term_id)
review_get_due_cards(nums, topic_id?)
review_submit_ratings([(card_id, rating)])
md_get_outline(path, level?)
md_get_section(path, heading)
file_get_size_and_length(path)
```

ask_user（1 个，移植自官方样例，不薄包装）：

```
ask_user(question, choices?, multiline?)
```

## 附录 B：本阶段不做的（防蔓延）

- Express 路由、SSE、静态文件服务（ADR-0025 的后端壳，待插件跑通后搭）
- pi-web 桥接层移植（rpc-manager 裁剪、session-reader 重写）
- WebUI 工具审批界面（card proposed → normal 的确认流，dev 用 SQL 模拟）
- 沙箱插件、生图 skill、资料抓取子代理
- `agents_md` / `teach_style` 预置模板内容（用户另行提供）
- ask_user 的 TUI 深度定制（保持官方样例行为，只对齐参数 schema）
