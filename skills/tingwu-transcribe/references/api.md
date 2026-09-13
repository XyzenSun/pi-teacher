# 完整 API 参考

网关基础地址默认 `http://127.0.0.1:8787`。所有业务错误统一返回 `{ error, code, detail }` JSON。

## POST /transcribe —— 上传并触发转写

三种请求方式任选：

```bash
# a. multipart 文件上传（推荐）
curl -X POST 'http://127.0.0.1:8787/transcribe?wait=true' \
  -F file=@audio.mp3 \
  -F showName='我的录音' \
  -F roleSplitNum=2

# b. JSON：传一个可下载的文件 URL，网关代为下载
curl -X POST http://127.0.0.1:8787/transcribe \
  -H 'content-type: application/json' \
  -d '{"fileUrl":"https://example.com/audio.mp3","roleSplitNum":2}'

# c. 裸 body：请求体即文件内容，格式经 query 声明
curl -X POST 'http://127.0.0.1:8787/transcribe?filename=audio.mp3' \
  --data-binary @audio.mp3
```

| 参数 | 位置 | 说明 |
|---|---|---|
| `wait` | query | `true` 时同步等待转写完成再返回（默认只返回 transId 立即返回） |
| `waitTimeout` | query | wait 模式轮询超时秒数，默认 900 秒（实现按秒解析，传秒数即可） |
| `showName` | 字段 | 任务显示名，默认取文件名去扩展名 |
| `lang` | 字段 | 语言，默认 `cn` |
| `roleSplitNum` | 字段 | 说话人分离人数，0=不分离（默认） |
| `dirId` | 字段 | 目标文件夹 id，默认 0（默认文件夹） |

返回 `{transId, taskId, showName, status}`；wait 模式完成后附 `duration/wordCount`。

支持的媒体扩展名（不在此列表会被 400 拒绝）：

- 音频：mp3 wav m4a aac amr wma flac ogg opus
- 视频：mp4 mov avi mkv flv webm 3gp ts（自动按视频任务提交）

## POST /transcribe-url - 听悟服务器下载直链并转写

新增的独立 JSON 入口. 原有 `POST /transcribe` 三种请求方式保持不变.

```bash
curl -X POST 'http://127.0.0.1:8787/transcribe-url?wait=true' \
  -H 'content-type: application/json' \
  -d '{"fileUrl":"https://example.com/video.mp4","showName":"直链转写","roleSplitNum":2}'
```

- `fileUrl` 必填, 仅支持不含用户名和密码的 `http(s)` 直链. 必须能被听悟服务器公开访问, 不转发源站 Cookie 或自定义下载头.
- JSON 可选参数: `showName` / `lang` / `roleSplitNum` / `dirId`, 默认值与原入口一致, 但 `showName` 默认使用听悟解析出的文件名 (可能含扩展名).
- `wait` / `waitTimeout` 与原入口一致. `waitTimeout` 包含服务器下载和转写阶段, 默认 900 秒.
- 新增 query 参数 `sourceTimeout`, 默认 120 秒, 分别约束解析、提交请求和查找任务三个阶段, 包含 HTTP 请求耗时.
- 即使 `wait=false`, 也先等解析、提交和任务关联完成再返回 `201` 和 `transId`.

响应字段为 `{transId, taskId, parseTaskId, fileId, showName, fileSize, isVideo, source, status}`. `source` 固定为 `net_source`, `status` 为 `downloading/transcribing/done`. 完成后附 `duration` (秒) 和 `wordCount`. 结果、TXT 和 SRT 复用现有端点.

该入口不下载媒体、不上传 OSS, 失败时不自动回退到旧流程. 类型和大小以听悟元数据为准, 不要求 URL 带媒体扩展名. 解析出零个或多个文件时拒绝提交, 避免意外批量计费.

提交请求或任务关联超时后, 任务可能已经创建. 错误 `detail` 携带 `phase/parseTaskId/fileId/showName`, 请先查询任务列表, 不要直接重试创建. 转写阶段超时携带 `detail.transId`, 可继续查询该任务.

## GET /transcripts —— 任务列表

查询参数：`pageNo` `pageSize` `status` `showName` `dirId` `orderDesc`。
转写 status: `0`=完成, `1`=转写中, `3`=已上传待转写, `4`=等待上传/下载, `5`=上传/下载中. `2` 等失败状态需结合 `statusMsg` 排查.

## GET /transcripts/:transId —— 单任务状态

轮询直到 status=0 即转写完成。

## GET /transcripts/:transId/result —— 转写结果

返回解析后的友好结构 + 原始数据：

