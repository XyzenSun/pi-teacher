# Exa CLI 进阶用法

当用户需要调整运行环境、超时、输出格式，或普通 Markdown 不足以处理时，读取本文件。

## 参数表

| 参数/配置 | 适用子命令 | 示例 | 何时使用 | 注意事项 |
|---|---|---|---|---|
| `--text` | `answer` | `--text` | 需要答案来源文本，便于核验依据 | 普通 answer 可不开 |
| `--context` | `search` / `answer` | `--context` | 需要 Exa 返回额外上下文 | 普通查询不要默认开启 |
| `--format json` | `search` / `answer` | `--format json` | 需要上游原始 JSON 给脚本或后续处理 | 等价快捷参数：`--json` |
| `--format pretty-json` | `search` / `answer` | `--format pretty-json` | 需要人工审查完整响应结构 | 等价快捷参数：`--pretty` |
| `--timeout <duration>` | `search` / `answer` | `--timeout 30s` | 网络慢、查询复杂或想快速失败时 | 默认读取 `EXA_TIMEOUT`，否则 `60s` |
| `EXA_BASE_URL` | 配置 | `EXA_BASE_URL=https://api.exa.ai` | 使用代理、测试环境或兼容 Exa API 的服务 | 默认 `https://api.exa.ai` |
| `EXA_API_KEY` | 配置 | 由 Pi Teacher 后端从「系统设置 → 高级配置 → 用户环境变量」注入 | 调用 Exa API 必需 | 不要写在命令行参数里 |
| `EXA_TIMEOUT` | 配置 | `EXA_TIMEOUT=60s` | 设置默认请求超时 | 可被 `--timeout` 覆盖 |

## 完整 help

| 命令 | 用途 |
|---|---|
| `scripts/exa-search --help` | 查看顶层帮助 |
| `scripts/exa-search search --help` | 查看 search 子命令全部参数 |
| `scripts/exa-search answer --help` | 查看 answer 子命令全部参数 |

## JSON 示例

| 需求 | 命令 |
|---|---|
| search 原始 JSON | `scripts/exa-search search "query" --json` |
| answer 格式化 JSON | `scripts/exa-search answer "question" --pretty` |

## 其他说明


  --json 与 --pretty 同时传时输出 compact JSON