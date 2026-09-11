# PRD：全局目录布局补全与提示词分层注入（global-layout-prompt-layering）

> 基线 commit `3f3c3a0`（第二阶段 frontend-polish-config 已推送）。
> 本 PRD 解决一个漏实现：`数据库与目录结构设计.md`「目录布局」定义的 `~/pi-teacher/` 全局文件与目录，`seed.ts` 从未创建，注入链路也从未接上；同时补上目录设计里缺失的会话级用户偏好文件 `pi-session-user.md`。
> 相关决策：ADR-0020（术语进库、`USER.md` 只写引导）、ADR-0021（节奏偏好写进 `USER.md`）、ADR-0029（全局 AGENTS.md 由祖先遍历自动注入）、ADR-0031（Teach Style 运行期切换）。
> 文档改名：`数据库设计.md` 已改名为 `数据库与目录结构设计.md`，仓库内全部引用随本任务一并更新。

## 1. 目标与边界

### 做什么

1. `seed.ts` 幂等补建 `homeDir/` 下的全局文件与目录：`AGENTS.md`、`USER.md`、`materials/`（含 `index.md`、`origins/`）、`assets/`、`llm-text-to-img/`。
2. 全局 `homeDir/AGENTS.md` 写入初始内容，依赖 Pi 祖先目录发现机制自动进入所有会话的 system prompt（ADR-0029），不做手动注入。
3. 全局 `homeDir/USER.md` 与会话级 `work_path/style.md` 合并后通过 `appendSystemPrompt` 注入，并固定附带一句关于会话级偏好文件 `pi-session-user.md` 的引导。拼接格式与优先级见 3.5。
4. 会话级用户偏好文件固定命名 `work_path/pi-session-user.md`，由 AI 在对话中自行创建和维护。程序**不提供 API、不投影、不读取、不注入其内容**，只在 `appendSystemPrompt` 里固定告诉模型：若当前目录含 `pi-session-user.md`，它是用户在本会话中对你的特殊要求；当察觉到用户提出只针对本会话而非全局的要求时，创建或维护此文件。
5. 全局 `USER.md` 提供 WebUI 编辑：设置面板新增「用户偏好」Tab + `GET/PUT /api/config/user-preferences`。
6. 会话级 `AGENTS.md` 默认模板（`LEARN_PROMPT` / `REVIEW_PROMPT`）与全局 `AGENTS.md` 去重：全局讲跨会话通用规则，会话级只讲该类型职责。
7. 文档改名收尾：仓库内所有 `数据库设计.md` 引用改为 `数据库与目录结构设计.md`（CONTEXT、docs/、ADR、server 源码注释），该文档一级标题同步改名，目录布局补上 `pi-session-user.md` 并标注 `USER.md` / `style.md` / `pi-session-user.md` 三者的注入方式。

### 不做什么

- 不改 `style.md` 的注入通道。`style.md` 是本产品自定义文件，Pi 不会自动发现它，`appendSystemPrompt` 是唯一正确路径。
- 不改 `agents_md` / `teach_style` 表与会话级 `AGENTS.md` 的投影逻辑。
- 不做会话级 `pi-session-user.md` 的任何 API、投影、读取或内容注入；程序只知道它的文件名，不知道它的内容。
- 不做 `materials/` 的内容管理 UI，文件由模型自读自写（ADR-0020 同一模式）。
- 不做 per-request 偏好注入；`context` 钩子仍只承载状态（活动类型、到期数、制卡开关）。
- 不重写桥接层与会话架构。

## 2. 现状事实（已核实）

