# 用户资源目录与挂载约定

skill 注册位置、AGENTS.md / USER.md 分层、部署挂载方式与密钥注入的统一约定。本文只定约定与机制事实，Dockerfile / compose 的具体实现留到部署任务再写。

机制事实全部核实于 pi-coding-agent v0.84.2 源码（`dist/core/resource-loader.js`、`dist/core/skills.js`、`dist/core/package-manager.js`、`docs/skills.md`）。

## 结论

| 资源 | 位置 | 理由 |
| --- | --- | --- |
| 全局 AGENTS.md | `~/pi-teacher/AGENTS.md` | 祖先遍历让它在三个工作区全部自动注入（机制见下），业务资产不进系统层 |
| 全局 USER.md | `~/pi-teacher/USER.md` | Pi 无原生 USER.md 机制，注入靠 AGENTS.md 引导句；放业务根与 materials/ 同层 |
| 会话模板投影 | 各 Pi Session 的 `work_path`（如 `learn/2/pi/42/AGENTS.md`） | 沿用数据库设计.md 的 `agents_md` 投影约定；每个 Pi Session 独立投影 |
| skills | `~/.pi/agent/skills/` | Pi 全局 skill 目录（机制见下），部署时目录挂载 |
| 密钥 `.env` | `~/pi-teacher/.env` | 不随 skill 分发、不进镜像；env > .env，启动时单向同步 |

## 机制事实（v0.84.2 源码级）

### skills 发现路径

- 全局：`~/.pi/agent/skills/`、`~/.agents/skills/`（均无条件加载）
- 项目（需 trust）：`.pi/skills/`、cwd 及祖先目录的 `.agents/skills/`（到 git 仓库根）
- 其他来源：包内 `skills/`、settings.json `skills` 数组、CLI `--skill <path>`（`--no-skills` 下仍生效）
- 同名冲突：先到先得，项目级胜过全局级；不同名全部加载
- 嵌套规则：含 `SKILL.md` 的目录即一个 skill 且不再深入；无 `SKILL.md` 则递归子目录

### AGENTS.md 注入机制

- 候选文件名（每目录按序取第一个存在的）：`AGENTS.override.md`、`AGENTS.md`、`AGENTS.MD`、`CLAUDE.md`、`CLAUDE.MD`。**小写 `agents.md` 不被识别**
- 加载范围：全局 `~/.pi/agent/AGENTS.md` 最前，然后从文件系统根向下到 cwd 的**全部祖先目录**（`resource-loader.js:93-105` 的 while 循环，不在 git 根停止）。`~/pi-teacher/AGENTS.md` 对所有 Pi Session 生效，当前 Pi Session 的 `work_path/AGENTS.md` 提供本次对话模板。
- 注入形态：所有 context 文件按序拼接进 system prompt 的 `<project_context>` 块，**不互相覆盖**；越靠近 cwd 越靠后（工作区模板在全局规则之后，符合「全局打底、模板具体化」）
- 关联约束：`SessionManager.create(cwd, ...)` 的 cwd 决定祖先遍历起点——后端必须传当前 Pi Session 的 `work_path`，不能让 cwd 退化为进程启动目录
- `~/.pi/agent/` 是系统层（settings/models/sessions/trust 归 Pi 框架管辖），不放业务文件

### USER.md：无原生机制

Pi 不存在 USER.md / user memory 概念（全源码关键词零命中）。它是纯业务文件，生效完全靠 AGENTS.md 里的引导句（「会话开始时先读全局 USER.md 与当前 Pi Session 的 USER.md，冲突以 Pi Session 级为准」——见 `提示词设计/全局提示词.md`）。放 `~/.pi/agent/` 无任何增益。

## 部署约定

### 目录挂载，不用 docker 卷

skills 目录挂载为宿主目录（`-v /host/skills/tavily-search:/root/.pi/agent/skills/tavily-search` 一类）。不用 named volume / anonymous volume：直接目录挂载语义更直观、宿主侧可直接查看与备份、无 volume 生命周期管理成本。单用户本地部署没有跨机迁移需求。

