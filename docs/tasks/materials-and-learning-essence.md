# PRD：资料归档与学习精华

> 状态：已实现并完成工程验收（2026-09-11），WebUI 待用户验收。
> 决策以 ADR-0039 为准；本文件记录实现范围与验收结果，模型偏好行为的失败单独记录，不计为通过。

## 目标

明确上传输入、全局学习资料与会话精华的职责；为学习会话补齐精华目录及周期提醒；移除卡片到精华文件的路径关联。已有 MVP 增量修改，不调整桥接层或会话架构。

## 需求

### 资料归档只约束提示词

- 上传继续落到当前 Pi Session 的 `files/`。
- 模型先阅读并判断正确性、可学习性：规整资料直接移入 `materials/`；凌乱但正确可学的原件先移入 `materials/origins/`，整理版本放到 `materials/`。
- 模型维护 `materials/index.md`；不能确认质量的不直接成为正式学习资料，不擅自删除用户文件或覆盖已有资料。
- 规范集中在 `server/src/prompts/defaults.ts` 的 `GLOBAL_AGENTS_MD`，不新增自动判断、移动、转换或索引服务。

### 学习专属精华

- 仅学习 Pi Session 新建时默认创建 `<work_path>/essence/` 空目录，程序不生成正文。
- 旧学习会话正常打开时幂等补齐；历史 JSONL 缺失先报错，不新建替代会话，也不启动全盘补目录扫描。
- 助教、复习不自动创建，不删除任何会话已有的精华文件。
- 学习会话的 `essence` 被普通文件占用时返回 409，保留原文件。

### 同轮提醒与设置

- 原三段基础文案保持不变，新增 `learningEssence` / `reminder_text_learning_essence`。
- 仅学习会话命中时，在原基础提醒后同轮追加精华段；制卡开、关都追加。助教与复习只保留原提醒。
- 共用 `reminder_interval_turns`、原轮次计数与发送路径；0 关闭全部提醒，不增加独立间隔、计数器、开关或后台任务。
- 文案缺行取出厂值，空串恢复默认，设置页复用现有文案编辑器。原三段自定义文案不被迁移或覆盖。
- 提醒按需维护已有精华，避免重复与流水账，不强制每次写文件。

### 卡片解耦

移除 `card.source_essence_path`、`card_propose` 参数、`card_get` / 复习取卡返回以及 HTTP / 前端的 `has_source_essence`。旧库检测后幂等删列，保留其他卡片字段、ID、调度、复习日志及精华文件，不新增替代关联。

## 实现位置

| 文件 | 变更 |
| --- | --- |
| `server/src/prompts/defaults.ts` | 全局资料规范、学习精华职责、第四段默认提醒 |
| `server/src/session/repository.ts` | 目录常量与幂等 helper、新建学习会话初始化 |
| `server/src/routes/conversations.ts` | 正常打开旧学习会话补目录、命中轮组合提醒 |
| `server/src/projection/maintenance-reminder.ts` | 基础文案 + 仅学习追加段 |
| `server/src/config/app-settings.ts` | 第四种文案及键，沿用设置 API |
| `web/src/api/types.ts`、`web/src/settings/AdvancedTab.tsx` | 同步类型与学习精华编辑项，保留现有布局 |
| `server/src/db/schema.ts` | 新库去列、旧库 PRAGMA 检测与 DROP COLUMN |
| `server/src/tools/cards.ts`、`server/src/fsrs/service.ts`、`server/src/routes/cards.ts` | 移除工具、取卡与 HTTP 的旧字段 |
| `server/src/verify/` | 扩充目录、迁移、文案组合与契约断言 |

`seed.ts` 的 `ensureGlobalLayout()` / `writeIfMissing()` 继续复用，不覆盖既有全局规则。提醒的 HTTP 路径仍为 `GET/PATCH /api/config/settings`，没有新 endpoint。

## 验收清单

