import { promises as fs } from "node:fs";
import path from "node:path";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { SessionToolContext } from "./context.ts";

/**
 * md_* / file_* 工具组：长文档导航与文件探查（全部只读）。
 *
 * materials/ 的课程转录动辄几万字，全文 read 会爆上下文。两个 md 工具补上
 * 「某标题下到哪里为止」的边界计算——这算术交给模型是负担且易错。
 * 行号与 Pi 自带 read 的 offset/limit 组合使用，是组合关系不是替代。
 *
 * 相对路径基于当前 Pi Session 的 workPath 解析。按 ADR-0030 不实现应用级
 * 文件沙箱；容器与远程执行 skill 负责系统边界，HTTP 附件接口单独限制路径。
 */

function toolResult(text: string): { content: Array<{ type: "text"; text: string }>; details: null } {
    return { content: [{ type: "text", text }], details: null };
}

interface HeadingLine {
    line: number; // 1-based
    level: number; // 1-6
    text: string;
}

/** 扫描 md 文本，收集 ATX 标题行（# 前缀）。setext 标题（下划线式）不识别——资料库统一 ATX。 */
function parseHeadings(content: string): HeadingLine[] {
    const headings: HeadingLine[] = [];
    const lines = content.split("\n");
    for (let i = 0; i < lines.length; i++) {
        const match = /^(#{1,6})\s+(.*)$/.exec(lines[i]);
        if (match) {
            headings.push({ line: i + 1, level: match[1].length, text: match[2].trim() });
        }
    }
    return headings;
}

export function createFileTools(ctx: SessionToolContext): ToolDefinition[] {
    const mdGetOutline = defineTool({
        name: "md_get_outline",
        label: "Markdown 标题目录",
        description:
            "返回 Markdown 文件的标题目录，每行带行号与层级，如「42: ### 数学定义」。拿到行号后可用自带 read 工具的 offset/limit 精确读任意段。",
        parameters: Type.Object({
            path: Type.String({ description: "文件路径（工作区内相对或绝对路径）" }),
            level: Type.Optional(
                Type.Number({ minimum: 1, maximum: 6, description: "只要这一级标题，不传返回全部级别" }),
            ),
        }),
        async execute(_toolCallId, params) {
            const filePath = path.resolve(ctx.workPath, params.path);

            let content: string;
            try {
                content = await fs.readFile(filePath, "utf-8");
            } catch {
                return toolResult(`拒绝：文件不存在或不可读（${params.path}）。`);
            }

            const headings = parseHeadings(content).filter(
                (h) => params.level === undefined || h.level === params.level,
            );
            if (headings.length === 0) {
                return toolResult("该文件没有 Markdown 标题（无 # 行），无法生成目录。");
            }
            return toolResult(headings.map((h) => `${h.line}: ${"#".repeat(h.level)} ${h.text}`).join("\n"));
        },
    });

    const mdGetSection = defineTool({
        name: "md_get_section",
        label: "按标题取段",
        description:
            "取出某个标题下的全部内容（含子标题），边界由工具计算：从该标题到下一个同级或更高级标题为止。heading 按文本匹配（不带 # 前缀）；重名标题命中多处时全部返回。",
        parameters: Type.Object({
            path: Type.String({ description: "文件路径（工作区内相对或绝对路径）" }),
            heading: Type.String({ description: "标题文本，不带 # 前缀，如「梯度下降」" }),
        }),
        async execute(_toolCallId, params) {
            const filePath = path.resolve(ctx.workPath, params.path);

            let content: string;
            try {
                content = await fs.readFile(filePath, "utf-8");
            } catch {
                return toolResult(`拒绝：文件不存在或不可读（${params.path}）。`);
            }

            const lines = content.split("\n");
            const headings = parseHeadings(content);
            // 命中所有同名标题（重名子标题如多个「总结」不算罕见）
            const hits = headings.filter((h) => h.text === params.heading.trim());
            if (hits.length === 0) {
                // 没命中同名？给相近标题当线索，模型自己判断拼错还是不存在
                const suggestions = headings
                    .filter((h) => h.text.includes(params.heading.trim()) || params.heading.trim().includes(h.text))
                    .slice(0, 8)
                    .map((h) => `${h.line}: ${"#".repeat(h.level)} ${h.text}`);
                return toolResult(
                    `未找到标题「${params.heading}」。` +
                        (suggestions.length > 0 ? `相近标题：\n${suggestions.join("\n")}` : "该文件可能没有这个标题，可先 md_get_outline 看目录。"),
                );
            }

            const sections = hits.map((hit) => {
                // 边界：下一个同级或更高级标题（level <= hit.level 的下一行）
                let end = lines.length;
                for (const h of headings) {
                    if (h.line > hit.line && h.level <= hit.level) {
                        end = h.line - 1;
                        break;
                    }
                }
                return {
                    startLine: hit.line,
                    endLine: end,
                    content: lines.slice(hit.line - 1, end).join("\n"),
                };
            });

            return toolResult(
                sections
                    .map((s) => `--- 第 ${s.startLine}-${s.endLine} 行 ---\n${s.content}`)
                    .join("\n\n"),
            );
        },
    });

    const fileGetSizeAndLength = defineTool({
        name: "file_get_size_and_length",
        label: "文件探查",
        description:
            "读长文件前的第一步：返回 characters（UTF-8 码点数）、lines、bytes。自带 read 工具按「行数或字节数先到为准」截断——拿着这三个数可预判会不会被截断、该分几段读。",
        parameters: Type.Object({
            path: Type.String({ description: "文件路径（工作区内相对或绝对路径）" }),
        }),
        async execute(_toolCallId, params) {
            const filePath = path.resolve(ctx.workPath, params.path);

            let content: Buffer;
            try {
                content = await fs.readFile(filePath);
            } catch {
                return toolResult(`拒绝：文件不存在或不可读（${params.path}）。`);
            }
            const text = content.toString("utf-8");
            // characters 按 UTF-8 码点数而非字节数：中文一个字 3 字节但算 1 字符，
            // 模型对「字符数」的直觉是前者
            const characters = [...text].length;
            const lineCount = text === "" ? 0 : text.split("\n").length;

            return toolResult(JSON.stringify({ characters, lines: lineCount, bytes: content.length }));
        },
    });

    return [mdGetOutline, mdGetSection, fileGetSizeAndLength];
}
