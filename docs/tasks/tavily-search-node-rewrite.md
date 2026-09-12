# tavily-search 由 Go 重写为 Node 单文件

> 状态：已完成（2026-09-12）。决策见 ADR-0041，取代 ADR-0040「tavily-search 保持 Go 二进制不动」一句。

把最后一个 Go 实现的内置 skill 换成零依赖 Node 单文件，`skills/` 四个 skill 的实现范式归一，仓库不再包含任何 Go 代码与编译产物。

## 为什么现在做

ADR-0040 当时的判断是「已在线上跑通，重写没有新增收益」。逐行读 `sourcecode/main.go`（507 行）后发现并非如此——它带着三个真实缺陷，且都只能靠改源码修：

| 问题 | 位置 | 后果 |
| --- | --- | --- |
| 缺 key 文案与 ADR-0034 相悖 | `loadConfig()` 第 271 行 | 报错让用户「把 `.env.example` 复制成 `.env`」。但 `.env` 被 `.gitignore` 与 `.dockerignore` 双重排除、容器里根本不存在，用户照做无效；正确指引是「系统设置 → 高级配置 → 用户环境变量」。`pullpage` / `exa-search` 已统一成后者，只剩它还在教错路 |
| 硬编码了原作者的机器路径 | `detectSkillDir()` 第 294 / 298 行 | 两处 fallback 写死 `/workspace/mcp2skill/tavily-search`，是移植前环境的残留 |
| `--env-file` 是死代码 | `addCommonFlags()` 第 180 行 | `SKILL.md` 与 `references/advanced-cli.md` 都明令「不要传 `--env-file`」，但二进制仍然接受它，构成一条与文档矛盾的可用路径 |

另有两个结构性代价：

- **二进制只能跑 x86-64**。`scripts/tavily-search` 是 8.1M 的静态 ELF（`ELF 64-bit LSB executable, x86-64`），在 arm64 机器（Apple Silicon、云上 ARM 实例）上直接不可执行，而 Node 脚本天生跨架构。镜像 `/app/skills` 共 13M，其中 8.1M 是它一个。
- **改一行要装 Go 工具链**。其余三个 skill 改行为就是改脚本本身，只有它需要「装 Go → 重编译 → 提交 8M 产物」，这条独立的维护路径为一个 507 行的 HTTP 客户端存在，不划算。

重写后仓库内 `*.go` 归零（现存唯一一个就是它），`sourcecode/` 与 `go.mod` 一并删除。

## 改动范围

| 文件 | 动作 |
| --- | --- |
| `skills/tavily-search/scripts/tavily-search` | 8.1M ELF → 零依赖 Node 脚本（预计约 300 行，755 权限） |
| `skills/tavily-search/sourcecode/` | 整个删除（`main.go` + `go.mod`；脚本本身即源码） |
| `skills/tavily-search/SKILL.md` | 删 `allowed-tools`（Pi v0.84.2 不解析，见 ADR-0040）；其余正文已符合现行约定，不动 |
| `skills/tavily-search/.env.example` | 删掉「优先级：环境变量 > `--env-file` 指定的文件」一句，与 `pullpage` / `exa-search` 的模板对齐 |
| `skills/tavily-search/references/advanced-cli.md` | `TAVILY_TIMEOUT` 的「Go duration 写法」改为「如 `60s`」——语法保持兼容，但项目里不该再出现 Go 字样 |
| `server/src/config/user-env.ts` | 同上，`TAVILY_TIMEOUT` 的 description 与 `EXA_TIMEOUT`（「Exa 请求超时，如 60s」）对齐 |
| `docs/adr/0041-*.md` | 新建；ADR-0040 顶部加状态行标注那一句被取代 |

不动的：`references/advanced-search.md`、`references/content-and-filters.md`（纯 API 参数说明，与实现语言无关）；`verify:remote` 现有断言 `/search <query>/i`（新脚本的 help 同样满足，无需改探针）。

## 行为契约

**验收基准是与现有二进制逐字节等价**，不是「功能差不多」。已在线上使用，任何输出差异都会影响模型的既有用法。

