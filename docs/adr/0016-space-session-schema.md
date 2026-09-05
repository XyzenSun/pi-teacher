# Space 与 Session Schema

Space 是三个固定值的枚举，Session 是核心业务实体。原来「学习空间」的组织能力由**共享 `work_path` 的 Session 分组**提供——它是前端视图，不是数据库实体。

## Space

```sql
CREATE TABLE space (
  id       INTEGER PRIMARY KEY,   -- 0=助教(ta)  1=学习(learn)  2=复习(review)
  name     TEXT NOT NULL,
  version  INTEGER NOT NULL DEFAULT 0   -- 预留
);
```

系统初始化时写入三行，之后不可增删。用整数而非字符串做主键，因为它是每张业务表都要 JOIN 的键。

## Session

```sql
CREATE TABLE session (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  name              TEXT,
  space_id          INTEGER NOT NULL REFERENCES space(id),
  enable_make_card  INTEGER NOT NULL DEFAULT 1,
  review_topic_id   INTEGER REFERENCES topic(id),
  work_path         TEXT NOT NULL,
  pi_session_path   TEXT NOT NULL,
  teach_style_id    INTEGER REFERENCES teach_style(id),
  created_at        TEXT NOT NULL DEFAULT (datetime('now')),

  CHECK (space_id != 0 OR id = 0),
  CHECK (space_id = 2 OR review_topic_id IS NULL)
);
```

**id**：自增整数。自增从 1 开始，0 永远不会被分配，专留给助教会话——助教全局唯一。

**name**：极简描述这场会话在干什么，用于列表检索。首轮对话结束后由后端**独立发起一次 LLM 调用**生成，不在会话内走工具（避免把标题生成污染进学习上下文）。用户可在 WebUI 编辑。不提供 AI 修改工具。Pi 官方没有自动标题能力，这是自建的。

**space_id**：会话类型。

**enable_make_card**：制卡开关，默认开。与 `space_id` 组合覆盖原来「新学 / 新学不制卡 / 复习 / 复习不制卡」四种意图，不再需要三档枚举。助教会话不看此字段，工具层直接拒绝制卡。

**review_topic_id**：复习会话的主题过滤，`null` = 不限制。只对复习会话有意义，CHECK 约束保证其他类型恒为 null。可随时修改，只影响之后的卡片查询，已进入模型上下文的内容不追溯。

**work_path**：Pi 启动的工作目录，绝对路径。多个 Session 可以指向同一个 `work_path`。

**pi_session_path**：Pi 的 JSONL 会话文件路径。通过 `SessionManager.create(workPath, workPath)` 配置后，文件直接存在 `work_path` 下，命名格式 `<ISO时间戳>_<uuidv7>.jsonl`。**注意延迟落盘**：首条 assistant 回复之前文件不存在，此字段在会话创建时为空，首轮结束后回填。`(work_path, pi_session_path)` 联合唯一。

**teach_style_id**：教学风格，外键。可空，空表示用默认风格。

## Teach Style

```sql
CREATE TABLE teach_style (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  name         TEXT NOT NULL,
  description  TEXT,          -- 给用户看的简介
  prompt       TEXT NOT NULL  -- 真正注入的提示词
);
```

教学风格用表而不用 Skill 文件，因为它是用户在界面上增删改的东西（见 ADR-0006 的修订）。预置若干行（循序渐进的老师、只答疑的助教、苏格拉底式追问等），用户可自定义。

## 目录布局

```
~/pi-teacher/
  ├─ AGENTS.md              ← 全局：工具调用原则、用户偏好、制卡规则
  │
  ├─ learn/
  │   ├─ 5/                 ← 目录名 = 首个 session 的 id
  │   │   ├─ AGENTS.md      ← 这组的学习目标、资料索引、难题清单
  │   │   ├─ materials/
  │   │   ├─ index.json
  │   │   └─ 2026-09-05T..._abc.jsonl  ← Pi 会话文件
  │   └─ 12/
  │
  ├─ review/
  │   ├─ AGENTS.md
  │   └─ 2026-09-05T..._def.jsonl
  │
  └─ ta/
      ├─ AGENTS.md
      └─ 2026-09-05T..._ghi.jsonl
```

**Pi 会话文件存在我们指定的目录**。通过 `SessionManager.create(workPath, workPath)` 指定 `sessionDir` 为工作目录本身，Pi 将 JSONL 文件平铺在那里。不需要 `.pi/sessions/` 子目录。

**AGENTS.md 自动拼接**（Pi 从 cwd 向上遍历到根）：
1. `~/pi-teacher/AGENTS.md` — 全局通用规则
2. `~/pi-teacher/learn/5/AGENTS.md` — 当前会话组特定内容

`learn/5/AGENTS.md` 由上下文组装器在会话启动前生成，内容从数据库和 `index.json` 读取，保证注入内容是最新的业务状态。它不是手写配置，而是代码生成的"缓存"。

**助教"知道当前学习上下文"按钮**：前端传当前学习会话的 `work_path`，后端读该目录的 `AGENTS.md` + `index.json`，拼成 `<system-reminder>` 注入给助教的这一轮请求。助教仍在 `ta/` 目录运行，只是 system prompt 多了一段。

## 「学习空间」变成了前端视图

前端把 `work_path` 相同的 Session 收纳进同一个折叠组。用户新建学习会话时选择：加入某个现有组（复用它的目录、资料、AGENTS.md），或新开一组。

「我想学 X」这个入口统一了新建与继续：后端按 `name` 和资料索引检索候选会话组，展示给用户，点击进入或选择新建。

## 与已有决策的关系

- **取代 ADR-0010 中的 StudySpace 实体**：空间不再是表，是视图。Card / Session 的边界论证仍然成立，只是 Session 的归属从「空间」变为「space 枚举 + work_path 分组」。
- **取代 ADR-0013 的 `new_study_type`**：三档枚举收窄为布尔开关；制卡判据的松紧由教学风格和 Skill 的提示词控制。
- **修订 ADR-0006**：教学风格从 Skill 移到数据库表。