| 事实 | 位置 |
| --- | --- |
| `~/pi-teacher/` 实际只有 `data/`、`learn/`、`review/`、`ta/`、`.env` | 真实环境 `ls` |
| `seed.ts` 只建 ta Pi Session 目录与 `attachments/`，无任何全局文件 | `server/src/db/seed.ts:46-51` |
| `style.md` 在会话构造时读一次，非空则 `appendSystemPrompt: [style]` | `server/src/bridge/agent-session-wrapper.ts:548-556` |
| wrapper 注释已声明「祖先遍历使全局 AGENTS.md 自动注入」，但文件不存在 | `server/src/bridge/agent-session-wrapper.ts:524` |
| `context` 钩子只注入一句状态，不落 JSONL | `server/src/projection/context-inject.ts` |
| `LEARN_PROMPT` 已含「制卡开关」「Topic」「不编造」「独立维护 MISSION.md/GLOSSARY.md/learning-records/essence/」等跨类型规则 | `server/src/db/seed.ts:10-17` |
| `md_list` / `md_read` 注释引用 `materials/`，但目录不存在 | `server/src/tools/files.ts:10` |
| Pi `resourceLoader.getAgentsFiles()` 从 cwd 向上发现 AGENTS.md；文件先于 `createAgentSessionServices` 存在即被读到 | `docs/pi-web-研究/01-桥接层.md:405-412` |
| `homeDir` 在 `buildApp({ homeDir })` 层可得 | `server/src/index.ts` |
| 设计文档已改名为 `数据库与目录结构设计.md`，但一级标题仍是「数据库设计」，仓库内 40+ 处引用仍指向旧名 | `grep -rn "数据库设计.md"` |
| 目录布局中每个 Pi Session 目录只列了 `AGENTS.md` / `style.md` / `*.jsonl`，没有会话级用户偏好文件 | `数据库与目录结构设计.md:415-460` |

## 3. 需求详述

### 3.1 全局目录与文件（seed）

初始化时补建，全部 `existsSync` 前置、只补缺失、**绝不覆盖已有内容**（用户与模型都可能已编辑）：

```
homeDir/
  AGENTS.md            全局规则（初始内容见 3.2）
  USER.md              全局用户偏好（初始内容见 3.3）
  materials/
    index.md           初始一行标题 + 注释「由模型维护」
    origins/
  assets/
  llm-text-to-img/
```

目录权限沿用 `mkdirSync({ recursive: true })` 默认；两个 md 文件 mode 0644。

### 3.2 全局 `AGENTS.md` 初始内容

内容来源：新建 `提示词设计/提示词模板/agentsmd/全局.md`，与助教模板同目录同机制（`readFileSync` 读入，空文件抛错）。不写在 `seed.ts` 字面量里，便于提示词单独迭代。

> 2026-09-11 变更：`docs/提示词设计/` 已删除，全局 AGENTS.md 与各模板的出厂内容统一收在 `server/src/prompts/defaults.ts`（`GLOBAL_AGENTS_MD` / `AGENTS_MD_TEMPLATES` / `TEACH_STYLE_TEMPLATES`），镜像不再带 `docs/`；调提示词改这一个文件。

覆盖范围（只写跨会话类型通用的）：

- 工具调用原则：有明确需求才调用；`card_propose` 仅在制卡开关开启时用，关闭时跳过不解释；卡片必须归属有意义的 Topic，不为临时知识点新建 Topic
- 资料库：`materials/` 与 `materials/index.md` 的用途；读大文件用 `md_list` / `md_read` 而非全文 read；不假设其他对话内容在当前上下文
- 用户模型：`glossary` 表存已掌握术语，用工具读，何时读自行判断（ADR-0020）
- 会话级维护：每个会话目录下的 `MISSION.md`、`GLOSSARY.md`、`learning-records/`、`essence/` 由 AI 自行创建和维护
- 语言：中文回答，术语保留原文

用户偏好的三层关系（全局 `USER.md` / 会话 `style.md` / 会话 `pi-session-user.md`）**不写在全局 `AGENTS.md` 里**，统一由 3.5 的 `appendSystemPrompt` 固定段落承载，避免两处各说一套。

### 3.3 全局 `USER.md` 初始内容

```markdown
# 全局用户偏好

<!-- 直接编辑本文件，或在系统设置 → 用户偏好 中修改。示例：
- 讲解时多给具体代码示例，少用类比
- 术语保留英文，解释用中文
- 已掌握 HTTP、Git 基础，不必重复讲
-->
```

### 3.4 会话级默认模板去重

