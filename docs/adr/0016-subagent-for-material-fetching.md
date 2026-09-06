# 资料抓取交给子代理，隔离上下文污染

网络搜索与资料抓取会产生巨量上下文。抓一个网页动辄几万 token，B 站视频转录、PDF 全文更甚。这些原始内容对主会话毫无价值——教学对话只需要知道「资料已存到 `materials/xxx.md`，讲的是 Y」这一句，不需要原文躺在上下文里。

若在主会话里直接抓取，后果是三重的：上下文被挤占，触发压缩后教学脉络被摘要掉；每轮请求都要重发这些无用 token，成本线性上升；模型注意力被原始素材分散。

因此资料抓取由**子代理**执行，主会话只收到一句摘要。

## 复用 pi-web 的实现

Pi 原生没有 subagent，但 pi-web 用 Pi 的 `InlineExtension` + `defineTool` 自己实现了一套，MIT 许可，可直接复用（见 `docs/pi-web-研究/文件索引.md`）。

它不是外部插件包，而是进程内注册的内联扩展，名为 `pi-web-subagents`。核心文件：

| 文件 | 规模 | 作用 |
| --- | --- | --- |
| `lib/subagent-extension.ts` | 12KB | 向模型暴露工具，定义扩展 |
| `lib/subagent-runtime.ts` | 16KB | 执行子会话，收集结果 |
| `lib/subagents.ts` | 16KB | profile 配置与解析 |

暴露给模型的三个工具：`Agent`（派发任务）、`get_subagent_result`（取结果）、`steer_subagent`（中途干预）。

子代理的启动方式是「在会话里再起一个会话」：

```
SessionManager.create(parent.cwd, undefined, { parentSession: parent.sessionFile })
```

`parentSession` 记录父子关系，然后走 `createAgentSessionFromServices` 跑起来。子会话有自己独立的 jsonl 文件，原始素材落在那里，不进主会话历史。

## 为什么它的 profile 结构正好够用

`SubagentProfile` 的字段恰好覆盖了我们需要的隔离维度：

| 字段 | 我们怎么用 |
| --- | --- |
| `tools` | 只给抓取类工具，不给制卡、不给写 learning-records |
| `systemPrompt` | 写明抓取规范：转成 Markdown、存到 `materials/`、更新 `index.md`、只返回一句摘要 |
| `inheritContext: false` | **关键**。子代理不继承父会话历史，它不需要知道用户在学什么，只需要知道抓什么 |
| `loadSkills` / `loadExtensions` | 都设 false，子代理不需要教学相关的扩展 |
| `model` | 抓取与摘要是低难度任务，可指定便宜模型 |
| `maxTurns` | 防止抓取任务失控循环 |
| `runInBackground` | 长视频转录可后台跑，用户继续对话 |

`tools` 字段的解析还支持 `none` / `all` / `*` 这几个特殊值，以及 `disallowed_tools` 做减法（`lib/subagents.ts:151-155`）。

## 我们要定义的 profile

至少一个，可能两个：

**`fetch-material`** —— 抓取与转换。
- 工具：网络抓取、文件写入、`materials/index.md` 更新
- 提示词要求：转成 AI 可读格式（Markdown / HTML）、原件放 `materials/origins/`、系列课程按 `课程名/lessonN-标题.md` 组织、抓完在 `index.md` 追加一行简介、**只返回一句话摘要**
- `inheritContext: false`

**`research`** —— 需要多轮搜索比对的深度调研（待定是否需要）。
- 工具：网络搜索 + 抓取 + 文件写入
- 与 `fetch-material` 的区别是它要自己判断搜哪些、比对多个来源、剔除低质量的（对应学习区设计里那句「五个精辟的来源胜过三十个平庸的」）
- 首版可以先不做，等实际用起来发现 `fetch-material` 不够再加

## 返回值的约束

子代理的最终文本即返回值，会作为工具结果进入主会话（`lib/subagent-runtime.ts:314`）。因此**提示词必须严格约束返回长度**——否则子代理把抓来的内容又复述一遍，隔离就白做了。

返回格式定为一行：

```
已保存 materials/李宏毅机器学习/lesson3-梯度下降.md —— 讲梯度下降的三种变体与学习率调整策略
```

这条是提示词约束，不是代码约束（见 ADR-0014）。若发现模型反复超长，再考虑在工具层截断。

## Consequences

- 主会话上下文只承载教学脉络，不承载原始素材。压缩触发频率显著降低。
- 子会话的 jsonl 会落在工作区目录里（`SessionManager.create` 的第一个参数是 `parent.cwd`），但**不给它们建 `pi_session` 表记录**。`pi_session` 只登记用户直接参与的对话；子会话既不需要前端渲染也不涉及卡片管理，建行只会让每个列表查询都得带排除条件。识别子会话靠 jsonl header 里的 `parentSession` 字段，按文件扫描，不查库。
- 抓取失败的诊断信息在子会话里，主会话只看到一句失败摘要。排查时需要能打开子会话查看——前端入口要从父会话的工具调用块跳转，而不是从对话列表进入（列表里没有它）。
- 复用 pi-web 的三个文件需要裁剪：它的 profile 支持从磁盘按 scope 加载（builtin / global / workspace / project）、支持 WebUI 配置管理，我们首版可以只保留内置 profile 硬编码。
- 引入子代理后，「AI 有哪些工具」这个问题变成两层：主会话的工具集与子代理的工具集不同。制卡工具绝不给子代理，这是硬约束。
