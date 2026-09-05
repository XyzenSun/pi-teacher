space:
    id, 近用于索引性能，tinyint索引主键要比string快一些 ,实际上固定 0 助教 1 学习 2复习


    name 新学、复习、助教

    version 预留字段，暂时没用

sessions:
    id : int 助教的id固定为0 !且助教的会话唯一
    name: 首轮对话结束后由ai自动生成，可编辑，不采用pi 本身提供的， name的意义就是极其精简的描述这个会话在干什么，方便检索，不提供ai修改工具，但提供
    space_id : 同时表示了session是复习，还是新学，还是助教
    enable_make_card : bool 默认true 允许制卡， 不允许制卡我觉得不用区分复习和新学了，有时候复习的时候也不希望再制卡。 这样用spaceid+ enable_make_card 就可以表示出以前期望的： 新学但不制卡，新学，复习，复习不制卡。 只管制卡，卡片， 即是复习的核心，也是记录用户已学习内容的载体，永远可读，只是如果有topic的限制，只能读对应的topic的卡片。
    review_topic : 复习的主题，null表示不设限制，可读所有卡片 ，默认null，可后期修改，ai上下文中已有的记忆不用管，更改之后只影响以后的查询卡片和制卡 ，新学此处为null， 新学时可以读取任意卡片去制卡是必然的，因为要复用已有分类，
    work_path: 工作目录 string类型，记录绝对路径
    pi_session_path: pi在同一个文件夹可以有多个会话，我们认为在一个文件夹中的不同会话，不属于同一个我们的session，结合work_path就可以轻量化的实现以前类似studyspace的能力，前端可以在渲染时，把work_path相同 pi_session_path不同的，做成一个合集收纳到同一个箱体 助教的这个唯一
    teach_style: 教学风格，外键。1.

teach_style:
  教学风格表，支持自定义插入和修改
   id
   name 名称
   descpition 简短描述展示给用户
   prompt 真正插入的prompt。
   
卡片， 即是复习的核心，也是记录用户已学习内容的载体



Pi Agent 的会话上下文存储在 ~/.pi/agent/sessions/ 目录下，按工作目录（cwd）组织，每个会话是一个独立的 JSONL 文件（JSON Lines，不是单个大 JSON）。
存储位置与结构

默认路径：~/.pi/agent/sessions/
按工作目录分组：工作目录路径中的 / 会被替换成 -，形成类似 --home-user-project--/ 这样的子目录。
每个会话文件命名类似：<timestamp>_<uuid>.jsonl（例如 2024-01-01T12-00-00-000Z_abc123.jsonl）。

示例结构：
text~/.pi/agent/sessions/
├── --home-user-project1--/
│   ├── 2024-01-01T12-00-00-000Z_abc123.jsonl
│   └── 2024-01-02T09-30-00-000Z_def456.jsonl
└── --home-user-project2--/
    └── 2024-01-03T14-15-00-000Z_ghi789.jsonl
同一个工作目录下的多个会话会全部放在对应的编码目录里，互不干扰。
文件格式

JSONL（每行一个独立的 JSON 对象），而不是一个完整的 JSON 文件。
会话以树结构存储（通过 id + parentId），支持分支、回退、继续等操作，无需新建文件。
第一行通常是 session header（包含 version、id、cwd 等元数据），后面是 message、compaction、model change 等条目。

相关命令

/session：查看当前会话文件路径、ID、消息数、token、费用等。
pi -c：继续最近会话。
pi -r：浏览并选择历史会话。
pi --session <path|id>：指定特定会话。
pi --session-dir <dir>：自定义会话存储目录（覆盖默认行为）。
pi --no-session：临时模式，不保存。

你可以通过删除对应的 .jsonl 文件来清理会话，或者在 /resume 界面用快捷键删除。完整格式细节可参考官方 Session Format 文档。