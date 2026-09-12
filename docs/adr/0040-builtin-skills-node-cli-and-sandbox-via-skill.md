# 内置 skill 扩到四个：pullpage 与 exa-search 用 Node 单文件，sbx 用 esbuild bundle

> 状态：现行。取代 ADR-0015「沙箱的接入形态是插件」与 ADR-0027「沙箱走插件」两句结论。
> 其中「既有的 tavily-search 保持 Go 二进制不动」一句已被 ADR-0041 取代——该 skill 已重写为零依赖 Node 单文件。
> 状态：「既有的 tavily-search 保持 Go 二进制不动」被 ADR-0041 取代——已重写为零依赖 Node 单文件。
> 状态：「既有的 tavily-search 保持 Go 二进制不动」被 ADR-0041 取代——已重写为零依赖 Node 单文件。
> 状态：「既有的 tavily-search 保持 Go 二进制不动」被 ADR-0041 取代——已重写为零依赖 Node 单文件。

接入 `pullpage`（单 URL 抓取，聚合 tavily / exa / firecrawl / jina）、`exa-search`（Exa 搜索与问答）、`sbx`（Daytona / E2B / CodeSandbox 云沙箱）三个 skill，仓库 `skills/` 从 1 个变成 4 个。三者都随镜像走，由 `docker-entrypoint.sh` 每次启动覆盖同步进 `~/.pi/agent/skills`（ADR-0029 不变）。

## skill 的说明不写进 AGENTS.md

Pi 遍历 `~/.pi/agent/skills/` 下每个 `SKILL.md`，把 frontmatter 的 `name` / `description` 注入系统提示词的 `<available_skills>`，模型据此自行决定何时调用。所以「什么时候用哪个 skill」属于各自 `SKILL.md` 的 `description`，**不在全局 AGENTS.md 里重复**——写了既是冗余，也会在 skill 增删时变成过期文案。出厂 `GLOBAL_AGENTS_MD` 至今没提过 `tavily-search`，这次同样不加。

核实于 v0.84.2 `dist/core/skills.js`：只解析 `name`（`^[a-z0-9-]+$`，≤64）、`description`（必填，≤1024）、`disable-model-invocation`；`allowed-tools` 不被识别（素材里带的那行已删）。

## pullpage 与 exa-search 用零依赖 Node 单文件，不用 Go 二进制

两个 skill 的上游实现都是 Go：`pullpage` 834 行、`exa-search` 561 行，各自附一个 7.7–8.1M 的静态二进制。改用 Node 重写，理由：

- **复用镜像已有的运行时**。`node:24-slim` 自带全局 `fetch` 与 `node:util.parseArgs`，两个 CLI 的全部能力（HTTP、超时、参数解析、JSON 渲染）都不需要第三方包，`npm install` 一个字都不用加。
- **改行为就是改脚本**。Go 版要在仓库里同时维护源码与编译产物，改一行得装 Go 工具链重编译再提交 8M 二进制；Node 版脚本本身就是源码，`sourcecode/` 目录也不必存在。
- **仓库体积**。两个 Go 二进制合计 15.8M，换成两个脚本合计约 25KB。

代价是启动多了 Node 进程的几十毫秒，对「模型偶尔抓一个网页」的调用频率无意义。

既有的 `tavily-search` 保持 Go 二进制不动：它已在线上跑通，重写没有新增收益，真要统一另开任务。（此判断被 ADR-0041 推翻：逐行核对发现其缺 key 文案与 ADR-0034 相悖、`detectSkillDir` 硬编码原作者路径、`--env-file` 是与文档矛盾的死代码，且二进制绑定 x86-64。）

### 密钥一律走环境变量

`exa-search` 的上游已是「环境变量优先、`.env` 兜底」；`pullpage` 的上游 `loadEnv()` **只读 skill 根目录的 `.env`、完全不看 `os.Getenv`**，与 ADR-0034 冲突——`.env` 同时被 `.gitignore`（`skills/*/**/.env`）和 `.dockerignore`（`**/.env`）排除，原样接入必然「缺少 *_API_KEY」。重写后两者统一为 `getSetting()` 语义：环境变量非空优先，`.env` 仅作本地直跑兜底；缺 key 的报错文案统一指向「系统设置 → 高级配置 → 用户环境变量」。

## sbx 用 esbuild 单文件 bundle 分发

`sbx` 是 npm 包 `@xyzensun/sbx`，依赖三家云沙箱 SDK，无法像前两个那样手写为零依赖脚本。三个方案实测：

| 方案 | 实测 | 结论 |
| --- | --- | --- |
| 镜像内 `npm install` | node_modules 445M（`@codesandbox/sdk` 传递引入 `@opentelemetry` 187M、`@sentry` 49M） | 否决：运行镜像本体才 701M |
| 运行时 `npx -y @xyzensun/sbx` | 容器内首拉 286 秒；npm 缓存 673M 落在非挂载的 `/root/.npm`，容器重建即丢 | 否决：模型一次调用等不起，且每次重建都重来 |
| esbuild 单文件 bundle | 4.4M，纯 JS 无原生模块，离线可用 | **采用** |

