---
name: tavily-search
description: 使用tavily进行搜索，Tavily搜索的特点为：返回内容较完整、结果较杂乱(信源混合官方页面、博客、论坛和二手文章)。 适合搜索新闻、一般事实、初步资料收集。当环境中有其他搜索工具时，应结合搜索工具的特点使用及用户要求。当需要网络搜索时，可考虑调用此SKiLL
---

# Tavily Search

使用 `./scripts/tavily-search` 调用 Tavily Search API。

> 上述相对路径以本 skill 目录为基准（`~/pi-teacher/skills/` 挂载于 `~/.pi/agent/skills/`），
> 换成解析后的绝对路径执行。

## 密钥配置

`TAVILY_API_KEY` / `TAVILY_BASE_URL` / `TAVILY_TIMEOUT` 由 Pi Teacher 后端作为环境变量注入到命令进程，
不要去找任何配置文件。
命令因缺少 key 报错时，直接告诉用户：到「系统设置 → 高级配置 → 用户环境变量」填写 `TAVILY_API_KEY`，保存后立即生效，无需重开对话；不要自行尝试其他路径或猜测密钥。

默认输出 Markdown，适合快速获取搜索结果、答案摘要和可引用来源。

## CLI 怎么用

| 需求 | 命令 | 说明 |
|---|---|---|
| 查看帮助 | `./scripts/tavily-search --help` | 查看顶层命令与 search 子命令 |
| 普通联网搜索 | `./scripts/tavily-search search "query"` | 默认 Markdown 输出 |
| 控制结果数量 | `./scripts/tavily-search search "query" --max-results 5` | 默认 `5` |
| 搜索并返回简短答案 | `./scripts/tavily-search search "query" --include-answer basic` | 需要 Tavily 同时生成 answer 时用 |
| 搜索并返回更完整答案 | `./scripts/tavily-search search "query" --include-answer advanced` | 需要更完整 answer 时用 |
| 搜新闻 | `./scripts/tavily-search search "query" --topic news` | 新闻、近期事件、舆情时用 |
| 限定最近时间 | `./scripts/tavily-search search "query" --time-range week` | 支持 `day`、`week`、`month`、`year` |
| 获取网页原文 | `./scripts/tavily-search search "query" --include-raw-content markdown` | 需要摘录、核验、总结页面正文时用；内容可能很长 |

## 基础高频参数

| 参数 | 示例 | 何时使用 | 注意事项 |
|---|---|---|---|
| `--max-results <n>` | `--max-results 5` | 控制返回数量 | 默认 `5` |
| `--include-answer <mode>` | `--include-answer basic` | 需要 Tavily 直接给答案 | 常用 `basic` 或 `advanced` |
| `--topic news` | `--topic news` | 新闻、近期事件、舆情 | 普通网页搜索不用加 |
| `--time-range <range>` | `--time-range week` | 最近一天/周/月/年 | 取值：`day`、`week`、`month`、`year` |
| `--include-raw-content markdown` | `--include-raw-content markdown` | 需要网页正文 | 普通搜索不要默认开启 |
| `--format markdown` | `--format markdown` | 默认输出，适合直接阅读 | 通常不用显式写 |
| `--json` / `--format json` | `--json` | 需要上游原始 JSON 给脚本处理 | 机器处理时用 |
| `--pretty` / `--format pretty-json` | `--pretty` | 需要人工查看完整 JSON 结构 | 调试时用 |


## 渐进式读取 references

先不要一次性读取所有 references。只有遇到对应需求时，再读对应文件。

| 用户需求 | 读取文件 | 包含内容 |
|---|---|---|
| 控制搜索深度、时间范围、日期、新闻/金融 topic、国家、自动参数、精确匹配 | `references/advanced-search.md` | `--search-depth`、`--topic`、`--time-range`、`--start-date`、`--end-date`、`--country`、`--auto-parameters`、`--exact-match` |
| 限定/排除站点、获取 raw content、图片、favicon、每来源 chunks | `references/content-and-filters.md` | `--include-domain`、`--exclude-domain`、`--include-raw-content`、`--include-images`、`--include-image-descriptions`、`--include-favicon`、`--chunks-per-source` |
| 输出 JSON、timeout、base URL、完整 help | `references/advanced-cli.md` | `--format`、`--timeout`、`TAVILY_BASE_URL`、help 命令 |

如果用户只是普通联网搜索、新闻搜索或需要简短答案，不需要读取 references，直接使用上面的高频命令。
