import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import {
    Editor,
    type EditorTheme,
    Key,
    matchesKey,
    Text,
    visibleWidth,
    wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { Type } from "typebox";
import type { SessionToolContext } from "./context.ts";

/**
 * ask_user：移植自官方样例 $PI/examples/extensions/question.ts（用户定稿：
 * 保留样例的 UI 行为，仅对齐我们的参数 schema question/choices?/multiline?）。
 *
 * 行为映射：
 * - choices 有值 → 样例的选择题形态（选项列表 + Type something 自定义输入）
 * - choices 空/缺省 → 直接进编辑器形态（multiline 控制单行/多行感）
 * - Esc 取消 → 返回 cancelled，模型自行决定换问法还是跳过
 *
 * 官方样例用 ctx.ui.custom()（全自定义 TUI 组件）；非交互模式（mode !== tui）
 * 直接提示模型改用对话正文提问——custom UI 只在 TUI 存在。
 */

interface OptionWithDesc {
    label: string;
    description?: string;
}

type DisplayOption = OptionWithDesc & { isOther?: boolean };

interface AskUserDetails {
    question: string;
    options: string[];
    answer: string | null;
    wasCustom?: boolean;
}

function toolResult(text: string): { content: Array<{ type: "text"; text: string }>; details: AskUserDetails | null } {
    return { content: [{ type: "text", text }], details: null };
}

const OPTION_SCHEMA = Type.Object({
    label: Type.String({ description: "选项文本" }),
    description: Type.Optional(Type.String({ description: "选项说明（可选），显示在选项下方" })),
});

export function createAskUserTool(_ctx: SessionToolContext): ToolDefinition {
    return defineTool({
        name: "ask_user",
        label: "向用户提问",
        description:
            "阻塞式向用户提问：给 choices 就是选择题（用户可选项也可自己写），不给就是输入题。用户取消时返回 cancelled。用于出练习题、需要用户输入答案、关键操作前确认。",
        // sequential：一次只问一个问题，多问并发展示会互相覆盖
        executionMode: "sequential",
        parameters: Type.Object({
            question: Type.String({ description: "问题文本，作为对话框标题展示" }),
            choices: Type.Optional(
                Type.Array(OPTION_SCHEMA, {
                    description: "选项列表。给出 = 选择题；不给 = 输入题",
                    maxItems: 12,
                }),
            ),
            multiline: Type.Optional(
                Type.Boolean({ description: "输入题时传 true 启用多行编辑器（长答案用）" }),
            ),
        }),

        async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
            if (ctx.mode !== "tui") {
                return toolResult(
                    "当前会话无交互界面（非 TUI 模式），无法弹窗提问。请把问题写进对话正文，用普通消息向用户提问。",
                );
            }

            const hasChoices = Array.isArray(params.choices) && params.choices.length > 0;

            if (!hasChoices) {
                // 输入题：走内置 editor 原语（多行直接支持；单行语义由题目描述决定）
                const answer = await ctx.ui.editor(params.question, params.multiline ? "" : undefined);
                if (answer === undefined || answer === "") {
                    return {
                        content: [{ type: "text", text: "cancelled：用户取消或未作答" }],
                        details: { question: params.question, options: [], answer: null } as AskUserDetails,
                    };
                }
                return {
                    content: [{ type: "text", text: `用户回答：${answer}` }],
                    details: { question: params.question, options: [], answer, wasCustom: true } as AskUserDetails,
                };
            }

            // 选择题：移植官方样例的全自定义 UI（选项列表 + Type something 编辑器）
            if (params.choices!.length > 12) {
                return toolResult("拒绝：choices 最多 12 项。选项过多说明问题该拆分。");
            }

            const allOptions: DisplayOption[] = [
                ...params.choices!.map((c) => ({ label: c.label, description: c.description })),
                { label: "Type something.", isOther: true },
            ];

            const result = await ctx.ui.custom<{ answer: string; wasCustom: boolean; index?: number } | null>(
                (tui, theme, _kb, done) => {
                    let optionIndex = 0;
                    let editMode = false;
                    let cachedLines: string[] | undefined;

                    const editorTheme: EditorTheme = {
                        borderColor: (s) => theme.fg("accent", s),
                        selectList: {
                            selectedPrefix: (t) => theme.fg("accent", t),
                            selectedText: (t) => theme.fg("accent", t),
                            description: (t) => theme.fg("muted", t),
                            scrollInfo: (t) => theme.fg("dim", t),
                            noMatch: (t) => theme.fg("warning", t),
                        },
                    };
                    const editor = new Editor(tui, editorTheme);

                    editor.onSubmit = (value) => {
                        const trimmed = value.trim();
                        if (trimmed) {
                            done({ answer: trimmed, wasCustom: true });
                        } else {
                            editMode = false;
                            editor.setText("");
                            refresh();
                        }
                    };

                    function refresh() {
                        cachedLines = undefined;
                        tui.requestRender();
                    }

                    function handleInput(data: string) {
                        if (editMode) {
                            if (matchesKey(data, Key.escape)) {
                                editMode = false;
                                editor.setText("");
                                refresh();
                                return;
                            }
                            editor.handleInput(data);
                            refresh();
                            return;
                        }

                        if (matchesKey(data, Key.up)) {
                            optionIndex = Math.max(0, optionIndex - 1);
                            refresh();
                            return;
                        }
                        if (matchesKey(data, Key.down)) {
                            optionIndex = Math.min(allOptions.length - 1, optionIndex + 1);
                            refresh();
                            return;
                        }

                        if (matchesKey(data, Key.enter)) {
                            const selected = allOptions[optionIndex];
                            if (selected.isOther) {
                                editMode = true;
                                refresh();
                            } else {
                                done({ answer: selected.label, wasCustom: false, index: optionIndex + 1 });
                            }
                            return;
                        }

                        if (matchesKey(data, Key.escape)) {
                            done(null);
                        }
                    }

                    function render(width: number): string[] {
                        if (cachedLines) return cachedLines;

                        const lines: string[] = [];
                        const renderWidth = Math.max(1, width);

                        function addWrapped(text: string) {
                            lines.push(...wrapTextWithAnsi(text, renderWidth));
                        }

                        function addWrappedWithPrefix(prefix: string, text: string) {
                            const prefixWidth = visibleWidth(prefix);
                            if (prefixWidth >= renderWidth) {
                                addWrapped(prefix + text);
                                return;
                            }
                            const wrapped = wrapTextWithAnsi(text, renderWidth - prefixWidth);
                            const continuationPrefix = " ".repeat(prefixWidth);
                            for (let i = 0; i < wrapped.length; i++) {
                                lines.push(`${i === 0 ? prefix : continuationPrefix}${wrapped[i]}`);
                            }
                        }

                        lines.push(theme.fg("accent", "─".repeat(renderWidth)));
                        addWrappedWithPrefix(" ", theme.fg("text", params.question));
                        lines.push("");

                        for (let i = 0; i < allOptions.length; i++) {
                            const opt = allOptions[i];
                            const selected = i === optionIndex;
                            const isOther = opt.isOther === true;
                            const prefix = selected ? theme.fg("accent", "> ") : "  ";
                            const label = `${i + 1}. ${opt.label}${isOther && editMode ? " ✎" : ""}`;
                            const color = selected || (isOther && editMode) ? "accent" : "text";

                            addWrappedWithPrefix(prefix, theme.fg(color, label));

                            if (opt.description) {
                                addWrappedWithPrefix("     ", theme.fg("muted", opt.description));
                            }
                        }

                        if (editMode) {
                            lines.push("");
                            addWrappedWithPrefix(" ", theme.fg("muted", "Your answer:"));
                            for (const line of editor.render(Math.max(1, renderWidth - 2))) {
                                lines.push(` ${line}`);
                            }
                        }

                        lines.push("");
                        if (editMode) {
                            addWrappedWithPrefix(" ", theme.fg("dim", "Enter to submit • Esc to go back"));
                        } else {
                            addWrappedWithPrefix(" ", theme.fg("dim", "↑↓ navigate • Enter to select • Esc to cancel"));
                        }
                        lines.push(theme.fg("accent", "─".repeat(renderWidth)));

                        cachedLines = lines;
                        return lines;
                    }

                    return {
                        render,
                        invalidate: () => {
                            cachedLines = undefined;
                        },
                        handleInput,
                    };
                },
            );

            const simpleOptions = params.choices!.map((o) => o.label);

            if (!result) {
                return {
                    content: [{ type: "text", text: "cancelled：用户取消了选择" }],
                    details: { question: params.question, options: simpleOptions, answer: null } as AskUserDetails,
                };
            }

            if (result.wasCustom) {
                return {
                    content: [{ type: "text", text: `用户自己输入：${result.answer}` }],
                    details: {
                        question: params.question,
                        options: simpleOptions,
                        answer: result.answer,
                        wasCustom: true,
                    } as AskUserDetails,
                };
            }
            return {
                content: [{ type: "text", text: `用户选择：${result.index}. ${result.answer}` }],
                details: {
                    question: params.question,
                    options: simpleOptions,
                    answer: result.answer,
                    wasCustom: false,
                } as AskUserDetails,
            };
        },

        // renderCall / renderResult 同官方样例：TUI 里展示问题与选项摘要 / 结果
        renderCall(args, theme, _context) {
            let text = theme.fg("toolTitle", theme.bold("ask_user ")) + theme.fg("muted", args.question);
            const opts = Array.isArray(args.choices) ? args.choices : [];
            if (opts.length) {
                const labels = opts.map((o: OptionWithDesc) => o.label);
                const numbered = [...labels, "Type something."].map((o, i) => `${i + 1}. ${o}`);
                text += `\n${theme.fg("dim", `  Options: ${numbered.join(", ")}`)}`;
            }
            return new Text(text, 0, 0);
        },

        renderResult(result, _options, theme, _context) {
            const details = result.details as AskUserDetails | undefined;
            if (!details) {
                const text = result.content[0];
                return new Text(text?.type === "text" ? text.text : "", 0, 0);
            }

            if (details.answer === null) {
                return new Text(theme.fg("warning", "Cancelled"), 0, 0);
            }

            if (details.wasCustom) {
                return new Text(
                    theme.fg("success", "✓ ") + theme.fg("muted", "(wrote) ") + theme.fg("accent", details.answer),
                    0,
                    0,
                );
            }
            const idx = details.options.indexOf(details.answer) + 1;
            const display = idx > 0 ? `${idx}. ${details.answer}` : details.answer;
            return new Text(theme.fg("success", "✓ ") + theme.fg("accent", display), 0, 0);
        },
    });
}