- **子命令**：仅 `search`；`--help` / `-h` / `help` / 无参数打印帮助并退出 0；未知子命令打印帮助到 stderr 并退出 1。
- **参数**：`--search-depth`（默认 `basic`）、`--chunks-per-source`（>0 才进 body）、`--max-results`（默认 `5`）、`--topic`（默认 `general`）、`--time-range`、`--start-date`、`--end-date`、`--include-answer`（默认 `"false"`）、`--include-raw-content`（默认 `"false"`）、`--include-images`、`--include-image-descriptions`、`--include-favicon`、`--include-domain`（可重复）、`--exclude-domain`（可重复）、`--country`、`--auto-parameters`、`--exact-match`，加公共的 `--format` / `--json` / `--pretty` / `--timeout`。
- **请求体构造**：字段名与「何时省略」必须一致。特别是 `include_answer` / `include_raw_content` 的三态——`"true"` / `"false"` 转成布尔，其他非空字符串（`basic` / `advanced` / `markdown` / `text`）原样作为字符串传（Go 版 `parseBoolish` 的语义）；空串则整个字段不出现。
- **Markdown 渲染**：标题 `# Tavily Search Results`、`Query: <q>`、可选 `## Answer` 段、`## Results`、每条 `### N. <title>`（缺标题填 `Untitled`）、`- URL:` / `- Score:` / `- Favicon:` 仅在非空时输出、正文段、`raw_content` 包在 `<details><summary>Raw content</summary>` 里。空结果输出 `No results found.`。
- **配置**：`TAVILY_API_KEY` / `TAVILY_BASE_URL`（默认 `https://api.tavily.com`，去尾部 `/`）/ `TAVILY_TIMEOUT`（默认 `60s`），`--timeout` 优先于 `TAVILY_TIMEOUT`。取值走 `getSetting()`：环境变量非空优先、skill 目录 `.env` 兜底。
- **鉴权**：`Authorization: Bearer <key>` header（注意与 `exa-search` 的 `x-api-key` 不同，别抄错）。
- **错误**：HTTP 非 2xx 抛 `Tavily API request failed with status <status>: <body>`；缺 key 抛 `缺少 TAVILY_API_KEY；请在系统设置 → 高级配置 → 用户环境变量中填入`（这一条是**故意改掉**的，见上表）。

**唯一有意的行为变更**就是缺 key 文案和随之移除的 `--env-file`。其余一切保持原样。

## 可直接复用的既有实现

`exa-search` 与本 skill 结构近乎孪生（同为 `search` 子命令 + 三种输出格式 + 可重复 domain 参数），以下函数按原样搬：`parseDuration()`（Go duration 语法 `ns|us|µs|ms|s|m|h`）、`readEnvFile()`、`getSetting()`、`normalizedFormat()`、`writeOutput()`、`stringify()` / `firstString()` / `firstArray()` / `writeField()`。

> 跨 skill 复制而不抽公共模块，是架构强制的：每个 skill 目录由 entrypoint 独立同步进 `~/.pi/agent/skills/`，必须自包含，没有共享 import 的位置。这是对「减少重复」的**有意例外**，在脚本头部注释里写明来源，改动时同步三处。

## 实现注意

- **模块格式统一 ESM**（`import`），与 `pullpage` 一致。无扩展名文件在 Node 24 靠语法探测识别 ESM，已由 `pullpage` 线上验证；`__dirname` 用 `fileURLToPath(import.meta.url)` 换算。
  - 附带项（可选，本 PRD 默认**不做**）：`exa-search` 目前是 CJS，是本轮之前留下的不一致。要不要一并翻成 ESM 由用户定，改动约三行。
- **参数在 query 前后都能出现**。Go 版靠手写 `splitFlagsAndQuery` 支持 `search --topic news "查询词"` 与 `search "查询词" --topic news` 两种写法。`parseArgs({ allowPositionals: true })` 天然支持，positionals 用空格 join 后 trim——与 `exa-search` 同款处理。
- **布尔参数不要用 `allowNegative` 声明 `no-xxx`**（`docs/spec.md` 已记此坑）。本 skill 的布尔项全是正向的（`--include-images` 等），默认 `false`，不涉及否定形式，保持简单即可。
- **不引入任何 npm 依赖**。全局 `fetch` + `AbortSignal.timeout` + `node:util.parseArgs` 足够。

