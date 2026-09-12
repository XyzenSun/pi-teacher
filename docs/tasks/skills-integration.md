# 内置 skill 接入：pullpage / exa-search / sbx

> 状态：已完成（2026-09-12）。决策见 ADR-0040。

把用户提供的三个外部 skill 接成随镜像分发的内置 skill，`skills/` 从 1 个扩到 4 个。tingwu 语音识别网关本轮不接（它是需要常驻的 REST 服务，不是 skill）。

## 目标

| skill | 能力 | 形态 | 需要的 key |
| --- | --- | --- | --- |
| `pullpage` | 单 URL 抓取，tavily → exa → firecrawl → jina 自动回退 | 零依赖 Node 单文件（由 Go 重写） | `TAVILY_API_KEY` / `EXA_API_KEY` / `FIRECRAWL_API_KEY` / `JINA_API_KEY` |
| `exa-search` | Exa 搜索与带引用的问答 | 零依赖 Node 单文件（由 Go 重写） | `EXA_API_KEY` |
| `sbx` | Daytona / E2B / CodeSandbox 云沙箱 | esbuild 单文件 bundle | `DAYTONA_API_KEY` / `E2B_API_KEY` / `CODESANDBOX_API_KEY` |

目录名取各自 `SKILL.md` frontmatter 的 `name`，与 Pi 的 skill 发现约定一致。

## 为什么这么做

- **Node 重写**：复用镜像自带的 Node 24（全局 `fetch` + `node:util.parseArgs`，零 npm 依赖），不必装 Go 工具链、不必在仓库里存 15.8M 编译产物；且 `pullpage` 上游只读 `.env` 不读环境变量，本来就必须改源码才能用（`.env` 被 `.gitignore` 与 `.dockerignore` 双重排除）。
- **sbx 打包**：`npm install` 要 445M、运行时 `npx` 首拉 286 秒且缓存不持久，只有 4.4M 的 bundle 可接受。实测细节见 ADR-0040。
- **提示词不动**：Pi 自动把各 `SKILL.md` 的 `name` / `description` 注入 `<available_skills>`，全局 AGENTS.md 不写「何时用哪个 skill」。

## 验收清单

- [x] `skills/pullpage/`：Node 脚本 + `references/`（四家 API 文档）+ `.env.example`；SKILL.md 补密钥配置节与渐进式读取索引，删掉「优先复用 fetch/WebFetch」的误导句
- [x] `skills/exa-search/`：Node 脚本 + `references/` 两份 + `.env.example`；SKILL.md 改密钥节、删 Pi 不识别的 `allowed-tools`
- [x] `skills/sbx/`：esbuild bundle + SKILL.md（CLI 探测段改为直接用 `scripts/sbx`、去掉 `--envfile` 路线）+ `sourcecode/README.md` 记录重建命令
- [x] `pullpage` 反代变量统一 `*_BASE_URL`，与 `tavily-search` 既有命名一致
- [x] `BUILTIN_USER_ENV` 新增 10 项，描述按服务而非按 skill 命名（`EXA_*` 被两个 skill 共用）
- [x] `verify:remote` skill 验收扩成四个探针命令；`http-smoke` 内置项断言覆盖新 key
- [x] 宿主机直测：缺 key 报错指向设置页、环境变量优先生效（假 key 打到平台 401）、`--provider all` 与布尔参数解析正确
- [x] 容器验收：重建镜像 → 备份 → `up -d` → `verify:remote` **51 通过 / 0 失败**（真模型在容器里跑通四个 skill 命令）
- [x] 删除 `外部资源/` 下三个原目录（tingwu 保留）；删前已 tar 归档到 `/tmp/pt-verify/外部资源-removed-20260912-004133.tgz`（9.1M，含真实 key 的 `.env` 一并在内，宿主机 `/tmp` 重启即清）

## 验证记录（2026-09-12）

| 项目 | 结果 |
| --- | --- |
| 后端 typecheck | 通过 |
| `http-smoke` | 522 通过 / 0 失败 / 0 跳过 |
| 宿主机直测 | pullpage 与 exa-search 的缺 key 文案、环境变量优先（假 key → 平台 401）、`--provider all`、可重复 flag、超时解析均符合预期 |
| 镜像重建 | `pi-teacher:local` 重建成功，四个 skill 随镜像 COPY |
| 容器升级 | 停止 → 备份 112M → `up -d`，8 秒内 healthy；entrypoint 同步四个内置 skill，用户自建 `my-own-skill` 未被触碰 |
| 容器内实跑 | 四个 `scripts/*` 均为 755 且可执行；`.env` 确认未进镜像 |
| `verify:remote` | 51 通过 / 0 失败 |

## 踩到的坑

- `parseArgs` 的 `allowNegative`：若直接声明名为 `no-cache` 的布尔项，`--no-cache` 会被解析成 `"no-cache": false`（与直觉相反）。必须声明正向名 `cache`，`--no-cache` 才会得到 `cache: false`。
- esbuild 打包 sbx 必须 `--format=esm` + `createRequire` banner：cjs 产物报 `ERR_INVALID_ARG_VALUE`，裸 esm 报「Dynamic require of "util"」。

## 后续

- `tavily-search` 暂留 Go 二进制（已线上跑通，重写无新增收益）；若要统一实现另开任务。
- tingwu 接入需先定网关部署方式（compose 加 service？Cookie 如何维护）。
