# 全局目录布局补建与提示词四层来源

- 状态：已采纳
- 日期：2026-09-10
- 相关：ADR-0020（术语进库、只写引导）、ADR-0021（节奏偏好写进 USER.md）、ADR-0028（不替换默认 system prompt）、ADR-0029（全局 AGENTS.md 由祖先遍历自动注入）、ADR-0031（Teach Style 运行期切换）
- supersedes：`docs/提示词设计/全局提示词.md`（该目录已于 2026-09-11 删除，出厂提示词收进 `server/src/prompts/defaults.ts`）中「两份 USER.md、会话开始时先读」的旧草案；ADR-0029 里「Pi Session 级 USER.md」的命名

## 背景

`数据库与目录结构设计.md` 定义的 `~/pi-teacher/` 全局文件（`AGENTS.md`、`USER.md`、`materials/`、`assets/`、`llm-text-to-img/`）在 MVP 期间从未被 `seed.ts` 创建，桥接层注释里「祖先遍历使全局 AGENTS.md 自动注入」是一句没有文件支撑的空话。同时目录设计缺一个会话级用户偏好文件，旧草案把它叫 `work_path/USER.md`，与全局同名，且依赖 AGENTS.md 里一句「会话开始时先读两份文件」——这把「读不读」交给模型的同时，程序对它的存在一无所知。

## 决策

提示词进入模型上下文只有四条来源，各自的维护者与通道固定：

| 层 | 文件 | 谁维护 | 通道 |
| --- | --- | --- | --- |
| 全局规则 | `~/pi-teacher/AGENTS.md` | seed 初始化写入模板，之后用户可改 | Pi 祖先目录发现，自动进 system prompt |
| 会话职责 | `<work_path>/AGENTS.md` | 数据库 `agents_md` 投影 | 同上 |
| 全局偏好 + 教学风格 | `~/pi-teacher/USER.md` + `<work_path>/style.md` | 用户（设置 → 用户偏好）/ 数据库 `teach_style` 投影 | 开会话时读一次，拼成一段固定格式的 `appendSystemPrompt` |
| 会话级偏好 | `<work_path>/pi-session-user.md` | 模型在对话中自行创建与维护 | 不注入内容；上面那段末尾固定附一句引导 |

优先级：会话级偏好 > 教学风格 > 全局偏好。固定段落的形态见 `server/src/projection/system-prompt-builder.ts`：任一层非空才输出，缺失层省略标签块，会话级引导块无论文件是否存在都输出。

`seed.ts` 幂等补建全部全局文件与目录：只补缺失，绝不覆盖已有内容。默认会话模板（学习 / 复习 / 助教）只写本类型职责，跨类型规则集中在全局 `AGENTS.md`。

全局 `USER.md` 有 `GET/PUT /api/config/user-preferences` 与设置面板「用户偏好」Tab；全局 `AGENTS.md` 有 `GET/PUT /api/config/global-agents-md`，编辑器放在 Agents Md Tab 顶部（它不是模板，不进 `agents_md` 表，固定操作 `homeDir/AGENTS.md`）。两者共用 `server/src/config/home-markdown.ts` 的原子写。会话级 `pi-session-user.md` **没有 API、不投影、程序不读取**。

## 为什么会话级偏好不给程序读

与 ADR-0020 的术语表是同一模式：程序只负责让模型知道有这个东西、它的优先级、什么时候该写，不替模型决定什么时候读。理由：

- 会话中途模型新建了文件，无需重开会话即可生效——如果程序在构造时读一次，就得再加一条「文件变了就 reload」的机制。
- 「这个要求是本会话的还是全局的」是判断，不是不变量；判错的后果只是偏好作用域偏小（ADR-0014 归提示词迭代），不值得为它加 API 与界面。
- 不与全局 `USER.md` 同名，程序、用户、模型三方谈论它时不会混淆。

## 为什么 `style.md` 与 `USER.md` 不走 AGENTS.md 引导

Pi 只自动发现 `AGENTS.md`，`style.md` 是本产品自定义文件。靠 AGENTS.md 里一句「先读 style.md」让模型自己读，等于把教学风格能否生效押在模型是否听话上；`appendSystemPrompt` 是确定的。全局 `USER.md` 同理，且合并成一段可以把优先级写在同一处，不必两份文件各说一套。

## 后果

- 真模型验收（`run-real.ts` 第 6 节）证实：仅靠引导句，模型会为「本次对话所有代码示例用 Rust」创建 `pi-session-user.md`，而对「以后所有对话都少用类比」不写入。
- `USER.md` 进入模型上下文，界面与初始占位注释都提示用户勿写凭据；程序不做内容拦截。
- 已部署环境 `agents_md` 表里的旧模板仍含与全局重复的句子；seed 不覆盖用户编辑，用户可在 Agents Md Tab 手工精简。
- Pi 祖先遍历也会捡到 `~/pi-teacher/` 更上层的 `AGENTS.md`（如 `~/AGENTS.md`）；部署时保持 `homeDir` 之上没有无关的 AGENTS.md。
