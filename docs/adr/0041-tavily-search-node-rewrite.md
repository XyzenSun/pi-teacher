# tavily-search 改用 Node 单文件，仓库不再有 Go

> 状态：现行。取代 ADR-0040「既有的 tavily-search 保持 Go 二进制不动」一句，其余结论不变。

最后一个 Go 实现的内置 skill 换成零依赖 Node 单文件。至此四个 skill 的实现范式归一：`tavily-search` / `pullpage` / `exa-search` 是手写零依赖脚本，`sbx` 是 esbuild bundle（它依赖三家云沙箱 SDK，无法手写），仓库内 `*.go` 归零。

## 为什么推翻 ADR-0040 的判断

ADR-0040 写的是「已在线上跑通，重写没有新增收益，真要统一另开任务」。这个判断建立在「它只是能用的旧实现」之上；逐行读 507 行 `main.go` 后发现不成立，它带着三个只能改源码才能修的缺陷：

| 问题 | 位置 | 后果 |
| --- | --- | --- |
| 缺 key 文案与 ADR-0034 相悖 | `loadConfig()` | 报错让用户「把 `.env.example` 复制成 `.env`」。但 `.env` 被 `.gitignore`（`skills/*/**/.env`）与 `.dockerignore`（`**/.env`）双重排除，容器里根本不存在该文件，用户照做无效。正确指引是「系统设置 → 高级配置 → 用户环境变量」，另两个 skill 已统一成后者 |
| 硬编码原作者机器路径 | `detectSkillDir()` 两处 fallback | 写死 `/workspace/mcp2skill/tavily-search`，移植前环境的残留 |
| `--env-file` 是死代码 | `addCommonFlags()` | `SKILL.md` 与 `references/advanced-cli.md` 都写「不要传 `--env-file`」，二进制却仍然接受，构成与文档矛盾的可用路径 |

加上两条结构性代价：

- **二进制绑定 x86-64**。`scripts/tavily-search` 是 8.1M 静态 ELF，arm64 机器（Apple Silicon、ARM 云实例）上不可执行；Node 脚本跨架构。
- **独立的维护路径**。其余三个 skill 改行为就是改脚本，只有它要「装 Go → 重编译 → 提交 8M 产物」，为一个 HTTP 客户端维持整条工具链不划算。

既然「一定要改源码才能修上述缺陷」，那就没有理由停在 Go 上。

## 行为契约：只有两处有意变更

重写以「与旧二进制等价」为基准（它已在线上使用，输出变化会影响模型既有用法）。请求体字段名与省略条件、Markdown 渲染结构（`### N. 标题`、`- URL:` / `- Score:` / `- Favicon:` 仅非空时输出、`raw_content` 包 `<details>`）、`include_answer` / `include_raw_content` 的三态（`"true"` / `"false"` 转布尔，`basic` / `advanced` / `markdown` / `text` 原样传字符串，空串则字段不出现）全部照搬。鉴权仍是 `Authorization: Bearer`（与 `exa-search` 的 `x-api-key` 不同）。

有意变更两处：缺 key 报错改为指向设置页；`--env-file` 移除。

## 跨 skill 复制是架构强制的

`parseDuration()` / `readEnvFile()` / `getSetting()` / `writeOutput()` / `stringify()` 等与 `exa-search` 同源，按原样复制而非抽公共模块。原因不是图省事：每个 skill 目录由 `docker-entrypoint.sh` 独立同步进 `~/.pi/agent/skills/`，必须自包含，跨 skill 没有共享 import 的位置。这是对 CLAUDE.md「减少重复、优先复用」的**有意例外**，已在脚本头部注释写明来源与「改动时同步两处」。

## 附带修正

`BUILTIN_USER_ENV` 里 `TAVILY_TIMEOUT` 的描述去掉「Go duration 写法」字样（语法保持兼容，`60s` / `1m30s` 都能解析），与 `EXA_TIMEOUT` 对齐；`references/advanced-cli.md` 同步。`SKILL.md` 删掉 Pi v0.84.2 不解析的 `allowed-tools`（ADR-0040 已确认该字段被忽略）。

## Consequences

- 镜像 `/app/skills` 由 13M 降到约 5M；仓库不再新增二进制（git 历史里那个 8.1M blob 不做清理，重写历史代价大于收益，停止增长即可）。
- 新增或修改 skill 的路径统一：改脚本文件本身，不涉及任何编译步骤。
- `verify:remote` 的四探针断言不变（新脚本 `--help` 同样输出 `search <query>`）。
- 升级已有部署：重建镜像即可，entrypoint 覆盖同步。

## Considered Options

### 保持 Go，只改源码修那三个缺陷

否决。修完仍要装 Go 工具链重编译、仍要提交 8M 产物、仍然绑定 x86-64，三条结构性代价一条不少，而修改量与重写相当（507 行里真正的业务逻辑就是构造请求体与渲染 Markdown）。

### 顺手把 exa-search 从 CJS 翻成 ESM

本轮不做。它是上一轮留下的不一致（`pullpage` 与新 `tavily-search` 是 ESM，`exa-search` 是 CJS），改动约三行但需要重新验证一遍，与本轮目标无关，留给用户决定。

### 抽一个 skill 间共享的公共模块

否决，见上文：skill 目录必须自包含，无共享位置。
