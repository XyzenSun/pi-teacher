# Tavily CLI 进阶用法

当用户需要调整运行环境、超时、输出格式，或普通 Markdown 不足以处理时，读取本文件。

## 参数表

| 参数/配置 | 示例 | 何时使用 | 注意事项 |
|---|---|---|---|
| `--format json` | `--format json` | 需要上游原始 JSON 给脚本或后续处理 | 等价快捷参数：`--json` |
| `--format pretty-json` | `--format pretty-json` | 需要人工审查完整响应结构 | 等价快捷参数：`--pretty` |
| `--timeout <duration>` | `--timeout 30s` | 网络慢、查询复杂或想快速失败时 | 默认读取 `TAVILY_TIMEOUT`，否则 `60s` |
| `TAVILY_BASE_URL` | `TAVILY_BASE_URL=https://api.tavily.com` | 使用代理、测试环境或兼容 Tavily API 的服务 | 默认 `https://api.tavily.com` |
| `TAVILY_API_KEY` | 写入 `.env` 或环境变量 | 调用 Tavily API 必需 | 不要写在命令行参数里 |
| `TAVILY_TIMEOUT` | `TAVILY_TIMEOUT=60s` | 设置默认请求超时 | 可被 `--timeout` 覆盖 |

## 完整 help

| 命令 | 用途 |
|---|---|
| `${CLAUDE_SKILL_DIR}/scripts/tavily-search --help` | 查看顶层帮助 |
| `${CLAUDE_SKILL_DIR}/scripts/tavily-search search --help` | 查看 search 子命令全部参数 |

## JSON 示例

```bash
${CLAUDE_SKILL_DIR}/scripts/tavily-search search "query" --json
${CLAUDE_SKILL_DIR}/scripts/tavily-search search "query" --pretty
```
