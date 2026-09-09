# 第三方代码声明

本仓库部分代码移植自以下开源项目，特此声明并致谢。

## pi-web

- 上游：<https://github.com/agegr/pi-web>
- 版本基线：v0.9.0（tag v0.8.11 与 v0.9.0 之间桥接层文件无差异，见 PRD backend-host-mvp 前置核实）
- 许可证：MIT License（见下方全文）
- 移植文件：
  - `server/src/bridge/agent-event-stream.ts`（SSE 传输层，改造了 abort 信号来源）
  - `server/src/bridge/agent-event-wire.ts`（事件过滤与投影，原样）
  - `server/src/bridge/streaming-message.ts`（流式增量拼接，原样）
  - `server/src/bridge/pi-types.ts`（Pi 事件与消息类型，原样）
  - `server/src/bridge/agent-session-wrapper.ts`（基于 rpc-manager.ts 裁剪重写）
  - `server/src/session/session-reader.ts`（参考其结构按平铺布局重写）
  - `server/src/session/title-generator.ts`（移植自 session-title.ts）
  - `server/src/auth/password.ts`（scrypt 哈希写法参考 web-auth.ts）
  - `server/src/security/`（request-security.ts 与 path-security.ts 的 Express 适配版）
  - `web/src/lib/markdown.ts`（Markdown 管线与 normalizeDisplayMath，原样）
  - `web/src/lib/file-fuzzy.ts`（@ 文件补全打分，原样）
  - `web/src/lib/chat-lazy-load.ts`（滚动跟随与懒加载纯函数，原样）
  - `web/src/chat/stream-reducer.ts`（参考 lib/streaming-message.ts 与 use-agent-stream 重写）

MIT License

MIT License

Copyright (c) 2026 agegr

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
