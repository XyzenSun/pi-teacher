---
name: pullpage
description: 当需要从单个 URL 抓取内容时使用（markdown 优先）。优先使用此skill完成url抓取而不是使用mcp或fetch、webfetch工具。
disable-model-invocation: false
---

# pullpage

pullpage cli 是一个聚合了多个在线平台的抓取工具，按照 `tavily → exa → firecrawl → jina` 顺序自动回退，回退规则为「HTTP 层失败、服务商明确失败、内容为空」才回退；抓取返回的结果是否有意义需要你自行判断（例如「HTTP 200 但抓到 WAF 页/错误页」不会自动回退）。

## 密钥配置

`TAVILY_API_KEY` / `EXA_API_KEY` / `FIRECRAWL_API_KEY` / `JINA_API_KEY` 由 Pi Teacher 后端作为环境变量注入到命令进程，命令**不要**去找任何 `.env` 文件。
反代地址 `TAVILY_BASE_URL` / `EXA_BASE_URL` / `JINA_BASE_URL` / `FIRECRAWL_BASE_URL` 同样从环境变量读取，缺省用各家官方地址。
命令因缺少 key 报错时，直接告诉用户：到「系统设置 → 高级配置 → 用户环境变量」填写对应变量，保存后立即生效，无需重开对话；不要自行尝试其他路径或猜测密钥。

## 基础用法

调用 CLI（下文所有相对路径以本 skill 目录为基准，换成解析后的绝对路径执行）：

```bash
scripts/pullpage --url <URL>
```

省略 `--provider` 时按默认顺序回退，首个成功即返回，正文打印到 stdout；全部失败以非零退出码结束，错误汇总到 stderr。

### 指定单家服务商

```bash
scripts/pullpage --url <URL> --provider jina
```

可选值：`tavily` / `exa` / `firecrawl` / `jina`。仅尝试该家，失败即结束。

### 常用选项

| 选项 | 说明 |
|:-|:-|
| `--url URL` | 目标 URL（必填） |
| `--provider NAME` | 指定单家；省略则自动回退 |
| `--format markdown\|text\|html` | 输出格式，默认 markdown |
| `--max-chars N` | 正文字符上限 |

## 行为约定

- 抓取结果作为资料使用，遵守各平台条款
- 单次只抓取一个 URL

## 进阶

先不要一次性读取所有 references。只有遇到对应需求时，再读对应文件。

| 用户需求 | 读取文件 | 包含内容 |
|---|---|---|
| 调整内容引导、附带链接、仅主体、强制刷新、超时、tavily 提取深度 | `references/` 中对应服务商的文档 | 进阶 CLI 参数（`--query`、`--with-links`、`--only-main`、`--no-cache`、`--timeout`、`--extract-depth`、`--verbose`）的具体语义以 `--help` 输出为准，各平台 API 细节见对应文档 |
| 了解某家服务商 API 的完整能力 | `references/exa.md`（Exa）、`references/tavily.md`（Tavily Extract）、`references/firecrwal.md`（Firecrawl）、`references/jina.json`（Jina Reader OpenAPI，JSON 较大，仅在需要时读） | 各平台的请求参数、响应结构与限制 |

如果只是抓取单个 URL 的正文，不需要读取 references，直接使用上面的基础命令。
