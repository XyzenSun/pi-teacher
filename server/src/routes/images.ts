/**
 * 图片展示路由：GET /api/images?p=<percent-encoded 文件路径>
 *
 * 这是全站唯一「不限制来源目录」的读取端点，安全边界从「路径在哪」换成了
 * 「内容是什么」：只回 magic 认证的位图（PNG/JPEG/GIF/WEBP），其余内容一律 404。
 * 密钥、数据库、配置都不是位图，经本端点一个字节都出不去；而「展示图片」这个
 * 功能本来也只该回图片。目录白名单被否决（ADR-0044）：生图落点由 skill 决定
 * （~/pi-teacher/llm-text-to-img/，ADR-0023），图表可能落在会话工作目录，临时
 * 文件在 /tmp——端点不该重复管存储策略，管了就总有一天挡住合法的图。
 *
 * 响应头与附件下载同规（nosniff、CSP sandbox、Referrer-Policy、private/no-store），
 * 区别只有一处：本端点只为展示而生，Content-Disposition 恒为 inline，不需要
 * ?inline=1 显式声明。magic 判定复用 session/attachments.ts——「能下载的」
 * 「能喂给模型的」「能展示的」永远走同一套内容校验。
 */
import { Router } from "express";
import type { Request, Response } from "express";
import { promises as fs } from "node:fs";
import path from "node:path";
import { apiErrorHandler, HttpError } from "./http.ts";
import { contentDispositionValue } from "./attachments.ts";
import { contentTypeHeaderValue, MAX_ATTACHMENT_BYTES, resolveContentType } from "../session/attachments.ts";

export function createImagesRouter(): Router {
  const router = Router();

  router.get("/", async (req: Request, res: Response) => {
    const rawPath = req.query.p;
    if (typeof rawPath !== "string" || rawPath.trim().length === 0) {
      throw new HttpError(400, "缺少 p 参数（图片文件路径）");
    }
    // 来源目录不设限；resolve 只做词法归一（./、../），符号链接照常跟随——
    // 内容闸门在读取之后，跟随链接读到的仍必须是位图才出得去
    const filePath = path.resolve(rawPath);

    const stats = await fs.stat(filePath).catch(() => null);
    if (!stats?.isFile()) throw new HttpError(404, "图片不存在");
    if (stats.size <= 0) throw new HttpError(404, "不是可展示的图片");
    if (stats.size > MAX_ATTACHMENT_BYTES) throw new HttpError(413, "图片超过大小限制，无法展示");

    const data = await fs.readFile(filePath).catch(() => {
      throw new HttpError(404, "图片不存在");
    });
    // stat 与 readFile 之间文件可能被换掉：magic 认的是实际读到的字节，不是 stat 时的
    const { mimeType, inlineSafe } = resolveContentType(path.basename(filePath), data.subarray(0, 32));
    if (!inlineSafe) throw new HttpError(404, "不是可展示的图片（只支持 PNG/JPEG/GIF/WEBP 位图）");

    res.setHeader("Content-Type", contentTypeHeaderValue(mimeType));
    res.setHeader("Content-Length", String(data.length));
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Content-Security-Policy", "default-src 'none'; sandbox");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("Cache-Control", "private, no-store");
    res.setHeader("Content-Disposition", contentDispositionValue("inline", path.basename(filePath)));
    res.status(200).end(data);
  });

  // 二进制端点：错误必须收敛成 JSON，不能落回 Express 默认的 HTML 错误页
  router.use(apiErrorHandler);
  return router;
}
