# Pi Session 真删除：删行 + 删 JSONL，保留工作目录，不做软删除

- 状态：已采纳
- 日期：2026-09-10
- 相关：ADR-0022（复制整个目录就是备份）、ADR-0030（Pi Session 独占工作目录）、ADR-0035（助教用清除代替删除）
- supersedes：`DELETE /api/workspaces/:id` 现行「只删行、文件全留」的行为

## 背景

MVP 只有「删整个学习 Space」：删 `space` 行与其下 `pi_session` 行，磁盘上的 JSONL 与工作目录全部保留。单条 Pi Session 没有删除入口，用户建错、聊废的对话只能一直挂在左树上。

提出真删除时有一个合理的顾虑：删掉 `pi_session.id = 42` 后立刻新建，目录会不会又是 `learn/2/pi/42/`，从而被旧目录里的 `AGENTS.md`、`style.md`、`pi-session-user.md` 干扰？由此引出「要不要软删除（`status = deleted` + 删 JSONL）」。

核实结果：`pi_session.id` 是 `INTEGER PRIMARY KEY AUTOINCREMENT`，`createPiSession` 又显式取 `MAX(sqlite_sequence.seq, MAX(id)) + 1` 分配 id——SQLite 的 `sqlite_sequence` 在删行后不回退，内存库实测删 42 后 next_id = 43，新目录是 `learn/2/pi/43/`。即便目录意外重名，`createPiSession` 对已存在的目标目录返回 409 而不是复用。顾虑不成立。

## 决策

1. **`DELETE /api/conversations/:id`**：删除 `pi_session` 行 + 删除 `path` 指向的 JSONL；**不删 `work_path`**（Essence、学习记录、`files/` 是用户的学习产出，不因删对话而消失）。运行中先 `abort` 再 `shutdown`，与 Space 删除一致。固定助教 403——它用 ADR-0035 的清除。
2. **`DELETE /api/workspaces/:id`** 改为同样语义：删 Space 行、其下全部 `pi_session` 行、各自的 JSONL；工作目录全部保留。
3. **不做软删除、不做回收站、不做标记**。id 不复用已经核实，软删除只剩「多一个状态列、每条查询多一个过滤条件」的成本。
4. **JSONL 删除失败不回滚数据库**：先事务删行再删文件，文件删不掉只记日志；一个不再被任何行引用的 JSONL 只是孤儿文件，与保留的工作目录同一类。

## 为什么不是别的

- **软删除（`status = deleted`）**：为一个不存在的问题付长期成本——所有列表查询、唯一约束（`work_path`、`path` 都是 UNIQUE）、id 分配都要区分「活的」与「删了的」。否决。
- **连 `work_path` 一起删**：目录里是用户产出，删对话不等于删笔记；ADR-0022 的备份模型是「目录即数据」，程序主动删目录与之冲突。留下的孤儿目录按原样保留，用户要清理自己删。否决。
- **回收站**：卡片与术语有回收站，因为它们是原子的学习内容、误删代价高；对话删了还有工作目录在，误删代价只是聊天记录。否决。

## 后果

- 磁盘上会累积孤儿工作目录（对话已删、目录还在）。不提供清理工具；`docs/数据库与目录结构设计.md` 说明这一点。
- `card`、`review_log`、`topic`、`glossary` 都不引用 `pi_session`（卡片归 Topic），删行没有级联顾虑；schema 无需改。
- 前端左树对话行加「删除」入口 + `ConfirmDialog`，文案写明「聊天记录删除，工作目录文件保留」；删的是当前打开的对话时跳回 Space 列表。
- 删除后原 id 的 `GET /api/conversations/:id/*` 一律 404；SSE 连接在 `shutdown` 时收到 `session_recycled` 后前端不再重开（404 不是 `session_recycled` 码）。