`LEARN_PROMPT` / `REVIEW_PROMPT` 中已被全局 `AGENTS.md` 覆盖的句子删除（制卡开关、Topic 归属、不编造、独立维护目录列表、不假设其他对话上下文），只保留学习/复习各自的职责描述。改动只影响 `seed.ts` 的默认字面量与新部署；已存在的 `agents_md` 行不改（seed 已有「不覆盖用户编辑」约束）。

助教模板 `助教.md` 同样检查一遍，删除与全局重复的内容。

### 3.5 注入合并（system-prompt-builder）

新建 `server/src/projection/system-prompt-builder.ts`：

```ts
/** 程序只读全局 USER.md 与会话 style.md；pi-session-user.md 只出现在引导句里，内容由模型自己读。 */
export function buildAppendedSystemPrompt(homeDir: string, workPath: string): string | undefined
```

**只要 `USER.md` 与 `style.md` 任一非空，就输出下面的固定段落**；两者都为空时返回 `undefined`（不传 `appendSystemPrompt`，与现状一致）。段落里缺失的层直接省略对应块，标签成对出现便于模型定位边界：

```text
以下为用户偏好与教学风格，会话级内容优先于全局内容。

<全局用户偏好>
{homeDir/USER.md 内容}
</全局用户偏好>

<教学风格>
{work_path/style.md 内容}
</教学风格>

<会话级用户偏好>
如果当前工作目录下存在 pi-session-user.md，它记录的是用户在本次会话中对你的特殊要求，优先级高于上面的全局偏好与教学风格；回答前先读取它。
当你察觉到用户提出的要求只针对本次会话而不是全局性偏好时，创建或维护 pi-session-user.md；全局性偏好不要写进这个文件。
</会话级用户偏好>
```

四态：

| USER.md | style.md | 结果 |
| --- | --- | --- |
| 空 | 空 | `undefined` |
| 非空 | 空 | 引导句 + 全局块 + 会话级引导块 |
| 空 | 非空 | 引导句 + 风格块 + 会话级引导块 |
| 非空 | 非空 | 引导句 + 全局块 + 风格块 + 会话级引导块 |

「空」定义：文件不存在，或 `trim()` 后为空，或**只剩 3.3 的初始占位注释**（占位注释不该进 system prompt）。

`pi-session-user.md` 是否存在、内容是什么，程序**不检查、不读取**——引导句无论文件是否存在都原样输出，由模型用文件工具自行读写。这样会话中途模型新建了该文件也无需重开会话即可生效。

`agent-session-wrapper.ts:548-556` 的 style 读取替换为调用该函数。`homeDir` 通过 `startOrGetSession` 的 `options` 新增可选字段传入，由 `routes/conversations.ts` 的调用点从 `state.homeDir` 传下去；缺省时退化为只读 `style.md`（保证 verify 脚本里不传 homeDir 的旧调用仍可用）。

生效时机与 ADR-0031 一致：会话构造时读取；已打开会话不受影响；切换教学风格触发的 reload、空闲回收后重开、手动重开都会读到最新 `USER.md`。

### 3.6 全局 `USER.md` 编辑 API

挂在 `server/src/routes/config.ts`：

- `GET /api/config/user-preferences` → `{ content: string, path: "USER.md" }`（只回相对名，不回绝对路径）
- `PUT /api/config/user-preferences` body `{ content: string }` → `{ success: true }`
  - 校验：`content` 必须是字符串；长度上限 8000 字符，超出 400 并说明上限，不截断；body 只允许 `content` 一个键
  - 写入：同目录临时文件 + `renameSync` 原子替换，mode 0644；失败不破坏原文件
  - 不做内容语义校验（自由文本）

### 3.7 前端「用户偏好」Tab

`SettingsOverlay` 第 9 个 Tab，`?tab=preferences`：

- 单个多行编辑区，加载 `GET` 内容，`PUT` 保存；保存中禁用按钮，失败展示服务端错误
- 顶部说明：「下次打开或重载对话时生效；当前对话的教学风格与老师在会话中记录的 `pi-session-user.md` 优先于这里的设置。只针对某次对话的要求直接在对话里告诉老师即可，不要写在这里。」
- 字数计数与 8000 上限提示
- 复用 `web/src/ui/form.tsx` 现有控件，不新建样式类

