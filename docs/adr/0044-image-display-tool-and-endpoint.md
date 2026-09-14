# 图片展示：img_display 工具走 details 展示通道，端点不限制来源目录

- 状态：已采纳
- 日期：2026-09-14
- 相关：ADR-0014（判据归提示词、硬约束归代码）、ADR-0023（生图落全局图库）、ADR-0027（能力载体只有 skill 与插件）、ADR-0038（`files/` 与附件端点的内容校验）

> 状态补充（2026-09-14，同日）：展示形态由方案 A 调整为方案 C——150px 缩略图 + 灯箱（yet-another-react-lightbox，MIT，Zoom / Download 插件），用户在对比稿四案中改拍；其余决策不变。

## 背景

生图 skill（generate-img，ADR-0023）把图片下载落盘并在 stdout 输出本地路径，但 Web 前端没有任何机制把这张图显示在对话里——用户花钱生成的图，只能听模型转述「图在 /tmp/xxx.png，你可以自己打开看看」。

两条硬约束：

1. **图片字节不能以 base64 进模型上下文**：按图计 token，且每轮重发给 provider。
2. **展示必须经得起历史重载**：用户明天再打开这条对话，图还在原位。

## 决策

1. **新工具 `img_display(path)`**：校验目标是 magic 认证的位图（PNG/JPEG/GIF/WEBP、≤16MB）后，把展示指令放进 `AgentToolResult.details`（`displayImage: { url, name, mimeType, size }`），`content` 只回一行文本确认。SDK 的 `details` 是纯 UI 通道：`convertToLlm` 不把它发给模型，但它随 toolResult 落 JSONL、经 SSE `message_end` 推送、历史重载可读回——正好是「给前端看、不给模型看」的通道。
2. **新端点 `GET /api/images?p=<percent-encoded 绝对路径>`**：**不限制来源目录**。安全边界从「路径在哪」换成「内容是什么」——只回 magic 认证的位图，其余内容一律 404。密钥、数据库、配置都不是位图，经此端点一个字节都出不去；而「展示图片」这个功能本来也只该回图片。
3. **前端形态（方案 A，用户在 HTML 对比稿四案中拍板）**：`ToolCallView` 检测 `details.displayImage`，在工具折叠卡外常显 `<img>`（最大 480px），点击新开原图。图不藏进折叠块——模型调 img_display 的目的就是让用户看见。
4. **工具不搬移不拷贝文件**：存哪由 skill 与提示词决定（ADR-0023 生图落 `~/pi-teacher/llm-text-to-img/`）。/tmp 里的图重启即失效、历史里该图变裂图，这是调用方选择存储位置的代价，不是展示工具的职责。

## 为什么不是别的

- **工具结果回 ImageContent（base64）**：SDK 原生支持，但字节进 JSONL 与模型上下文，每轮重发按图计 token。否决。
- **模型在正文写 Markdown 图 `![](url)`**：依赖模型把 URL 写对；且 clientView 投影按字面子串替换绝对路径前缀，模型手拼的裸路径 URL 会被 `/root/ → ~/` 改写成死链。否决作为主通道。
- **端点只服务 `llm-text-to-img/`**：生图落点由 skill 决定，图表可能落在会话工作目录，临时文件在 /tmp——端点管存储策略就总有一天挡住合法的图。否决。
- **拷贝进会话 `files/` 复用附件端点**：跨会话展示同一张图会重复拷贝，展示副本还会混进会话附件列表。否决。

## 后果

- 工具面 15 → 16（新前缀组 `img_*`，一文件一组）；全部会话类型可用，不进助教拒绝名单与制卡开关。
- `/api/images` 是全站唯一不限来源目录的读取端点；magic 位图判定复用 `session/attachments.ts` 的 `resolveContentType`——「能下载的」「能喂给模型的」「能展示的」永远同一套内容校验。
- URL 里的路径必须 `encodeURIComponent`：clientView 的字面子串替换不会碰 percent-encoded 路径，裸路径会被改写成死链（http-smoke 有断言钉住）。
- SVG 不支持（能在同源执行脚本的图片格式不进展示通道），需要时先转位图。
- 展示形态对比稿保留在 `docs/前端模板/图片展示形态对比.html`，后续调整形态时先改稿再改代码。
