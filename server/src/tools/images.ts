import { promises as fs } from "node:fs";
import path from "node:path";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { SessionToolContext } from "./context.ts";
import { MAX_ATTACHMENT_BYTES, resolveContentType } from "../session/attachments.ts";

/**
 * img_* 工具组：把本地图片送进用户界面。
 *
 * 图片字节不回传模型——base64 进上下文按图计 token 且每轮重发，展示指令改走
 * AgentToolResult.details：SDK 明确 details 只用于 UI 渲染，convertToLlm 不把它
 * 发给模型，但它随 toolResult 落 JSONL、经 SSE message_end 推送、历史重载可读回，
 * 是天然的展示通道（ADR-0044）。前端按 details.displayImage.url 请求
 * GET /api/images 拉图，模型与前端都不搬运图片内容。
 *
 * 工具不搬移不拷贝文件：存哪是 skill 与提示词的事（ADR-0023 生图落
 * ~/pi-teacher/llm-text-to-img/）。/tmp 里的图重启即失效、历史里该图变裂图，
 * 这是调用方选择存储位置的代价，不是展示工具的职责。
 */

/** details 通道的展示指令；前端 MessageView 按同名字段渲染 <img>。 */
export interface ImageDisplayDetails {
  displayImage: {
    /** 指向 GET /api/images 的同源 URL，路径已 percent-encode。 */
    url: string;
    /** 文件名，作为 alt 文本与下载名。 */
    name: string;
    mimeType: string;
    size: number;
  };
}

function textResult(text: string): { content: Array<{ type: "text"; text: string }>; details: null } {
  return { content: [{ type: "text", text }], details: null };
}

export function createImageTools(ctx: SessionToolContext): ToolDefinition[] {
  const imgDisplay = defineTool({
    name: "img_display",
    label: "展示图片",
    description:
      "在对话界面向用户展示一张本地图片（生成图、图表、截图等）。path 为图片文件路径，工作区内相对路径或绝对路径均可；只接受 PNG/JPEG/GIF/WEBP 位图。图片会直接出现在用户界面上，你不需要、也不应该把图片内容、base64 或图片链接写进文字回复。",
    parameters: Type.Object({
      path: Type.String({ description: "图片文件路径（工作区内相对或绝对路径）" }),
    }),
    async execute(_toolCallId, params): Promise<{ content: Array<{ type: "text"; text: string }>; details: ImageDisplayDetails | null }> {
      const absolutePath = path.resolve(ctx.workPath, params.path);
      const name = path.basename(absolutePath);

      let handle;
      try {
        handle = await fs.open(absolutePath, "r");
      } catch {
        return textResult(`拒绝：文件不存在或不可读（${params.path}）。`);
      }
      try {
        const stats = await handle.stat();
        if (!stats.isFile()) return textResult(`拒绝：${params.path} 不是普通文件。`);
        if (stats.size <= 0) return textResult(`拒绝：${params.path} 是空文件。`);
        if (stats.size > MAX_ATTACHMENT_BYTES) {
          return textResult(`拒绝：${params.path} 超过 ${MAX_ATTACHMENT_BYTES / 1024 / 1024}MB 展示上限。`);
        }
        // 只读头部 32 字节做 magic 判定，不把整张图读进内存
        const head = Buffer.alloc(32);
        const { bytesRead } = await handle.read(head, 0, 32, 0);
        const { mimeType, inlineSafe } = resolveContentType(name, head.subarray(0, bytesRead));
        if (!inlineSafe) {
          return textResult(
            `拒绝：${params.path} 不是可展示的位图（只支持 magic 认证的 PNG/JPEG/GIF/WEBP；SVG 请先转成位图）。`,
          );
        }
        // 路径必须 percent-encode：clientView 投影按字面子串替换绝对路径前缀，
        // 裸路径会让 URL 里的 /root/... 被改写成 ~/... 而指向不存在的文件
        const url = `/api/images?p=${encodeURIComponent(absolutePath)}`;
        return {
          content: [{ type: "text", text: `已向用户展示图片 ${name}（${mimeType}，${stats.size} 字节）。` }],
          details: { displayImage: { url, name, mimeType, size: stats.size } },
        };
      } finally {
        await handle.close();
      }
    },
  });

  return [imgDisplay];
}
