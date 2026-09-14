# 代码注释自我完备化（去掉 ADR 与私有文档引用）

2026-09-13 立项。纯注释改动，不动任何运行逻辑。目标：生产代码的注释不再指向 `docs/`（ADR 编号与文档路径），改为把「为什么这么做」直接写在注释里，使注释脱离任何外部文档也可读懂。

## 背景与问题

生产代码（`server/src/` 除 `verify/` 与 `web/src/`）里有大量注释把「理由」外包给了 `docs/`。两类引用共涉及 37 个文件：

- **ADR 编号引用 67 处**，分布在 29 个文件（server 23 + web 6）。多数写成 `（…，ADR-00xx）`，少数整句只给编号（如 `见 ADR-0005`）。
- **私有文档路径引用 13 处**，如 `见 docs/工具定义.md`、`（docs/数据库与目录结构设计.md）`、`见 docs/pi-web-研究/04-API与基础设施.md`、`原始版权与许可见本仓库 docs/THIRD-PARTY-NOTICES.md`。

问题不在于 ADR 本身，而在于**注释依赖了它**：

1. **注释不自足**：读者（尤其是从 `main` 分支拿到代码的人）看到 `ADR-0035`、`ADR-0030` 无法就地理解意图，必须回仓库翻文档；代码里没有任何一行说明「为什么」。
2. **编号是易变的间接层**：`docs/adr/` 里 0002 已被 0013 取代并删除；编号会随决策演进失效或指向变化，而注释里的编号不会有人同步。

用户定调：注释应该自我完备——**在注释里写清楚为什么这么做，而不是让读者再去查文档**。

## 规则

「引用外部文档」指注释中出现以下任一形态，均需改写：

- `ADR-00xx` / `ADR0xxx` 编号；
- `docs/` 开头的仓库内文档路径（含 `docs/adr/`、`docs/工具定义.md`、`docs/数据库与目录结构设计.md`、`docs/deploy.md`、`docs/pi-web-研究/`、`docs/THIRD-PARTY-NOTICES.md`）；
- 指向 PRD / 任务文件的路径（如 `PRD docs/tasks/preproduction-readiness.md §3.6` 出现在 Dockerfile，本轮不在 scope，见「范围」）。

## 范围

### 本次处理

| 范围 | ADR 处数 | 私有 docs 指针 | 含改动的文件数 |
| --- | --- | --- | --- |
| `server/src/`（**除 `verify/`**） | 57 | 9 | 27（23 含 ADR + 9 含 docs 指针，5 个文件两类都有） |
| `web/src/` | 10 | 4 | 10（两类互不重叠） |
| 合计 | **67** | **13** | **37** |

（可选：`server/src/verify/`、`skills/`、Docker / compose 另计。）

### 本次明确不处理

- `server/src/verify/`（37 处 ADR 引用）：用户定稿本轮只清生产代码。注意其中部分是**测试断言输出标签**（`check("…（ADR-0035）…", …)`）与 `console.log` 小节标题，不是注释；且 verify 脚本同样随 `main` 分发，悬空问题仍在——留作后续。
- `skills/`（6 处，`.env.example` 与 `tavily-search/scripts/tavily-search` 注释）与 `Dockerfile` / `compose.yaml` / `docker-compose.yaml`（6 处）：不在本轮。
- 根 `AGENTS.md`、`doc-for-dev/README.md`、`docs/` 内部文档对 ADR 的引用：文档引用 ADR 是正当的（文档层就是权威来源），不属本规则。
- 不加回归检查、不写 ADR、不改任何代码行为（用户定稿）。

## 改写原则

1. **编号后已有括注的，删编号、留括注**。多数引用是 `（…说明…，ADR-00xx）` 形态，说明本身已经把「为什么」写清楚了，直接去掉 `，ADR-00xx`。
   - `// POST /api/glossary —— 用户手动添加：直接 normal（手动录入即确认，见 ADR-0005）`
     → `// POST /api/glossary —— 用户手动添加：直接 normal（手动录入即用户确认）`
   - `/** 归一化去重（ADR-0017）：精确匹配归代码，语义判断归模型。 */`
     → `/** 归一化去重（精确匹配归代码，语义判断归模型）。 */`
2. **编号是唯一信息的，补写结论与理由**。整句只给编号的，把该决策「是什么 + 为什么」写进注释。
   - `// 会话注册表（模块级 Map，ADR-0024 简化决定，不用 globalThis）`
     → `// 会话注册表（模块级 Map：单进程宿主内共享即可，无需 globalThis）`
   - `// 相对路径基于当前 Pi Session 的 workPath 解析。按 ADR-0030 不实现应用级文件沙箱；容器与远程执行 skill 负责系统边界，HTTP 附件接口单独限制路径。`
     → `// 相对路径基于当前 Pi Session 的 workPath 解析。不实现应用级文件沙箱：沙箱是部署层职责，系统边界由容器与远程执行 skill 负责，HTTP 附件接口单独限制路径。`