```json
{
  "showName": "...", "duration": 93000,
  "playback": "https://...（音频回放签名 URL，有时效）",
  "text": "全文纯文本",
  "paragraphs": [
    {"speaker": 1, "startTimeMs": 18130, "endTimeMs": 41200, "text": "..."}
  ],
  "rawResult": { "pg": [ ... ] }
}
```

## POST /transcripts/:transId/export —— 导出 SRT

```bash
# 导出 SRT（默认，抓包验证过的组合：docType=1, fileType=2）
curl -X POST http://127.0.0.1:8787/transcripts/<transId>/export -o out.srt
```

请求体（均可选）：`docType`（默认 1）、`format`（目前仅 `srt` 有映射）、`fileType`（srt 之外请显式传数值，枚举未验证）、`withSpeaker`（默认 true）、`withTimeStamp`（默认 true）、`rawUrl`（true 时返回 `{downloadUrl}` JSON 而非代理下载文件流）。

默认行为是代理下载：导出文件内容直接返回给调用方，省去 OSS 签名 URL 的有效期问题。

## GET /transcripts/:transId/txt —— 纯文本下载

不走听悟导出接口，直接用转写结果拼装纯文本（每行 `[mm:ss][说话人N]` 前缀）。`name` 可选，用作下载文件名。

## Cookie 与健康状态

- `GET /` —— WebUI（单文件 ui.html，由网关托管：上传/列表/结果/导出/Cookie 更新）
- `GET /health` —— 存活检查、Cookie 配置状态与 invalid 状态
- `POST /cookie` —— 只接收纯 Cookie 值；真实验证成功后保存，并返回 `transcripts`
- `GET /cookie/check` —— 用当前 Cookie 真实验证并返回任务列表

## 错误码速查

| code | HTTP | 含义 |
|---|---|---|
| `COOKIE_MISSING` | 401 | 尚未配置 Cookie |
| `COOKIE_INVALID` | 401 | 登录已失效，网关已暂停业务请求，需更新 Cookie |
| `UNSUPPORTED_FORMAT` / `MISSING_EXTENSION` | 400 | 文件扩展名无法识别 |
| `OSS_UPLOAD_FAILED` | 502 | 上传文件到 OSS 失败 |
| `INVALID_FILE_URL` / `MISSING_FILE_URL` | 400 | 直链缺失或不是支持的 http(s) URL |
| `INVALID_JSON` / `INVALID_SHOW_NAME` / `INVALID_TIMEOUT` | 400 | 直链请求参数无效 |
| `JSON_CONTENT_TYPE_REQUIRED` | 415 | 直链端点只接受 application/json |
| `NET_SOURCE_FILE_COUNT` | 400 | 直链未解析出恰好一个文件 |
| `NET_SOURCE_OSS_REQUIRED` | 400 | 听悟要求先绑定 OSS 资源 |
| `NET_SOURCE_PARSE_FAILED` | 502 | 听悟解析直链失败或返回不完整元数据 |
| `NET_SOURCE_DOWNLOAD_FAILED` | 502 | 听悟服务器下载失败 |
| `NET_SOURCE_TASK_AMBIGUOUS` | 502 | 来源标识关联多个任务, 拒绝猜测 transId |
| `TRANSCRIPTION_FAILED` | 502 | 听悟返回异常任务状态 |
| `POLL_TIMEOUT` | 504 | 轮询超时，可稍后用 GET /transcripts/:id 再查 |
| `TINGWU_API_ERROR` | 502 | 听悟接口业务失败（detail 含 tingwuCode/requestId） |

## 架构（源码文件职责）

```
scripts/server.js          HTTP 层：WebUI 托管 + REST 路由（用户用）
scripts/cli.js             命令行入口（AI 用，无 UI，无需启动服务）
scripts/core.js            业务编排层：转写/导出流程、格式识别，两入口共享
scripts/tingwu-client.js   听悟 Web API 客户端；自动将 CMN.NotLogin 标记为 Cookie invalid
scripts/oss-uploader.js    OSS 直传：预签名 URL 整传为主，STS 分片上传（内置 V1 签名）兜底
scripts/cookie-store.js    纯 Cookie 校验、保存与 valid/invalid 状态管理
scripts/result-parser.js   内嵌 result JSON -> 全文 + 分段落结构
scripts/ui.html            单文件 WebUI：上传、列表、结果、SRT/TXT、Cookie 更新
```

AI 命令行用法见 [cli.md](cli.md)。

协议来源: 2026-09-02 本地上传抓包, 2026-09-13 直链抓包和官方前端协议核验. 鉴权依赖登录 Cookie, 无 CSRF token、无请求签名, Cookie 需手动维护. 直链协议细节见 [net-source.md](net-source.md).
