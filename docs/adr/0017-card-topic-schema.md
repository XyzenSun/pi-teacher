# Card、Topic 与 Schedule Schema

## Topic（主题表）

```sql
CREATE TABLE topic (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  name                TEXT NOT NULL UNIQUE,
  description         TEXT,
  request_retention   REAL NOT NULL DEFAULT 0.9,
  maximum_interval    INTEGER NOT NULL DEFAULT 365,
  created_at          TEXT NOT NULL DEFAULT (datetime('now'))
);
```

**name**：主题名称，全局唯一。可以细化到任意粒度，例如「后端」「Java」「JVM」。制卡时 AI 读取现有 Topic 列表并优先复用，避免同义词泛滥。

**description**：给 AI 做归类判据用的描述。比如「Java」的描述可以是"Java 语言核心、JVM、并发、集合框架、IO 等"。

**request_retention / maximum_interval**：FSRS 参数，主题级配置。不同主题可以有不同的记忆目标，例如核心算法要 95% 保留率，边缘知识 80% 即可。

## Card（卡片表）

```sql
CREATE TABLE card (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  topic_id            INTEGER NOT NULL REFERENCES topic(id),
  front               TEXT NOT NULL,
  back                TEXT NOT NULL,
  answer_mode         TEXT NOT NULL DEFAULT 'open_ended',
  metadata            TEXT,
  source_session_id   INTEGER REFERENCES session(id),
  source_message_id   TEXT,
  created_at          TEXT NOT NULL DEFAULT (datetime('now')),
  
  CHECK (answer_mode IN ('open_ended', 'exact', 'code'))
);
```

**front / back**：卡片正面（问题）与背面（参考答案或评价标准）。

**answer_mode**：回答模式，决定 AI 如何评价用户回答。
- `open_ended`：开放式回答，AI 解读理解深度、完整性与正确性（面试八股文）
- `exact`：固定答案，AI 判断是否匹配（背单词）
- `code`：算法题，AI 评价思路与实现，可选地调用远程沙箱执行

**metadata**：JSON 字段，存 `answer_mode` 特定的额外数据：
- 评分 rubric（八股文的要点清单）
- 图片引用（背单词的视觉辅助）
- 题目限制（算法题的时间/空间复杂度要求）
- 测试用例引用

**source_session_id / source_message_id**：溯源字段。卡片在哪场会话的哪条消息里提议的。`source_message_id` 是 Pi 会话内的 entry id，要原文时读 `pi_session_path` 解析 JSONL。

## Card Schedule（卡片调度表）

```sql
CREATE TABLE card_schedule (
  card_id      INTEGER PRIMARY KEY REFERENCES card(id) ON DELETE CASCADE,
  state        TEXT NOT NULL DEFAULT 'new',
  due          TEXT NOT NULL,
  stability    REAL NOT NULL,
  difficulty   REAL NOT NULL,
  elapsed_days INTEGER NOT NULL DEFAULT 0,
  scheduled_days INTEGER NOT NULL DEFAULT 0,
  reps         INTEGER NOT NULL DEFAULT 0,
  lapses       INTEGER NOT NULL DEFAULT 0,
  last_review  TEXT,
  
  CHECK (state IN ('new', 'learning', 'review', 'relearning'))
);
```

FSRS 状态与卡片内容分离，因为调度状态每次复习都变，卡片内容基本不变。混在一张表里会让每次复习都重写整行。

**state**：FSRS 四状态。

**due**：下次到期时间，ISO 8601 格式。到期队列的查询条件。

**stability / difficulty**：FSRS 核心参数。

**elapsed_days / scheduled_days / reps / lapses**：FSRS 统计字段，用于参数优化与分析。

**last_review**：上次复习时间。

## Review Log（复习记录表）

```sql
CREATE TABLE review_log (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  card_id         INTEGER NOT NULL REFERENCES card(id),
  session_id      INTEGER NOT NULL REFERENCES session(id),
  rating          TEXT NOT NULL,
  ai_evaluation   TEXT,
  due_before      TEXT NOT NULL,
  stability_before REAL NOT NULL,
  difficulty_before REAL NOT NULL,
  state_before    TEXT NOT NULL,
  due_after       TEXT NOT NULL,
  stability_after REAL NOT NULL,
  difficulty_after REAL NOT NULL,
  state_after     TEXT NOT NULL,
  reviewed_at     TEXT NOT NULL DEFAULT (datetime('now')),
  
  CHECK (rating IN ('Again', 'Hard', 'Good', 'Easy'))
);
```

记录每次复习的完整状态转换，用于：
- 审计：回看某张卡的复习历史
- 分析：计算实际记忆曲线、优化 FSRS 参数
- 溯源：这次 `Again` 是在哪场会话里发生的

**ai_evaluation**：AI 对用户回答的结构化评价（JSON），包含正确性判断、错误指出、建议等。这是给用户看的反馈，不是给 FSRS 的输入——FSRS 只看 `rating`。

**before / after 字段**：快照复习前后的 FSRS 状态。虽然 `card_schedule` 表有当前状态，但历史状态只能从 log 重建。

## 与已有决策的关系

- **ADR-0009**：`answer_mode` + `metadata` 实现了单表多类型卡片，不按类型分表。
- **ADR-0010**：卡片通过 `topic_id` 归属 Topic，通过 `source_session_id` 溯源到会话，不挂学习空间（已不存在空间实体）。
- **ADR-0011**：FSRS 的 `request_retention` 和 `maximum_interval` 存在 `topic` 表，支持主题级差异化。
- **ADR-0012**：复习记录的 `session_id` 记录了卡片在哪场会话里被复习，支持"一场复习会话"作为一个整体被回看。