3. **交叉引用改指代码内符号，不指文档**。需要指向别处实现时，指向同仓库的代码文件 / 函数，而不是设计文档。
   - `设计约束（docs/工具定义.md）：` → 把该节实际约束逐条写在注释里（这些约束下面本来就有列表），删掉对文档的指路。
   - `原始版权与许可见本仓库 docs/THIRD-PARTY-NOTICES.md` → 见下「特殊情形」。

判定标准：**改完后，，不依赖文档，注释仍然完整表达意图**。

## 逐文件清单

### A. `server/src/`（除 `verify/`）——ADR 引用 57 处

| 文件 | 处数 | 依据编号（改为内联表述） |
| --- | --- | --- |
| `bridge/agent-session-wrapper.ts` | 6 | 0024（注册表简化）、0029（祖先遍历注入）、0031（运行期切换）、0035（助教常驻）、0036（引导块无条件附带） |
| `config/app-settings.ts` | 2 | 0036、0039 |
| `config/user-env.ts` | 1 | 0034 |
| `db/schema.ts` | 4 | 0030、0034、0036、0039 |
| `db/seed.ts` | 2 | 0029、0035 |
| `fsrs/service.ts` | 1 | 0018（复习是批量对话） |
| `index.ts` | 2 | 0034、0038 |
| `projection/maintenance-reminder.ts` | 2 | 0035、0036、0039 |
| `projection/system-prompt-builder.ts` | 2 | 0033、0036 |
| `prompts/defaults.ts` | 5 | 0029、0033、0035、0036、0039 |
| `routes/auth.ts` | 1 | 0022（单用户模型） |
| `routes/cards.ts` | 1 | 0009（手动新建即确认） |
| `routes/config.ts` | 2 | 0034、0036 |
| `routes/conversations.ts` | 6 | 0031、0035、0036、0037、0038、0039 |
| `routes/glossary.ts` | 1 | 0005 |
| `routes/workspaces.ts` | 1 | 0037 |
| `session/attachments.ts` | 6 | 0015、0038 |
| `session/repository.ts` | 5 | 0035、0037、0038、0039 |
| `tools/cards.ts` | 2 | 0005、0017 |
| `tools/factory.ts` | 2 | 0024、0026 |
| `tools/files.ts` | 1 | 0030 |
| `tools/glossary.ts` | 1 | 0005 |
| `tools/review.ts` | 1 | 0026 |

### B. `web/src/`——ADR 引用 10 处

| 文件 | 处数 | 依据编号 |
| --- | --- | --- |
| `api/client.ts` | 2 | 0035、0037 |
| `api/types.ts` | 2 | 0034、0036、0039 |
| `aside/AssistantPanel.tsx` | 1 | 0035 |
| `chat/ChatInput.tsx` | 2 | 0038 |
| `settings/AdvancedTab.tsx` | 2 | 0036、0039 |
| `settings/UserEnvSection.tsx` | 1 | 0034 |

### C. 私有 `docs/` 指针 13 处（与 A / B 同文件，重叠）

| 文件 | 行 | 现状指针 |
| --- | --- | --- |
| `bridge/agent-event-stream.ts` | 3 | `见本仓库 docs/THIRD-PARTY-NOTICES.md` |
| `bridge/agent-event-wire.ts` | 3 | 同上 |
| `bridge/pi-types.ts` | 3 | 同上 |
| `bridge/streaming-message.ts` | 3 | 同上 |
| `bridge/agent-session-wrapper.ts` | 494 | `（docs/deploy.md）` |
| `db/schema.ts` | 5 | `schema 以 docs/数据库与目录结构设计.md 为准` |
| `db/seed.ts` | 23 | `（docs/数据库与目录结构设计.md「目录布局」）` |
| `session/attachments.ts` | 13 | `见 docs/pi-web-研究/04-API与基础设施.md §2.4` |
| `tools/cards.ts` | 8 | `设计约束（docs/工具定义.md）` |
| `web/src/chat/stream-reducer.ts` | 2 | `见 docs/THIRD-PARTY-NOTICES.md` |
| `web/src/lib/chat-lazy-load.ts` | 2 | `原始版权与许可见本仓库 docs/THIRD-PARTY-NOTICES.md` |
| `web/src/lib/file-fuzzy.ts` | 2 | 同上 |
| `web/src/lib/markdown.ts` | 2 | 同上 |

