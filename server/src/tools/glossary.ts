import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { assertToolAllowed, type SessionToolContext } from "./context.ts";

/**
 * glossary_* 工具组：术语提议与查询（全局用户模型）。
 *
 * 与卡片查询同构：列表轻（id + term）、详情重（全字段）——
 * 每条术语名两三个 token，模型先拿目录判断相关性，再按 id 取定义，
 * 避免每次查询把全量 definition 拉进上下文。
 */

function toolResult(text: string): { content: Array<{ type: "text"; text: string }>; details: null } {
    return { content: [{ type: "text", text }], details: null };
}

export function createGlossaryTools(ctx: SessionToolContext): ToolDefinition[] {
    const db = ctx.db;

    const glossaryPropose = defineTool({
        name: "glossary_propose",
        label: "提议术语",
        description:
            "提议一个用户已彻底掌握的术语，进入全局术语库（待用户确认）。definition 应取自工作区 GLOSSARY.md 里用户自己的话，不要重写。",
        parameters: Type.Object({
            term: Type.String({ description: "术语本身，全局唯一。跨语境同名术语请写具体，如「C++ 引用」「Java 引用」" }),
            definition: Type.String({ description: "用户自己的话给出的定义（理解的证明），不是教科书定义" }),
        }),
        async execute(_toolCallId, params) {
            const gate = assertToolAllowed(ctx, "glossary_propose");
            if (!gate.allowed) return toolResult(gate.reason);

            // term 全局唯一：已存在即拒绝并给现有定义，模型自己核对（不校验内容只校验唯一性）
            const existing = db
                .prepare("SELECT id, term, definition, status FROM glossary WHERE term = ?")
                .get(params.term) as { id: number; term: string; definition: string; status: string } | undefined;
            if (existing) {
                return toolResult(
                    `拒绝：术语「${params.term}」已在术语库（id=${existing.id}，status=${existing.status}）。\n现有定义：${existing.definition}\n请核对：放弃提议，或判断现有定义质量不行时让用户在界面处理。`,
                );
            }

            const result = db
                .prepare("INSERT INTO glossary (term, definition, status) VALUES (?, ?, 'proposed')")
                .run(params.term, params.definition);
            return toolResult(`已提议术语「${params.term}」（glossary_id=${result.lastInsertRowid}，待用户确认）。`);
        },
    });

    const glossaryList = defineTool({
        name: "glossary_list",
        label: "术语列表",
        description: "列出术语库中用户已掌握的全部术语，每条返回 id 和 term。这是全局用户模型的目录页，用于判断哪些术语无需再讲。",
        parameters: Type.Object({}),
        async execute(_toolCallId, _params) {
            const gate = assertToolAllowed(ctx, "glossary_list");
            if (!gate.allowed) return toolResult(gate.reason);

            // 只返回 normal：proposed 未确认不能影响讲解行为（ADR-0005）
            const rows = db
                .prepare("SELECT id, term FROM glossary WHERE status = 'normal' ORDER BY term")
                .all();
            return toolResult(JSON.stringify(rows, null, 2));
        },
    });

    const glossaryGet = defineTool({
        name: "glossary_get",
        label: "术语详情",
        description: "返回一个术语的完整信息：id、term、definition、created_at。传 id（先 glossary_list 拿目录）。",
        parameters: Type.Object({
            term_id: Type.Number({ description: "术语 id" }),
        }),
        async execute(_toolCallId, params) {
            const gate = assertToolAllowed(ctx, "glossary_get");
            if (!gate.allowed) return toolResult(gate.reason);

            const row = db
                .prepare("SELECT id, term, definition, created_at FROM glossary WHERE id = ? AND status = 'normal'")
                .get(params.term_id);
            return toolResult(
                row ? JSON.stringify(row, null, 2) : `拒绝：term_id=${params.term_id} 不存在或未确认`,
            );
        },
    });

    return [glossaryPropose, glossaryList, glossaryGet];
}
