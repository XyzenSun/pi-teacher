---
name: tingwu-transcribe
description: 通过通义听悟（tingwu.aliyun.com）网页版 API 把音频和视频转写成文字，输出全文、说话人分段与时间戳，可导出 SRT 字幕/TXT。当用户要求「转写/识别这段音频或视频」「提取视频里的语音为文字」「生成字幕」，或明确提到「通义听悟 / tingwu」时使用。两个入口：cli.js 供 AI 纯命令行操作（默认，无需起服务），server.js 启动 Web 网关供用户浏览器上传文件。
license: MIT
compatibility: Node.js >= 18（零第三方依赖，无需 npm install）
---

# tingwu-transcribe

通义听悟私有 API 封装，两个入口位于 scripts/，共享同一业务编排层（scripts/core.js）：

- **scripts/cli.js**：AI 用，纯命令行，无需启动服务——转写任务默认走这里
- **scripts/server.js**：Web 网关（WebUI + REST），用户要在页面上传/浏览时启动，不推荐，建议让用户使用`https://tingwu.aliyun.com` 操作提供文件名，提供cli解析结果，节省上传开销。

## 前置：Cookie

鉴权完全依赖听悟登录 Cookie。执行任何业务命令前先确认：

```bash
node scripts/cli.js cookie check
```

报 `COOKIE_MISSING` / `COOKIE_INVALID` 时，按 [references/cookie.md](references/cookie.md) 引导用户提供纯 Cookie 值，然后：

```bash
node scripts/cli.js cookie set '<纯Cookie值>'    # 值传 - 则从 stdin 读
```

set 会先真实访问听悟验证，成功才落盘；失败保留旧 Cookie。

## CLI 转写（AI 默认路径）

```bash
# 本地文件或 URL 均可；--wait 同步等完成（默认 900 秒，--timeout 可调）
node scripts/cli.js transcribe ./video.mp4 --wait --role-split 2
node scripts/cli.js transcribe 'https://example.com/audio.mp3' --wait

# 取结果：默认 JSON（含 paragraphs 说话人+时间戳），--text 只出全文纯文本
node scripts/cli.js result <transId> --text

# 导出 SRT / 带说话人时间戳的 TXT（-o 写文件，省略则输出到 stdout）
node scripts/cli.js export <transId> -o out.srt
node scripts/cli.js txt <transId> -o out.txt
```

输出约定：成功输出 JSON 到 stdout；失败输出 `{error, code, detail}` JSON 到 stderr 并非零退出。视频文件自动按视频任务提交（mp4/mov/mkv/webm 等）。其余命令（status/list）见 [references/cli.md](references/cli.md)。

## Serve 模式（用户用）

```bash
node scripts/server.js        # 默认 http://0.0.0.0:8787，把地址给用户
```

WebUI 支持上传/列表/结果/导出/Cookie 更新。REST 端点参考 [references/api.md](references/api.md)。环境变量：`TW_PORT` / `TW_HOST` / `TW_COOKIE_FILE`。

## 支持文件

- [references/cli.md](references/cli.md)：CLI 全部命令、参数与输出约定。用不熟悉的命令前先读。
- [references/api.md](references/api.md)：serve 模式 REST 端点、参数表、错误码。
- [references/cookie.md](references/cookie.md)：Cookie 获取、更新、失效处理与安全要求。Cookie 缺失或失效时读。

## 安全约束

CLI 与网关均持有登录 Cookie：cookie.txt 权限 600，勿外传、勿提交 git。server 默认监听 0.0.0.0 且无鉴权，仅可信网络使用。