改法：前四行与后四行是许可证指路，见「特殊情形」；`deploy.md` 与目录设计类的指针把「为什么」内联（如 `agent-session-wrapper.ts:494` 本就是运维判据，直接把判据写清）；`attachments.ts:13`、`tools/cards.ts:8` 改为内联要点。

## 特殊情形：pi-web 移植文件的许可头

8 处（`bridge/` 4 个 + `web/src/lib/` 3 个 + `web/src/chat/stream-reducer.ts`）注释是 MIT 归属声明，不能简单删指针——归属信息本身有法律意义。建议改法：

- **保留内联归属事实**：来源项目 + 版本 + 许可证 + 版权人 + 上游 URL，均写在文件头（MIT 只要求「版权声明 + 许可声明」随副本分发，这与完整许可全文存于文档不冲突）。
- **删掉「见本仓库 docs/THIRD-PARTY-NOTICES.md」的指路**（该文件在 `main` 上不存在，指针悬空）。
- 现有首行 `// 移植自 pi-web v0.9.0（MIT License，https://github.com/agegr/pi-web）` 基本满足，补齐版权人（`Copyright (c) 2026 agegr`）即为完整声明；第二行的文档指针删除。
- **注意版本不一致**：`session/attachments.ts:12` 写 `pi-web v0.8.11`，其余 13 处写 `v0.9.0`。改写时按文件实际来源核实，不要一律改成 0.9.0。

**此子项需用户确认**：是否接受「许可头内联、不再指向 `docs/THIRD-PARTY-NOTICES.md`」。若用户希望保留文档指针，则至少改成 `main` 上也存在的路径（需要把声明文件移出 `docs/`，属另一件事）。

**相邻发现（本次不处理，仅记录）**：`main` 分支排除了 `docs/`，因此开源仓库当前**没有随代码分发的 pi-web MIT 归属声明**，而这些 pi-web 衍生文件随 `main` 发布。这是既有的许可合规缺口，与本轮注释改动同源但独立，建议单独立项处理。

## 验收标准

1. 生产代码（`server/src/` 除 `verify/` 与 `web/src/`）中 `ADR-0[0-9][0-9][0-9]` 与 `ADR0[0-9][0-9][0-9]` 匹配数为 **0**：
   `grep -rn "ADR-0[0-9][0-9][0-9]\|ADR0[0-9][0-9][0-9]" server/src --exclude-dir=verify web/src`
2. 同范围内注释中的 `docs/` 指针匹配数为 **0**：
   `grep -rn "docs/" server/src --exclude-dir=verify web/src`
3. 逐处审查：每条被改写处读起来自足——删除 `docs/` 后注释仍表达「做什么 + 为什么」，没有残留诸如「见上文文档」「按上述决策」的悬空指代。
4. 改动**零运行影响**：`cd server && npm run typecheck` 通过；`cd web && npm run build` 通过；`git diff` 只含注释行（除许可证头外无语句改动）。
5. 不触碰 `docs/`、`AGENTS.md`、`verify/`、`skills/`、Docker / compose。
6. 中文无替换字符乱码：`grep -rn $'\xef\xbf\xbd' server/src web/src`。

## 实现顺序

1. 先做 8 处许可证头（形态统一、需用户先确认子项），一次定清范式。
2. 再按文件过 A 组 57 处（`server/src` 除 verify），每处按「改写原则」1 / 2 处理。
3. 再 B 组 10 处（`web/src`）。
4. 再 C 组剩余 5 处非许可证指针（`agent-session-wrapper.ts:494`、`schema.ts:5`、`seed.ts:23`、`attachments.ts:13`、`tools/cards.ts:8`）。
5. 收尾跑验收 1 / 2 / 4 / 6；typecheck + 前端 build。

## 风险与注意

| 风险 | 对策 |
| --- | --- |
| 改写时把「为什么」也删掉，注释退化成「做什么」 | 原则 2 强制补理由；验收 3 逐处审查 |
| 许可证头改错，削弱 pi-web 归属 | 先与用户确认子项；保留版权人 + 许可证名 + 上游 URL，不发明来源 |
| 把 `pi-web v0.8.11` 误统一成 `v0.9.0` | 按文件实际来源核实后再改 |
| 顺手动到非注释内容 | 验收 4 检查 `git diff` 仅注释行；typecheck + build 兜底 |
| 遗漏 `ADR0xxx` 无短横线写法 | 验收 1 的正则同时匹配两种写法 |

## 不做

- 不改任何运行逻辑、schema、接口；
- 不动 `verify/`（37 处 ADR 引用，含测试输出标签）——留后续任务；
- 不动 `skills/` 与 Docker / compose 的 12 处；
- 不加防回归 grep / 不进 `AGENTS.md` 编码约束 / 不写 ADR（用户定稿）；
- 不修 `main` 分支的许可声明缺口（另立任务）。
