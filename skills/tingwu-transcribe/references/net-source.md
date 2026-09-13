# 直链转写协议 (net_source)

听悟网页版「音视频链接」功能的私有协议. 信息来源: 2026-09-13 浏览器抓包 (`tingwu-提供文件直链直接解析.har`)、官方前端 `umi.js 0.1.32` 反解、真实链路实测(齐鲁网公开 mp4 全流程跑通). 实现见 `scripts/core.js` 的 `transcribeUrl` 与 `scripts/tingwu-client.js` 的四个 net source 封装.

## 与本地上传流程的差异

| | 本地上传 (transcribe) | 直链 (transcribe-url) |
| --- | --- | --- |
| 媒体传输 | 本机上传 OSS | 听悟服务器从源站下载, 本机零传输 |
| 提交接口 | generatePutLink + syncPutLink | parseNetSourceUrl + putNetSourceUrl |
| transId 获取 | generatePutLink 直接返回 | putNetSourceUrl 不返回, 需从任务列表关联 |
| 额外阶段 | 无 | 服务器下载 (任务状态 4/5) |
| 文件类型判定 | 本地扩展名 | 听悟解析元数据 (isVideo/size/showName) |

## 接口序列

所有请求均为 POST + JSON + Cookie 鉴权, 与常规接口不同: net source 专用端点的 action 只在 body, query 仅 `c=web` (`/api/trans/request` 上的 putNetSourceUrl/queryNetSourceUpload 同样如此, 抓包确认).

### 1. parseNetSourceUrl

`POST /api/trans/parseNetSourceUrl` body `{action, version:"1.0", url}`. 听悟服务器去访问该 URL, 异步返回 `data: {taskId, needLinkOssResource}`. `needLinkOssResource=true` 表示该账号需先在网页版绑定 OSS 资源, 代码里直接报 `NET_SOURCE_OSS_REQUIRED`.

### 2. queryNetSourceParse (轮询, 间隔 1s)

`POST /api/trans/queryNetSourceParse` body `{action, version, taskId}`. `data.status`:

| status | 含义 (官方前端错误文案佐证) |
| --- | --- |
| -1 | 解析中, 继续轮询 |
| 0 | 成功, `data.urls` 出现 |
| 1 | 链接受版权/版本限制 |
| 2 | 解析失败 (非媒体/不可达) |
| 9 | 无效媒体链接 |
| 10 | RSS 源无音频 |

成功时 `data.urls[]: {fileId, size, isVideo, duration, showName, videoFrameUrl}`. **fileId 格式为 `<parseTaskId>-<序号>`, 每次解析生成新 taskId, 因此同一 URL 重复提交会产生不同的 fileId, 不会互相干扰**. `duration` 单位毫秒 (65350), 与转写结果的秒不同.

### 3. putNetSourceUrl (提交转写)

`POST /api/trans/request` body `{action, version:"1.0", files:[{fileId, dirId, fileSize, tag}]}`. tag 结构: `{fileType:"net_source", showName, lang, roleSplitNum, translateSwitch:0, transTargetValue:0, client:"web", originalTag}`. **成功响应 `data` 为空数组, 不含 transId** — 这是本协议最关键的坑.

### 4. transId 关联 (本 skill 的方案)

官方前端提交后靠刷新任务列表展示, 无程序化关联. 本 skill 在 `originalTag` 里附加 `netSourceFileId: <fileId>` (实测听悟原样保留该字段, 不校验内容), 提交后用 `getTransList(filter: {fileTypes:["net_source"], dirId})` 分页 (pageSize 100, 服务端上限 100) 查找解析该标记的唯一任务取回 transId. 相比按 showName/时间猜测, 可正确隔离同名任务与并发提交; 若匹配到多个任务则报 `NET_SOURCE_TASK_AMBIGUOUS` 拒绝猜测.

注意: showName 过滤依赖异步索引, 刚创建的任务会漏掉, 不能用 showName 搜索做关联.

### 5. queryNetSourceUpload (下载进度)

`POST /api/trans/request` body `{action, version, transIds:[...]}`. `data[]: {transId, status, progress, message, showName}`. status 枚举 (官方 `eNetSourceFileUploadStatus`): `-1`=下载中 (progress 0-100), `0`=完成, `1`=不支持, `3`=超限, `4`=失败. 失败时抛 `NET_SOURCE_DOWNLOAD_FAILED`.

### 6. getTransStatus (转写状态, 复用现有接口)

net_source 任务状态流转: `4`(等待下载) -> `5`(下载中) -> `3`(已就绪待转写) -> `1`(转写中) -> `0`(完成). 完整枚举见下.

## 任务状态枚举 (官方 TransFileStatus)

`0`=转写完成, `1`=转写中, `2`=转写失败, `3`=已上传待转写, `4`=等待上传/下载, `5`=上传/下载中, `9`=回收站, `10`=none, `11`=上传任务失败; `100/200/301/302/303`=本地上传失败系列; `20/21/22`=net_source 下载失败系列 (普通失败/网络不支持/超限).

本地上传任务也可能短暂处于 3, 轮询时 0/1/3 均视为进行中 (与官方前端一致), 其余状态视为失败.

## 已验证事实清单

- parse -> query -> put -> 列表关联 -> queryNetSourceUpload -> getTransStatus -> getTransResult 全链路真实跑通 (65 秒公开 mp4, 197 字结果).
- putNetSourceUrl 成功响应 `data:[]`; originalTag 自定义字段原样保留.
- fileId 随 parse taskId 变化, 重复提交同一 URL 不会命中旧任务标记.
- getTransList `fileTypes:["net_source"]` 过滤有效; 服务端 pageSize 实际上限 100.
- duration: queryNetSourceParse 与 getTransStatus/getTransResult 均不同 — parse 为毫秒, 后两者为秒.

## 安全与配额注意

- 直链必须能被听悟服务器公开访问; 不转发源站 Cookie/鉴权头, 不支持 URL 内嵌用户名密码. 签名 URL 须在听悟下载完成前保持有效.
- 解析可能返回多个 urls (播放页/RSS); 本 skill 要求恰好 1 个, 防止意外批量计费.
- 提交或关联超时后任务可能已创建 (错误 detail 含 `submitted:true`), 重试前必须先 `list` 确认, 避免重复任务.
