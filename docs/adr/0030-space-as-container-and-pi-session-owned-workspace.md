# Space 作为收纳容器，Pi Session 独占工作目录

- 状态：已采纳
- 日期：2026-09-08
- supersedes：`数据库设计.md` 中原 `session` / `space` 两层关系，以及 ADR-0010、ADR-0029 中与工作目录归属有关的旧约定

## 背景

原模型把 `session` 当作学习工作区，并让同一个 `session` 下的多个 `pi_session` 共用一个 `work_path`。Pi 的 `AGENTS.md`、`style.md` 与 JSONL 会话文件都落在这个目录中。

这会产生一个实际的数据污染问题：同一学习工作区内，Java、数据库、Redis 等不同 Pi Session 可以选择不同提示词模板与教学风格，但后创建的对话会覆盖前一个对话的 `AGENTS.md` / `style.md`。由于 Pi 每轮都会读取工作目录上下文，已打开的对话甚至可能在运行中被另一个对话改变行为。

同时，学习、复习、助教原本分别由 `session` 与固定 `space` 两套概念表达，造成容器关系和活动类型重复。

## 决策

### 1. `space` 是唯一的收纳容器

删除 `session` 表，把当前 `space` 表升级为真正的收纳容器表。`space` 只负责：

- 聚类属于同一收纳箱的多个 `pi_session`；
- 保存收纳箱名称；
- 通过 `type` 标记活动类型：`learn`、`review`、`ta`。

`space` 不拥有 Pi 工作目录，不作为 Pi 的 `cwd`，也不再承载共享文件语义。

### 2. `pi_session` 通过 `space_id` 归属 Space

`pi_session` 保留 `space_id`，删除旧的 `session_id`，所有 Pi Session 必须归属于一个 Space：

```text
space 1 ──< pi_session
```

`agents_md_id`、`teach_style_id`、`enable_make_card` 与 `review_topic_id` 仍然属于 `pi_session`，因为它们描述一次具体对话，而不是收纳箱的固有属性。

### 3. 每个 Pi Session 拥有独立 `work_path`

`pi_session` 新增 `work_path`。每个 Pi Session 的以下内容只写入自己的目录：

- `AGENTS.md`；
- `style.md`；
- JSONL 会话文件；
- 该对话产生的私有文件。

Pi 启动时使用：

```ts
SessionManager.create(piSession.workPath, piSession.workPath, { id })
```

因此不同 Pi Session 即使属于同一个 Space，也不会互相覆盖提示词、风格或会话文件。

### 4. 固定 Space 与可创建 Space

- `space.id = 0`、`type = 'ta'`、`name = '助教'`：全局唯一固定助教 Space；
- `space.id = 1`、`type = 'review'`、`name = '复习'`：全局唯一固定复习 Space；
- `type = 'learn'` 的 Space：由用户创建，可以有多个。

固定 ID 只用于稳定外键与初始化，不允许业务代码用数字推断类型；业务判断必须读取 `space.type`。

复习只有一个收纳箱，但允许创建多条复习 Pi Session；`review_topic_id` 仍然在 Pi Session 上，用于限定某一次复习的 Topic。

助教 Space 只允许存在一条固定 Pi Session。从任何入口打开助教都复用这条记录，不提供创建助教入口。数据库初始化时在固定 `ta` Space 下直接创建该 Pi Session 与目录；数据库唯一约束保证重复初始化和并发路径不会产生第二条记录。

### 5. 不提供 Space 级共享工作目录

本决策采用“纯收纳箱”方案：同一个 Space 下的 Pi Session 不共享 `MISSION.md`、`GLOSSARY.md`、`essence/` 或 `learning-records/` 目录。需要跨 Space 复用的资料放在全局 `materials/` / `assets/`，已掌握术语放在全局 `glossary` 表。

文件系统访问不由本产品业务层按 Pi Session 做权限隔离。Pi 运行在 Docker 部署边界内，远程沙箱由独立 skill 负责；本项目不再增加“只能访问当前 `work_path`”的应用级路径限制。不同角色之间的业务权限仍由工具控制层决定，例如助教禁止制卡与复习写入操作。

## 目录形态

物理目录采用按 Space 类型和 Pi Session 身份隔离的布局，不得再使用 Space 目录作为 Pi Session 的 cwd：

```text
~/pi-teacher/
├── learn/<space-id>/pi/<pi-session-id>/
├── review/pi/<pi-session-id>/
└── ta/pi/<pi-session-id>/
```

全局 `~/pi-teacher/AGENTS.md` 仍通过 Pi 的祖先目录机制加载；每个 Pi Session 目录中的 `AGENTS.md` 与 `style.md` 只服务该 Pi Session。

## 后果

- 数据关系更简单：只有 `space -> pi_session` 一条容器关系；
- 同一个学习 Space 可以收纳不同主题、不同提示词和不同教学风格的对话；
- 复习历史统一收纳到一个固定复习 Space；
- 助教的固定复用语义可以由唯一索引和初始化逻辑明确保证；
- 不能再依赖 Space 目录承载跨对话学习文件；跨对话共享资料必须使用全局资料库或以后单独设计的资源机制；
- 后端需要同步重做 schema、Space/对话路由、目录生成、工具上下文和验证脚本，前端 WebUI 应建立在新 API 契约上；不新增 Pi Session 级应用路径权限，Docker 与远程沙箱 skill 负责部署/执行隔离。

## 否决方案

### 保留 `session` 作为共享工作目录

否决。它把“收纳关系”和“Pi 运行上下文”绑定在一起，无法支持同一收纳箱内不同 Pi Session 使用独立提示词与风格，并且会产生文件覆盖和运行中上下文漂移。

### 同时保留 `session_id` 与 `space_id`

否决。两个父级字段会制造双重真相源，可能出现 `session` 与 `space` 表达不同类型或不同归属的记录；当前产品不需要两个容器层级。

### Space 仍只是三行类型枚举，复习/助教不建容器关系

否决。固定 Space 作为稳定入口和 Pi Session 的唯一父级，能统一学习、复习、助教的列表、历史和生命周期处理；Space 的固定性不妨碍其成为收纳容器。
