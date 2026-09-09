/**
 * 附件路由：挂在 `/api/conversations/:id` 之下（mergeParams:true 才能读到 :id），
 * 对外提供四个端点——
 *   POST /attachments        上传（application/octet-stream + X-File-Name）
 *   GET  /attachments        列表（元信息从磁盘现算）
 *   GET  /attachments/:name  下载（默认 attachment，图片可 ?inline=1）
 *   GET  /file-index?q=      当前工作目录文件相对路径搜索（供输入框 @ 补全）
 *
 * 上传协议为什么选「简单真实二进制」而不是 multipart：附件一次一个文件，multipart
 * 需要手写流式限量解析才能防住 chunked 下 Content-Length 不可信的问题（pi-web 为此
 * 写了 bounded-form-data.ts，见 04-API与基础设施.md §2.4）。裸 octet-stream 由
 * express.raw 的 limit 直接把关，文件名走 `X-File-Name`（encodeURIComponent 后
 * 只含 ASCII，HTTP 头安全），少一整层解析器就少一整类绕过。
 *
 * 中间件顺序是安全要求：body 解析器装在**认证之后**（index.ts 里 requireAuth 先于
 * 本路由）。未登录请求不该有机会让服务端为它缓冲 16MB 内存。
 *
 * 所有文件语义（名字校验、符号链接、MIME、大小）都在 session/attachments.ts；
 * 本文件只做 HTTP：状态码、响应头、参数取值。
 */
import { Router, raw } from "express";
import type { Request, Response } from "express";
import type { AppState } from "./app-state.ts";
import { apiErrorHandler, HttpError, readId } from "./http.ts";
import {
  ATTACHMENT_BODY_LIMIT,
  assertDeclaredMimeTypeShape,
  contentTypeHeaderValue,
  isNeverInlineMimeType,
  listAttachments,
  readAttachment,
  saveAttachment,
  searchFileIndex,
  type AttachmentMeta,
} from "../session/attachments.ts";

/** 上传响应投影：只出 id/相对路径/名字/MIME/大小，绝对路径永不出接口。 */
function toPublicAttachment(meta: AttachmentMeta): Pick<
  AttachmentMeta,
  "id" | "relativePath" | "name" | "mimeType" | "size"
> & { modifiedAt: string } {
  return {
    id: meta.id,
    relativePath: meta.relativePath,
    name: meta.name,
    mimeType: meta.mimeType,
    size: meta.size,
    modifiedAt: meta.modifiedAt,
  };
}

/**
 * Content-Disposition 的 filename：ASCII 回退（去掉引号与非 ASCII）+ RFC 5987 的
 * `filename*`，中文名在现代浏览器保存为原名，老浏览器也不会因为裸 UTF-8 头出错。
 */
function contentDispositionValue(disposition: "attachment" | "inline", name: string): string {
  const asciiFallback = name.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  return `${disposition}; filename="${asciiFallback}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

export function createAttachmentsRouter(state: AppState): Router {
  // mergeParams：:id 定义在父路由（/api/conversations/:id）上
  const router = Router({ mergeParams: true });

  const readConversationId = (req: Request): number => readId(req.params.id, "对话 id");

  /**
   * POST /attachments
   *
   * 请求：Content-Type: application/octet-stream
   *       X-File-Name: encodeURIComponent(原始文件名)   （必需）
   *       X-File-Type: 原始 MIME                        （可选，仅校验格式后丢弃）
   * 响应 200：{ id, relativePath, name, mimeType, size, modifiedAt }
   *
   * raw 解析器的 type 收紧到 octet-stream：其它 Content-Type 不会被缓冲，body 为空
   * 时统一回 415，让客户端明确知道协议不对，而不是收到一个含糊的 400。
   */
  router.post(
    "/attachments",
    raw({ type: "application/octet-stream", limit: ATTACHMENT_BODY_LIMIT }),
    (req: Request, res: Response) => {
      const piSessionId = readConversationId(req);
      if (!Buffer.isBuffer(req.body)) {
        throw new HttpError(415, "上传必须使用 Content-Type: application/octet-stream");
      }
      assertDeclaredMimeTypeShape(req.headers["x-file-type"]);
      const meta = saveAttachment(state.db, piSessionId, req.headers["x-file-name"], req.body);
      res.status(201).json({ success: true, attachment: toPublicAttachment(meta) });
    },
  );

  /**
   * GET /attachments —— 列表。元信息全部现算，磁盘上没有的文件不会出现在这里。
   * 目录还不存在时返回空数组（「没上传过」不是错误）。
   */
  router.get("/attachments", (req: Request, res: Response) => {
    const piSessionId = readConversationId(req);
    const attachments = listAttachments(state.db, piSessionId).map(toPublicAttachment);
    res.json({ attachments });
  });

  /**
   * GET /attachments/:name —— 下载。:name 可以是上传返回的 id，也可以是文件名本身。
   *
   * 响应头的三条硬规则：
   * 1. `X-Content-Type-Options: nosniff` —— 服务端给的 MIME 是最终解释，浏览器不许猜；
   * 2. 默认 `Content-Disposition: attachment`。只有 magic 确认过的 PNG/JPEG/GIF/WEBP
   *    在显式 `?inline=1` 时才 inline；HTML/SVG/XML 永远 attachment（它们能在同源里
   *    执行脚本并回调 /api，见 04-API与基础设施.md §2.4）；
   * 3. `Cache-Control: private, no-store` —— 附件属于登录用户，不进共享缓存。
   */
  router.get("/attachments/:name", (req: Request, res: Response) => {
    const piSessionId = readConversationId(req);
    const { meta, inlineSafe, data } = readAttachment(state.db, piSessionId, req.params.name);

    const wantsInline = req.query.inline === "1" || req.query.inline === "true";
    const allowInline = wantsInline && inlineSafe && !isNeverInlineMimeType(meta.mimeType);

    res.setHeader("Content-Type", contentTypeHeaderValue(meta.mimeType));
    res.setHeader("Content-Length", String(data.length));
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Cache-Control", "private, no-store");
    res.setHeader("Content-Disposition", contentDispositionValue(allowInline ? "inline" : "attachment", meta.name));
    // 即便浏览器忽略 disposition，也不给内容任何执行环境
    res.setHeader("Content-Security-Policy", "default-src 'none'; sandbox");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.status(200).end(data);
  });

  /**
   * GET /file-index?q= —— 当前对话工作目录下真实文件的相对路径搜索。
   *
   * 没有 cwd 参数：搜索根只能是本对话的 work_path，接口无法被拿去浏览全盘。
   * q 省略或为空即列全部（前端打开 @ 菜单先整取一次再本地过滤）；结果上限
   * 200 条，命中更多时 truncated=true，前端据此改走服务端搜索。
   */
  router.get("/file-index", (req: Request, res: Response) => {
    const piSessionId = readConversationId(req);
    const rawQuery = req.query.q;
    if (rawQuery !== undefined && typeof rawQuery !== "string") throw new HttpError(400, "q 必须是单个字符串");
    if (typeof rawQuery === "string" && rawQuery.length > 200) throw new HttpError(400, "q 过长");
    res.json(searchFileIndex(state.db, piSessionId, rawQuery ?? ""));
  });

  // 路由级错误中间件：本路由的 HttpError 与 body-parser 的 413/415 在这里就收敛成
  // JSON，不依赖调用方是否在 app 末尾挂了同一个 handler（附件是二进制接口，绝不能
  // 因为落到 Express 默认 handler 而回一页 HTML）。
  router.use(apiErrorHandler);

  return router;
}
