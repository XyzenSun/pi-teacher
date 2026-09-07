# Tavily 内容与过滤参数

当用户需要限定站点、排除站点、获取正文、图片或 favicon 时，读取本文件。

## 参数表

| 参数 | 示例 | 何时使用 | 注意事项 |
|---|---|---|---|
| `--include-domain <domain>` | `--include-domain docs.example.com` | 只查指定站点、官方文档、可信来源 | 可重复使用 |
| `--exclude-domain <domain>` | `--exclude-domain example.com` | 排除噪音站点、不可信站点、用户明确不想要的来源 | 可重复使用 |
| `--include-raw-content <mode>` | `--include-raw-content markdown` | 需要网页正文用于摘录、核验、总结 | 普通搜索不要默认开启，内容可能很长 |
| `--include-images` | `--include-images` | 用户需要相关图片 URL | 只在图片确实有用时开启 |
| `--include-image-descriptions` | `--include-image-descriptions` | 需要图片说明辅助判断 | 常与 `--include-images` 一起使用 |
| `--include-favicon` | `--include-favicon` | 需要站点 favicon 方便展示或识别来源 | 对普通文字回答不是必需 |
| `--chunks-per-source <n>` | `--chunks-per-source 3` | 需要从每个来源取更多内容片段 | 结果会更长 |

## 组合示例

只查官方文档：

```bash
./scripts/tavily-search search "query" --include-domain docs.example.com
```

排除低质量来源：

```bash
./scripts/tavily-search search "query" --exclude-domain example.com
```

获取正文和来源图标：

```bash
./scripts/tavily-search search "query" --include-raw-content markdown --include-favicon
```