## 4. 改动清单

| 文件 | 变更 |
| --- | --- |
| `提示词设计/提示词模板/agentsmd/全局.md` | 新增，全局 AGENTS.md 初始内容 |
| `提示词设计/提示词模板/agentsmd/助教.md` | 修改，删与全局重复内容 |
| `server/src/db/seed.ts` | 补建目录与文件；`LEARN_PROMPT`/`REVIEW_PROMPT` 去重 |
| `server/src/projection/system-prompt-builder.ts` | 新增，含固定段落模板 |
| `server/src/bridge/agent-session-wrapper.ts` | 替换 style 读取；`options.homeDir` |
| `server/src/routes/conversations.ts` | 调用点传 `homeDir` |
| `server/src/config/home-markdown.ts` | 新增：全局 USER.md / AGENTS.md 读 / 原子写 / 校验（实现时按用户要求加了 `GET/PUT /api/config/global-agents-md`） |
| `server/src/routes/config.ts` | 新增两条路由 |
| `server/src/verify/config-check.ts` | 新增全局文件与 builder 四态断言 |
| `server/src/verify/http-smoke.ts` | 新增 user-preferences 节 + systemPrompt 含全局 AGENTS.md / USER.md / `pi-session-user.md` 引导句断言 |
| `web/src/api/client.ts`、`web/src/api/types.ts` | 新增调用与类型 |
| `web/src/settings/UserPreferencesTab.tsx` | 新增 |
| `web/src/settings/SettingsOverlay.tsx` | 注册 Tab |
| `web/src/app/HelpOverlay.tsx` | 补一条「用户偏好」说明 |
| `数据库与目录结构设计.md` | 一级标题改名；目录布局补 `pi-session-user.md`；标注三种偏好文件的注入方式 |
| `CONTEXT.md`、`docs/open-questions.md`、`docs/工具定义.md`、`docs/adr/0018 / 0020 / 0022 / 0028 / 0029 / 0030` | 引用改名 |
| `server/src/{db/schema,fsrs/service,routes/cards,routes/prompts,routes/glossary,routes/topics,tools/cards}.ts` | 注释里的引用改名 |
| `tools-dev/CLAUDE.md`、`tools-dev/tasks/*.md`、`tools-dev/server/src/**` | 历史文档与冻结代码里的引用改名（只改字符串，不改行为） |

## 5. 文档同步

- 新增 `docs/adr/0033-global-directory-layout-and-prompt-layering.md`：记录四层提示词来源（全局 AGENTS.md 自动发现 / 会话 AGENTS.md 投影 / USER.md+style.md appendSystemPrompt 固定段落 / `pi-session-user.md` 由模型自读自写）、优先级顺序（会话级 > 风格 > 全局）、`pi-session-user.md` 不提供 API 也不由程序读取的理由（与 ADR-0020 术语表同一模式：程序只让模型知道有这个东西）
- `数据库与目录结构设计.md`：目录布局每个 Pi Session 目录下补 `pi-session-user.md ← 会话级用户偏好，模型自行维护`；「AGENTS.md 自动拼接」一节后补「用户偏好注入」小节说明三层关系；`teach_style_id` 行补「与全局 USER.md 合并注入」；存储边界表的「模型读写的散文」行把 `USER.md` 改为 `pi-session-user.md`
- `CONTEXT.md`：新增「全局用户偏好」「会话级用户偏好」两条术语，明确后者的文件名
- `docs/open-questions.md`：管理入口行加「用户偏好」Tab
- `tools-dev/tasks/TODO.md`：立项条目

## 6. 实现顺序

1. 文档改名收尾（纯字符串替换，先做，避免后续新写的文档再引用旧名）
2. 全局模板文件 + `seed.ts` 补建 → `verify:schema` 加目录断言
3. `system-prompt-builder.ts` + wrapper 接线 → `verify:config` 加四态断言与引导句断言
4. 默认模板去重（seed 字面量 + 助教.md）
5. `home-markdown.ts` + 路由 → `http-smoke` 加节
6. 前端 Tab → typecheck / build
7. ADR 与设计文档同步 → 真浏览器验收

