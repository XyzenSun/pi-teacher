# 提示词优化与 skill 完善（sbx 源码转入）

2026-09-13 立项。两个子目标：sbx 源码权威转入本仓库（保持单文件 node cli 分发），以及围绕使用痛点的提示词优化。

**进度（2026-09-13）**：子目标 A 已完成（源码迁入、文档与 ADR 落位、产物未重打——上游 0.1.0 与现有 bundle 严格对应，详见 ADR-0043）；子目标 B 待用户补充痛点清单后启动。

## 背景

- **sbx 源码不在本仓库**：`skills/sbx/` 只有 esbuild bundle 产物（`scripts/sbx`，4.4M）与 `sourcecode/README.md`（记录从 npm 包 `@xyzensun/sbx` 重建的方法）。源码在上游 codeup 私有仓 `sandbox-cli.git`：11 个 TS 文件共 1783 行，MIT，依赖 commander 与三家沙箱 SDK（`@codesandbox/sdk` / `@daytona/sdk` / `e2b`）。改 sbx 行为必须去上游仓库改、发版、再回来重打 bundle，链路长且两仓漂移无护栏。
- **提示词未围绕痛点打磨**：出厂文案全在 `server/src/prompts/defaults.ts`（六类常量），五个 skill 各有 `SKILL.md`；此前迭代以功能落地为主，提示词只保证「能工作」，没有针对实际使用中暴露的模型行为问题系统修过。

## 子目标 A：sbx 源码权威转入本仓库

用户决策（2026-09-13）：`skills/sbx/sourcecode/` 成为唯一权威源，上游 `sandbox-cli` 仓库归档不再维护。此后改 sbx 直接在本仓库改源码 + esbuild 重打，与 tavily-search「脚本本身即源码」的维护范式对齐（区别只在 sbx 因 SDK 依赖仍需 bundle，不能纯手写）。

### 复制范围（自上游 0.1.0）

| 复制 | 排除 |
| --- | --- |
| `src/` 全部（10 个 .ts + 1 个 d.ts，1783 行） | `nul`（Windows 残留空文件） |
| `package.json` + `package-lock.json`（可重现构建） | `.git/` |
| `tsconfig.json`、`README.md`（上游通用说明，落 `sourcecode/` 下） | 上游 `SKILL.md`（见下） |

**不覆盖 `skills/sbx/SKILL.md`**：本仓库版本是 Pi Teacher 适配版（`scripts/sbx` 相对路径、key 由后端注入、缺 key 指向设置页、无 `--envfile` 章节）；上游版本是 npm 包视角（`command -v sbx` / `npx` 探测、`--envfile` 用法）。两者已有实质分叉，分发面以本仓库版本为准。

### 构建流程改写

`sourcecode/README.md` 从「上游仓库 + npm 安装重打」改为「本仓库源码即权威」：

1. `sourcecode/` 下 `npm install`（lock 文件随源码走，保证依赖版本可重现）
2. esbuild bundle `src/index.ts` → `../scripts/sbx`，沿用现有参数（`--platform=node --format=esm --target=node24` + `createRequire` banner；cjs 产物与裸 esm 的失败模式已记录在案，不重试）
3. `chmod 755`，提交产物

产物形态不变：单文件 node cli、纯 JS 无原生模块、离线可用。

### 决策记录

- 新 ADR-0043：sbx 源码权威转移至 pi-teacher，上游仓库归档；理由（上游仅此一个消费者、双仓漂移风险、本仓库已具备完整验证链路）
- ADR-0040 顶部加状态行：其中「切换或新增沙箱平台由上游 CLI 负责，Pi Teacher 只需重新打包」的维护责任表述自 ADR-0043 起改为本仓库自持源码；分发形态（esbuild 单文件）决策不变

### 实施时定夺（已定，2026-09-13 执行）

- **`--envfile` 保留**：迁入基线与上游 0.1.0 严格逐字节一致，`scripts/sbx` 产物才无需重打；Pi Teacher 场景不使用（SKILL.md 明令禁止），待 sbx 第一次真实改动时再评估删除（ADR-0043「Considered Options」有完整取舍）
- **上游 README.md** 原样存为 `sourcecode/UPSTREAM-README.md`（含三家反代环境变量表，SKILL.md 未覆盖）；`sourcecode/README.md` 重写为本仓库权威说明
- 上游仓库归档的具体方式（README 加迁出说明 / codeup 网页归档操作）由用户自行处理，本任务只负责本仓库侧

## 子目标 B：提示词优化（围绕使用痛点）

用户决策（2026-09-13）：围绕使用痛点逐条修，不做无目标的通盘重写。

### 痛点清单（待用户补充）

使用中发现的模型行为问题，例如（不限于）：不遵守资料归档规范、维护提醒长期不触发维护、风格模板与预期教学风格不符、制卡质量不稳、skill 调用时机不对等。**每条痛点定位到具体提示词段后再动手，改点先与用户确认。**

### 提示词面盘点（改动候选）

| 位置 | 内容 |
| --- | --- |
| `server/src/prompts/defaults.ts` `GLOBAL_AGENTS_MD` | 全局规则：角色声明、资料分流（materials / origins）、卡片规范 |
| 同上 `AGENTS_MD_TEMPLATES` | learn / review / ta 三类会话的工作目录 AGENTS.md 模板 |
| 同上 `TEACH_STYLE_TEMPLATES` | 教学风格模板 |
| 同上 `REMINDER_TEXT_DEFAULTS` | 三段基础维护提醒 + `learningEssence` 学习精华段 |
| 同上 `USER_PREFERENCES_PLACEHOLDER` / `MATERIALS_INDEX_PLACEHOLDER` | 全局偏好与资料索引的占位结构 |
| `skills/*/SKILL.md` × 5 | tavily-search / exa-search / pullpage / sbx / tingwu-transcribe 的 name / description / 用法 |

### 升级语义注意

`REMINDER_TEXT_DEFAULTS` 存 `setting` 表、缺行即出厂值（ADR-0036 / 0039）：改出厂文案只对从未保存过自定义文案的库生效；全局 `AGENTS.md` 同理（只在文件缺失时写一次，之后是用户的文件）。改这两类文案后，已有部署需用户在设置页手动重置或合并，验证与文档里要写明。

## 验证

- **sbx**：`sourcecode/` 重打 bundle 后 `scripts/sbx --version`、无 key `list` 文案、假 key 打平台返回鉴权错误（证明 SDK 链路未破坏）；镜像重建后 `verify:remote`（含 skill 探针）
- **提示词**：后端 typecheck；改动触及 http-smoke 已断言的提示词时跑相应节；真模型 `verify` 按需
- **文档**：AGENTS.md 技术事实（sbx 段改「源码在本仓库 sourcecode/」）、ADR-0043 + ADR-0040 状态行、`sourcecode/README.md` 重写
