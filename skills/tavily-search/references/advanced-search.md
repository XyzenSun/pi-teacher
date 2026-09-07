# Tavily Search 进阶搜索参数

当用户需要控制搜索深度、时效范围、topic、国家或匹配策略时，读取本文件。

## 参数表

| 参数 | 示例 | 何时使用 | 注意事项 |
|---|---|---|---|
| `--search-depth <depth>` | `--search-depth advanced` | 控制搜索深度和召回 | 常见值：`basic`、`advanced`、`fast`、`ultra-fast` |
| `--topic <topic>` | `--topic news` | 指定搜索主题 | 常见值：`general`、`news`、`finance` |
| `--time-range <range>` | `--time-range week` | 最近一天/周/月/年 | 取值：`day`、`week`、`month`、`year` |
| `--start-date <date>` | `--start-date 2026-01-01` | 指定开始日期 | 比 `--time-range` 更精确 |
| `--end-date <date>` | `--end-date 2026-08-03` | 指定结束日期 | 可与 `--start-date` 搭配 |
| `--country <country>` | `--country "United States"` | 用户要求某国家视角或地区结果 | 使用完整国家名更稳妥 |
| `--auto-parameters` | `--auto-parameters` | 让 Tavily 自动推断部分参数 | 查询意图复杂且用户无明确参数偏好时可用 |
| `--exact-match` | `--exact-match` | 精确短语匹配 | 搜错误信息、日志片段、专有名词、论文标题 |

## 取值建议

| 参数 | 取值 | 适合场景 |
|---|---|---|
| `--search-depth` | `basic` | 默认，普通搜索 |
| `--search-depth` | `advanced` | 需要更全面结果或更高召回 |
| `--search-depth` | `fast` / `ultra-fast` | 更重视速度 |
| `--topic` | `general` | 默认，普通网页搜索 |
| `--topic` | `news` | 新闻、实时事件、近期动态 |
| `--topic` | `finance` | 金融市场、公司财务、投资相关资料 |

## 组合示例

| 需求 | 命令 |
|---|---|
| 搜最近一周新闻 | `${CLAUDE_SKILL_DIR}/scripts/tavily-search search "query" --topic news --time-range week` |
| 搜指定日期之后内容 | `${CLAUDE_SKILL_DIR}/scripts/tavily-search search "query" --start-date 2026-01-01` |
| 更深度搜索 | `${CLAUDE_SKILL_DIR}/scripts/tavily-search search "query" --search-depth advanced` |
| 精确匹配短语 | `${CLAUDE_SKILL_DIR}/scripts/tavily-search search "\"exact phrase\"" --exact-match` |