每步完成即跑对应验证，不积压。

## 7. 验收标准

1. 空 `homeDir` 初始化后存在：`AGENTS.md`、`USER.md`、`materials/index.md`、`materials/origins/`、`assets/`、`llm-text-to-img/`
2. 已有 `homeDir` 重启，上述文件内容字节不变
3. 新建会话的 `agent.state.systemPrompt` 含全局 `AGENTS.md` 内容（Pi 自动发现，非手动拼接）
4. `USER.md` 与 `style.md` 四态组合的 `appendSystemPrompt` 结果与 3.5 表一致：全空为 `undefined`；任一非空时输出固定段落，缺失层的标签块不出现，且必含 `<会话级用户偏好>` 引导块
5. 仅含初始占位注释的 `USER.md` 视为空
6. 通过 Tab 保存 `USER.md` 后切换一次教学风格，新内容进入 system prompt；`work_path/style.md` 与 `AGENTS.md` 未被改动
7. `PUT` 8001 字符返回 400；多余键返回 400；非字符串返回 400
8. 保存失败时原文件字节不变，同目录无临时残留
9. `GET` 响应不含绝对路径
10. 代码中对 `pi-session-user.md` 的唯一引用是 builder 里的引导句字符串；没有任何路由、投影、`readFileSync` 或 `existsSync` 指向它
11. 真模型验收：在学习对话里说「这次对话里所有代码示例都用 Rust」，模型创建 `work_path/pi-session-user.md` 且内容包含该要求；随后说「以后所有对话都少用类比」，模型**不**把它写进 `pi-session-user.md`（应建议用户去设置里改全局偏好，或不写）
12. 会话级默认模板与全局 `AGENTS.md` 无重复句
13. 仓库内 `grep -rn "数据库设计.md"` 结果为零（排除 `.git`、`node_modules`）
14. `http-smoke`、`smoke`、`verify`、`verify:schema`、`verify:attachments`、`verify:config`、`verify:lifecycle` 全绿；server/web typecheck、web build 通过
15. 真浏览器：Tab 可见可编辑可保存，刷新后内容保留，`/app/c/:id/settings?tab=preferences` 可直达

## 8. 风险与对策

| 风险 | 对策 |
| --- | --- |
| 全局 `AGENTS.md` 被 Pi 发现依赖 `work_path` 位于 `homeDir` 之下 | 现有布局 `homeDir/learn/<space>/pi/<id>` 已满足；`verify:config` 用真实 session 断言 systemPrompt 包含全局标记句 |
| Pi 祖先遍历可能同时捡到 `homeDir` 上层的无关 `AGENTS.md`（如 `~/AGENTS.md`） | 部署文档注明；验收环境用临时 home 隔离 |
| 用户在 `USER.md` 写入 secret | 不做内容拦截（自由文本）；`GET` 只对已登录用户开放；ADR 注明「本文件进入模型上下文，勿写凭据」，Tab 说明同样注明 |
| 全局 + 会话 AGENTS.md + USER.md + style.md 叠加后 system prompt 过长 | `USER.md` 上限 8000；全局 `AGENTS.md` 初稿控制在 1500 字以内；引导段落固定不到 200 字 |
| 模型分不清「本会话要求」与「全局偏好」，把全局偏好写进 `pi-session-user.md` | 引导句明确两者边界并禁止写全局偏好；验收第 11 条用真模型验证；分类错误的后果只是偏好作用域偏小，属提示词质量问题，按 ADR-0014 归提示词迭代 |
| 模型不主动读 `pi-session-user.md` | 引导句写「回答前先读取」；同 ADR-0020 术语表的接受态度：忘读的后果是这次表现差，不是数据错 |
| 已部署环境 `agents_md` 表里的旧模板仍含重复句 | 接受：seed 不覆盖用户编辑；用户可在 Agents Md Tab 手工精简 |
| 文档改名后外部书签、他处笔记失效 | 仓库内引用全改；README 目录索引里保留一行「原名 `数据库设计.md`」 |
