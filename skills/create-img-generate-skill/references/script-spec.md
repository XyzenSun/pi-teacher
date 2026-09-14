# provider 脚本编写规范

所有生图 provider 脚本都是零依赖单文件 Node 脚本（Node >= 18 原生 fetch），放在 `generate-img/scripts/{provider}.js`。本规范保证不同 provider 的脚本质量与行为一致，编写前通读全文。

## 命名与位置

- 脚本：`generate-img/scripts/{provider}.js`，provider 用小写 kebab-case（如 `bailian.js`）。
- 文档：`generate-img/references/{provider}/*.md`，归档接口规范原文与使用说明，供日后维护脚本时查阅。

## 命令行接口

各服务的请求字段差异大，参数自由定义，但必须满足：

- 核心生图参数有对应 flag（如 `--prompt`），必填参数缺失时打印用法并以非零码退出。
- 支持 `--help`，无参数时也打印用法。
- 脚本写完后，把一条可直接复制的调用示例写进 `generate-img/SKILL.md` 状态区。

## API key

- 一律从 `process.env` 读取，变量名跟随服务官方惯例（如百炼用 `DASHSCOPE_API_KEY`），具体名以用户规范为准。
- key 缺失时打印缺失的变量名与配置指引，退出码 1。
- 任何输出（stdout / stderr / 错误信息）不得包含 key 明文。

## 图片落地

- 生成后把图片下载到 `~/pi-teacher/llm-text-to-img/`：用 `process.env.HOME` 解析家目录，禁止硬编码 `/root`；目录不存在则递归创建。
- 文件名格式：`yyyy-mm-dd-(中文简短描述)-<uuid>.<ext>`
  - 日期取脚本运行时的本地日期；uuid 用 `crypto.randomUUID()`；中文描述从 prompt 提炼，不超过 20 字；圆括号是文件名的一部分；扩展名按接口实际返回的图片类型（png / jpg / webp）。
  - 示例：`2025-09-14-(月光下的一只猫)-3f2a1b8c-….png`
- 结束时 stdout 最后一行输出 JSON 摘要，供会话内解析：`{"ok":true,"path":"…","url":"…","model":"…"}`（url 无则省略）。

## 网络与错误处理

- fetch 一律设超时（`AbortController`，单次请求 60 秒以内）。
- 异步任务型接口（提交任务 → task_id → 轮询查询）：轮询间隔 2-5 秒，总超时不低于 5 分钟，每 30 秒向 stderr 打印一行等待进度。
- HTTP 非 2xx：打印状态码与响应体前 500 字符，非零码退出。
- 图片 URL 下载失败自动重试 2 次；接口直接返回 base64 时解码写文件，不落 URL。
- 报错信息要能定位问题（缺参数、鉴权失败、余额不足、内容审核拦截等按接口实际错误码分类提示），不要只打印一串堆栈。
