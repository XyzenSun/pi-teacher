# CLI 完整参考

入口：`node scripts/cli.js <command> [args] [--options]`（在 skill 目录下执行）。

输出约定：

- 成功：JSON 到 stdout（export/txt 输出文件内容到 stdout 的模式除外）
- 业务失败：`{error, code, detail}` JSON 到 stderr，退出码 1
- 用法错误（缺参数、未知命令）：提示文本到 stderr，退出码 2

## transcribe —— 上传并转写

```bash
node scripts/cli.js transcribe <本地文件路径 | http(s)URL>
```

| 选项 | 默认 | 说明 |
|---|---|---|
| `--show-name <n>` | 文件名去扩展名 | 任务显示名 |
| `--lang <lang>` | cn | 语言 |
| `--role-split <n>` | 0 | 说话人分离人数，0=不分离 |
| `--dir-id <n>` | 0 | 目标文件夹 id |
| `--wait` | 关 | 同步等待转写完成再返回 |
| `--timeout <sec>` | 900 | wait 模式轮询超时秒数 |

返回 `{transId, taskId, showName, fileFormat, fileSize, uploadMethod, status}`；`--wait` 完成后附 `duration/wordCount` 且 status=done。URL 输入由 CLI 代为下载，文件名从 URL 路径推断。

## transcribe-url - 听悟服务器下载直链并转写

```bash
node scripts/cli.js transcribe-url 'https://example.com/video.mp4' --wait
```

独立入口, 不改变 `transcribe <文件路径|URL>` 的下载再上传行为. 本机只调用听悟 JSON 接口, 不下载媒体、不上传 OSS, 也不自动回退到旧流程.

复用 `transcribe` 的 `--show-name` / `--lang` / `--role-split` / `--dir-id` / `--wait` / `--timeout` 选项. `--show-name` 默认使用听悟解析出的名称 (可能包含扩展名), 音视频类型和大小以听悟解析结果为准, 不依赖 URL 扩展名.

另有 `--source-timeout <sec>`, 默认 120 秒, 分别用于解析、提交请求和查找转写任务三个阶段. `--timeout` 默认 900 秒, 用于 `--wait` 时等待服务器下载及转写完成. 两种超时均包含 HTTP 请求耗时.

即使不加 `--wait`, 也会先等直链解析和任务关联完成, 才返回可用于 `status/result/export/txt` 的 `transId`:

```json
{
  "transId": "...",
  "taskId": "net-source-...",
  "parseTaskId": "...",
  "fileId": "...-0",
  "showName": "video.mp4",
  "fileSize": 16567881,
  "isVideo": true,
  "source": "net_source",
  "status": "downloading"
}
```

`status` 为 `downloading` / `transcribing` / `done`. 完成后附 `duration` (听悟返回的秒数) 和 `wordCount`. 直链模式不返回本地上传专用的 `fileFormat/uploadMethod`.

限制:

- 只接收 `http(s)` 音视频直链, 且必须解析出恰好一个文件, 不自动批量导入播放列表或 RSS.
- URL 必须能被听悟服务器访问. 不转发源站 Cookie、自定义鉴权头, 不接受 URL 用户名和密码. 签名 URL 须在听悟下载结束前保持有效.
- 提交或任务关联超时后, 任务可能已创建. 错误 `detail` 包含 `phase/parseTaskId/fileId/showName`, 请先用 `list` 确认, **不要直接重复提交**. 已取得任务的转写超时会返回 `detail.transId`.

## status —— 单任务状态

```bash
node scripts/cli.js status <transId>
```

返回听悟原始响应. 转写状态: `0`=完成, `1`=转写中, `3`=已上传待转写, `4`=等待上传/下载, `5`=上传/下载中. `2` 等失败状态需结合 `statusMsg` 排查.

## result —— 转写结果

```bash
node scripts/cli.js result <transId> [--text]
```

默认输出完整 JSON：`text`（全文）、`paragraphs[]`（speaker/startTimeMs/endTimeMs/text）、`playback`（回放 URL，有时效）、`rawResult`（原始数据）。`--text` 只输出全文纯文本。

## list —— 任务列表

```bash
node scripts/cli.js list [--page 1] [--size 20] [--status 0|1] [--name 关键词]
```

## export —— 导出 SRT

```bash
node scripts/cli.js export <transId> [-o out.srt] [--file-type 2] [--raw-url]
```

- 默认导出 SRT（抓包验证组合：docType=1, fileType=2）；`--file-type` 可显式指定其他枚举值（未验证）
- `-o` 写文件并输出 `{written, filename}`；省略则文件内容写到 stdout（文件名打到 stderr）
- `--raw-url` 输出 `{downloadUrl, filenameHint}`（OSS 签名 URL，有时效）而非文件内容

## txt —— 带说话人时间戳的纯文本

```bash
node scripts/cli.js txt <transId> [-o out.txt]
```

每行 `[mm:ss][说话人N]` 前缀。`-o` 写文件；省略则输出到 stdout。

## cookie —— Cookie 管理

```bash
node scripts/cli.js cookie set '<纯Cookie值>'    # 值为 - 时从 stdin 读
node scripts/cli.js cookie check
```

set 先真实访问听悟任务列表验证，成功才落盘（cookie.txt，权限 600）；失败保留旧 Cookie。Cookie 获取方法见 [cookie.md](cookie.md)。

## help

```bash
node scripts/cli.js help
```
