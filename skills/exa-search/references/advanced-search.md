# Exa Search 进阶参数

当用户需要更精确控制搜索范围、搜索类型或时间过滤时，读取本文件。

## 参数表

| 参数 | 示例 | 何时使用 | 注意事项 |
|---|---|---|---|
| `--type <type>` | `--type neural` | 控制搜索类型 | 常见值：`auto`、`neural`、`keyword`、`fast` |
| `--category <category>` | `--category company` | 用户明确要求某一类结果 | 具体取值按 Exa API 当前支持范围透传 |
| `--include-domain <domain>` | `--include-domain docs.example.com` | 只查指定站点、官方文档、可信来源 | 可重复使用 |
| `--exclude-domain <domain>` | `--exclude-domain example.com` | 排除噪音站点、不可信站点、用户明确排除的来源 | 可重复使用 |
| `--start-published-date <date>` | `--start-published-date 2025-01-01` | 只要某日期之后发布的内容 | 适合新闻、版本发布、博客、文档更新 |
| `--end-published-date <date>` | `--end-published-date 2026-08-03` | 只要某日期之前发布的内容 | 可与 start 搭配限定时间段 |
| `--start-crawl-date <date>` | `--start-crawl-date 2025-01-01` | 按 Exa 抓取时间过滤 | 适合网页发布时间不准的场景 |
| `--end-crawl-date <date>` | `--end-crawl-date 2026-08-03` | 限定 Exa 抓取截止时间 | 可与 start crawl 搭配 |
| `--context` | `--context` | 需要 Exa 返回额外上下文 | 普通搜索不要默认开启 |

## `--type` 取值建议

| 取值 | 适合场景 |
|---|---|
| `neural` | 自然语言问题、概念性资料、语义搜索 |
| `keyword` | 精确术语、错误码、API 名称、日志片段 |
| `fast` | 更重视速度 |
| `auto` | 让 Exa 自动选择 |

## 组合示例

| 需求 | 命令 |
|---|---|
| 只查官方文档 | `scripts/exa-search search "query" --include-domain docs.example.com` |
| 排除某个站点 | `scripts/exa-search search "query" --exclude-domain example.com` |
| 搜 2025 年之后发布的资料 | `scripts/exa-search search "query" --start-published-date 2025-01-01` |
| 关键词精确搜索 | `scripts/exa-search search "query" --type keyword` |