打包命令与踩坑记录在 `skills/sbx/sourcecode/README.md`：必须 `--format=esm` 配 `createRequire` banner（cjs 产物会因依赖里的 `createRequire(import.meta.url)` 报 `ERR_INVALID_ARG_VALUE`，裸 esm 则死在「Dynamic require of "util"」）。

验证方式是给三家平台各喂一个假 key：都返回平台层 `PLATFORM_ERROR` 鉴权失败而非模块加载错误，证明 SDK 真实发出了请求、打包没破坏功能。

这与 `tavily-search` 提交 Go 静态二进制是同一范式：**产物随镜像走，源码或重建方法留在 `sourcecode/`**。

## 沙箱改走 skill，不再走插件

ADR-0015 定「沙箱的接入形态是插件」，ADR-0027 沿用。现在改为 skill：

- 插件方案要把沙箱 API 逐个包成 `defineTool`，而 `sbx` 已经是一套稳定 CLI，包一层只是把 CLI 参数翻译成工具参数，不产生新能力。
- 沙箱的难点在「什么时候该创建、必须显式 `--ttl`、用完必须 `destroy`、三家平台的限制差异」——这些是**方法论**，正是 skill 的本职（ADR-0027 对 skill 的定义：教模型一套做事方法）。
- 切换或新增沙箱平台由上游 CLI 负责，Pi Teacher 只需重新打包，不改后端代码。

ADR-0027 的大结论（能力扩展只有 skill 和插件两个载体、不用 MCP）不变，变的只是沙箱落在哪一个载体上。

## 共用变量按服务命名，不按 skill 命名

`EXA_API_KEY` / `EXA_BASE_URL` 同时被 `exa-search`（搜索）与 `pullpage`（抓取回退链）使用，`TAVILY_API_KEY` 同时被 `tavily-search` 与 `pullpage` 使用。因此 `BUILTIN_USER_ENV` 的 description 按**服务**写（「Exa 搜索 / 抓取 API Key」），不写「pullpage 的 Exa API Key」——后者在第二个消费方出现时就是错的。

同理，`pullpage` 上游的反代变量名 `*_BASEURL` 统一改成 `*_BASE_URL`，与 `tavily-search` 既有的 `TAVILY_BASE_URL` 同名共用；否则界面上会并排出现 `TAVILY_BASE_URL` 与 `TAVILY_BASEURL` 两个含义相同的变量。

本次 `BUILTIN_USER_ENV` 新增 10 项：`EXA_API_KEY` / `EXA_BASE_URL` / `EXA_TIMEOUT`、`FIRECRAWL_API_KEY` / `FIRECRAWL_BASE_URL`、`JINA_API_KEY` / `JINA_BASE_URL`、`DAYTONA_API_KEY` / `E2B_API_KEY` / `CODESANDBOX_API_KEY`。只有沙箱三项保留 `sbx` 字样——它们确实只有 sbx 消费。

## Consequences

- 仓库 `skills/` 有四个目录：`tavily-search`（Go 二进制）、`pullpage`（Node 脚本）、`exa-search`（Node 脚本）、`sbx`（esbuild bundle）。目录名即各自 `SKILL.md` 的 `name`。
- 新增 skill 仍然只需往 `skills/` 加目录 + 重建镜像，后端零改动；若它需要新的 key，才动 `BUILTIN_USER_ENV`。
- `verify:remote` 的 skill 验收从「只跑 tavily」扩成一轮 prompt 打包四个探针命令，按各自输出特征串断言。
- 升级已有部署：重建镜像即可，四个 skill 自动同步；用户原本放在各 skill 目录 `.env` 里的 key 需改到界面（`.env` 不进镜像）。
- `docs/THIRD-PARTY-NOTICES.md` 增加 sbx bundle 内嵌依赖的声明。

## Considered Options

### pullpage / exa-search 原样搬 Go 二进制

否决。见上文：改一行要 Go 工具链 + 重新提交 8M 产物，且 `pullpage` 必须改源码才能读环境变量（不改就完全不可用）——既然一定要改，不如落到不需要编译的实现上。

### 给 skill 目录单独装 node_modules

否决。`~/.pi/agent/skills/` 是挂载目录，装依赖等于把 node_modules 写进用户数据目录，备份体积与升级冲突都不可接受；而且两个 CLI 本来就不需要任何依赖。

### 把 sbx 也手写成零依赖脚本

否决。三家沙箱 SDK 的协议细节（session 模式、preview URL 签名、模板构建缓存）不是几百行能重写的，且上游仓库在持续维护，自己实现等于分叉。

### tingwu 语音识别一并接入

本轮不做。它不是 skill 而是需要常驻的本地 REST 网关（端口 8787、靠手动维护登录 Cookie），得先决定怎么部署（compose 加 service？Cookie 怎么续）再写调用它的 skill，与本轮三个「放进目录就能用」的 skill 不是一个量级。