`~/.pi/agent/`（trust.json、sessions 等运行态）同样目录挂载；`~/pi-teacher/` 整体（数据库、materials、USER.md、AGENTS.md、.env）目录挂载。

### 密钥注入：env > .env，启动时单向同步

- 取值优先级：**环境变量优先于 `~/pi-teacher/.env`**——tavily-search 的 Go 实现（`getSetting()`，env 先查）已是如此，零改动维持
- 同步方向：后端启动时，把**白名单内**且**环境变量持有的** key 覆盖写进 `~/pi-teacher/.env` 对应行；环境变量没有的 key 一行不碰
- 同步时机：**启动时一次**。docker 的 env 在容器生命周期内不可变，改 env 必须重建容器，重启即重跑同步——定时任务在此无增量，徒增 cron 守护一个进程
- 白名单起步：`TAVILY_API_KEY` / `TAVILY_BASE_URL` / `TAVILY_TIMEOUT`；以后每接一个 skill 扩这个数组
- 维护规则（写进运维习惯）：**env 注入了的 key 归 env 管**（要改值改 env），**`.env` 独有的 key 归 `.env` 管**（手工维护）。两源各管各的 key，无遮蔽歧义
- 同步载体：将来 Node 后端的启动钩子（纯 TS 模块，可测试），不装 cron、不写 entrypoint 脚本

### dev 环境（容器外）

联调 skill 时用符号链接：`ln -s /workspace/pi-teacher/skills/tavily-search ~/.pi/agent/skills/tavily-search`。仓库是唯一源，改完即生效。验证脚本（run-real.ts）维持 `noSkills: true`，工具注册验证与 skill 联调互不干扰。

## 与现有文档的关系

- `数据库设计.md`「agents_md 投影成工作区 AGENTS.md」——不变，且本 ADR 证实了该机制可用（祖先遍历 + cwd 投影最后注入）
- ADR-0014「静态内容走文件投影」——全局规则不进 agents_md 库（它是产品行为定义，改动等于发版；用户运行时可调的是模板与教学风格，已在库里），所以全局 AGENTS.md 是仓库里的静态文件，无投影通路
- ADR-0027「能力扩展只有 skill 和插件两个载体」——本 ADR 补上 skill 的落点
- `docs/open-questions.md` 里 AGENTS.md 机制的核实记录——本文是其部署形态的决议

## Considered Options

### 全局 AGENTS.md / USER.md 放 `~/.pi/agent/`

否决。祖先遍历机制下 `~/pi-teacher/` 与 `~/.pi/agent/` 在本产品场景效果相同（三个工作区都是前者的子目录）；但 `~/.pi/agent/AGENTS.md` 会注入**所有** pi 会话，包括与教学无关的调试会话，污染系统层。业务资产放业务根。

### USER.md 放 `~/.pi/agent/USER.md`

否决。Pi 无原生机制，放哪都靠引导句生效，无增益；且把业务用户画像混进 Pi 框架管辖的目录层，部署挂载时还得为它单独开洞。

### skills 走 docker 卷

否决。见上文「目录挂载，不用 docker 卷」。

### `.env` > env 的优先级

否决。需要改 Go 源码重新编译，破坏「本仓库纯 TS、无编译阶段」（ADR-0015）；且反 dotenv / 12-factor 惯例，失去 `KEY=x ./tavily-search` 的临时覆盖调试能力。

### 定时同步任务

否决。容器 env 生命周期内不可变，重启即重跑启动同步，定时器在两次启动之间无增量可同步，白付一个 cron 守护进程。

### 纯追加式同步（env 有而 .env 无的才追加，不覆盖）

否决。轮换 key 后旧值永远留在 `.env`，一旦某次容器没带 env 启动，旧 key 复活导致鉴权失败且难排查。覆盖式（env 持有的 key 直接更新对应行）语义才闭合。
