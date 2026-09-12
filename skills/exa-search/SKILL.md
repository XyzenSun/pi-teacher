---
name: exa-search
description: 使用 Exa 进行联网搜索，Exa 对官方文档、论文、版本信息和研究资料权重较高，适合确定性资料搜索与正确性核验；当需要网络搜索时可调用此 skill。
---

# Exa Search

使用 `scripts/exa-search` 调用 Exa Search API。下文所有相对路径以本 skill 目录为基准，换成解析后的绝对路径执行。默认输出 Markdown，优先给模型直接阅读和总结。

## CLI 怎么用

| 需求 | 命令 | 说明 |
|---|---|---|
| 查看帮助 | `scripts/exa-search --help` | 查看顶层帮助与全部参数 |
| 搜索网页结果 | `scripts/exa-search search "query"` | 需要资料源、引用列表、搜索结果时优先用 |
| 直接回答问题 | `scripts/exa-search answer "question"` | 需要带 citations 的答案时优先用 |
| 搜索并限制数量 | `scripts/exa-search search "query" --num-results 5` | 普通查询常用 `3`、`5`、`10` |
| 搜索并返回证据片段 | `scripts/exa-search search "query" --include-highlights` | 需要摘要片段、证据句、引用依据时用 |
| 搜索并返回正文 | `scripts/exa-search search "query" --include-text` | 需要网页正文时用；最好同时限制结果数量 |
| 回答并请求来源文本 | `scripts/exa-search answer "question" --text` | 需要核验答案依据时用 |

## 密钥配置

`EXA_API_KEY` 由 Pi Teacher 后端作为环境变量注入到命令进程，命令**不要**设置或输出 key，也不要寻找其他配置文件。
`EXA_BASE_URL` 与 `EXA_TIMEOUT` 同样从环境变量读取，分别默认为 `https://api.exa.ai` 与 `60s`。
命令因缺少 key 报错时，直接告诉用户：到「系统设置 → 高级配置 → 用户环境变量」填写 `EXA_API_KEY`，保存后立即生效，无需重开对话；不要自行尝试其他路径或猜测密钥。

## 基础高频参数

| 参数 | 适用子命令 | 示例 | 何时使用 |
|---|---|---|---|
| `--num-results <n>` | `search` | `--num-results 5` | 控制搜索结果数量 |
| `--include-highlights` | `search` | `--include-highlights` | 需要重点片段、证据句 |
| `--include-text` | `search` | `--include-text` | 需要网页正文；普通搜索不要默认开启 |
| `--text` | `answer` | `--text` | 需要 answer 来源文本 |
| `--format markdown` | `search` / `answer` | `--format markdown` | 默认输出，适合直接阅读 |
| `--json` / `--format json` | `search` / `answer` | `--json` | 需要上游原始 JSON 给脚本处理 |
| `--pretty` / `--format pretty-json` | `search` / `answer` | `--pretty` | 需要人工查看完整 JSON 结构 |

## 渐进式读取 references

先不要一次性读取所有 references。只有遇到对应需求时，再读对应文件。

| 用户需求 | 读取文件 | 包含内容 |
|---|---|---|
| 限制站点、排除站点、控制搜索类型、按发布时间或抓取时间过滤 | `references/advanced-search.md` | `--type`、`--category`、`--include-domain`、`--exclude-domain`、日期过滤、`--context` |
| 调整 answer 进阶行为、输出 JSON、timeout、base URL、完整 help | `references/advanced-cli.md` | `--text`、`--context`、`--format`、`--timeout`、`EXA_TIMEOUT`、`EXA_BASE_URL` |

如果用户只是普通联网搜索或直接问答，不需要读取 references，直接使用上面的高频命令。