## 验收清单

- [x] 新脚本落地（12638 字节 ESM），`sourcecode/` 与二进制删除，755 权限，仓库内 `*.go` / `go.mod` 归零
- [x] ~~差分验证~~ 按用户决定取消（「不用二进制对比，测试功能正常就行了」），改为 21 项功能直测，见下表
- [x] **真实调用**：真 key 实跑，markdown / answer / 各参数组合均正常
- [x] 缺 key 时报错指向设置页；`--timeout 1ms` 触发超时；`--env-file` 已不可用（Node 本体截获，见下）
- [x] 假 key 打到 Tavily 返回平台层 401（证明请求真实发出）
- [x] `npm run typecheck` 通过；`npm run http-smoke` 用 octopus / deepseek-normal-latest 重跑 **522 / 0 / 0**
- [x] 重建镜像 → 备份 117M → `up -d` → 容器内 `scripts/tavily-search --help` 正常、权限 755、缺 key 文案指向设置页
- [x] `verify:remote` **51 通过 / 0 失败**（四探针断言不改，全部由真模型在容器内跑通）
- [x] 镜像 `/app/skills` 由 13M 降到 **4.9M**
- [x] 文档：ADR-0041 新建、ADR-0040 加状态行与行内注、`TODO.md` 更新、三个坑追加 `docs/spec.md`、U+FFFD 检查

## 功能验证记录（2026-09-12，21 项全过）

| 分类 | 覆盖 |
| --- | --- |
| 帮助与错误路径 | `--help` / 无参数退出 0；缺 key 文案指向设置页；缺 query `missing query`；未知子命令打印帮助到 stderr 并退出 1；非法 `--timeout abc` 与 `--max-results abc` 报错文案与 Go 版一致（不静默变 NaN） |
| 网络层 | 假 key 打到 Tavily 真实 401（带上游 JSON 错误体）；`--timeout 1ms` 触发中断；`TAVILY_TIMEOUT=1ms` 生效且被 `--timeout 10s` 覆盖 |
| 真实搜索 | 默认 markdown 渲染（标题 / `- URL:` / `- Score:` / 正文段）；`--include-answer basic` 正确渲染 `## Answer`；参数在 query 之前也能解析 |
| 格式 | `--json` 单行原始透传（实测 1 行）；`--pretty` 缩进输出 |
| 参数 | 重复 `--include-domain` 真实限定结果（3 条全部命中 github.com）；`--exclude-domain`；`--include-raw-content markdown` 的 `<details><summary>Raw content</summary>` 折叠；`--include-favicon` 输出 `- Favicon:` |
| 配置来源 | `.env` 兜底可用；环境变量优先于 `.env` |

## 实现期踩到的三个坑

1. **自己写的 bug**：`readEnvFile()` 里调用 `fs.readFileSync` 但只 import 了具名 `readFileSync`，`fs` 未定义。因为该调用包在裸 `catch {}` 里，`ReferenceError` 被吞掉，症状是 `.env` 永远读不到且不报错。已修为 `readFileSync`。
2. **无扩展名 ESM 脚本被上层 `package.json` 判成 CJS**：`/tmp` 下测试时被一个无关的 `/tmp/package.json`（`"type": "commonjs"`）干扰，同一份字节在仓库目录正常、在 `/tmp` 静默退出 0 无任何输出。已确认容器 `/root/.pi/agent/skills/` 与宿主真实路径上无 `package.json`，现网不受影响。详见 `docs/spec.md`。
3. **Node 24 截获脚本参数里的 `--env-file`**：即使出现在脚本路径之后也被 Node 本体吃掉（文件不存在则 exit 9），三个 Node skill 一致。所以 `--env-file` 比计划中删得更彻底，脚本无需显式拦截。

## 非目标

- 不改 `SKILL.md` 的用法表与 `description`，模型侧的调用方式零变化。
- 不动 `references/advanced-search.md` 与 `content-and-filters.md`。
- 不趁机加新参数。Tavily API 的新字段另开任务。
- 不清理 git 历史里那个 8.1M blob（`.git` 现 11M，重写历史的代价远大于收益；停止增长即可）。