- [x] 新建学习会话（制卡开 / 关）都有空 `essence/`；助教与复习默认没有。
- [x] 旧学习会话正常打开补目录，重复打开不改已有内容；普通文件冲突 409 且原字节保留；缺 JSONL 不补目录。
- [x] 所有会话类型的已有精华不删除；删除会话 / Space 后工作目录里的精华保留。
- [x] 新库卡片不含来源列；真实旧库含各状态卡片、调度、复习日志，重复初始化后其余字段、ID、自增序列、索引和约束不变。
- [x] 新全局 AGENTS.md 使用出厂规范，已有文件字节、权限和资料索引不被覆盖。
- [x] 新精华文案保存、读回、恢复默认正确；初始化与编辑精华文案不改变三段基础自定义文案。
- [x] 真实模型 payload：学习制卡开 / 关仅在命中轮追加精华，非命中轮和 N=0 不追加；复习制卡开 / 关与助教仅用基础文案。
- [x] `prompt` / `steer` / `follow_up` 共用提醒路径，提醒原样落 JSONL 并在历史可见。
- [x] 工具 schema / 卡片详情 / 复习取卡 / HTTP 卡片响应均不再包含旧字段。
- [x] 后端 typecheck、`verify:schema`、`verify:config`、`verify:attachments`、`verify:lifecycle`、`smoke`、`http-smoke` 与前端 build 通过。`verify` 的模型偏好行为按用户决定不再追测，失败单独记录，不计通过。
- [x] ADR、领域语言、数据库目录设计、工具定义、部署、CLAUDE.md 与 TODO 同步；中文无替换字符乱码。

### 本轮验证记录（2026-09-11）

| 验证 | 结果 |
| --- | --- |
| 后端 typecheck | HTTP 请求定位修正后重跑通过 |
| 前端 build | 通过；有 Vite chunk 体积警告，无构建失败 |
| `verify:schema` | 100 通过，0 失败 |
| `verify:config` | 108 通过，0 失败 |
| `verify:attachments` | 126 通过，0 失败 |
| `smoke` | 91 通过，0 失败 |
| `verify:lifecycle` | 18 通过，0 失败 |
| `http-smoke` | 修正请求定位后完整重跑：522 通过、0 失败、0 跳过；期间有一次标题生成失败提示，不影响本轮 HTTP 断言 |
| `verify` | 27 通过，1 失败：模型把全局偏好写入会话文件。按用户决定不再追测，保留原断言与失败记录 |
| Docker / `verify:remote` | 本阶段未重建镜像、未执行远程容器验收 |
| 浏览器 | 未执行，由用户验收 |

代码只读审查与根层 `CLAUDE.md` 规范审查通过。HTTP 请求定位问题的原因与修正见 `docs/spec.md` 对应条目。

验证使用临时隔离数据目录与独立 agent 配置，真实调用 Pi SDK / 模型，不使用 mock；不动用户 `~/.pi`，不重启用户服务。程序验收只断言目录、注入内容与数据契约，不要求模型每次实际归档或写精华。

## 用户 WebUI 验收

1. 高级配置出现「学习精华」编辑项；修改保存后再打开能读回，恢复默认也会清掉未保存的本地草稿。
2. 把提醒间隔临时设为 2：学习第 2 轮显示基础提醒 + 精华段，关掉制卡后后续命中仍有精华段；复习与助教没有精华段。
3. 新建学习对话后，可通过文件索引查看实际写入的 `essence/` 内容；空目录不作为文件条目显示。
4. 现有卡片审批、卡库展示与复习保持正常，无精华来源跳转。
5. 完成后恢复原提醒间隔。

## 升级说明

既有 `~/pi-teacher/AGENTS.md` 需从设置页手工合并新规范，程序不覆盖。原三段自定义文案无需重置，精华段缺行即默认生效。容器重建镜像即可获得新逻辑，不需要重建数据库或学习会话；删列不可由旧镜像自动逆转，回退前先恢复升级前备份。详见 `docs/deploy.md`。
