import type { ExtensionAPI, InlineExtension } from "@earendil-works/pi-coding-agent";
import type { SessionToolContext } from "./context.ts";
import { createCardTopicTools } from "./cards.ts";
import { createGlossaryTools } from "./glossary.ts";
import { createReviewTools } from "./review.ts";
import { createFileTools } from "./files.ts";
import { createAskUserTool } from "./ask-user.ts";

/**
 * pi-teacher 插件工厂：会话创建时由 createAgentSessionServices 的
 * resourceLoaderOptions.extensionFactories 装载（ADR-0024 进程内 SDK；
 * customTools 参数路线已否决——扩展工厂便于后续拆装与事件挂钩）。
 *
 * 会话上下文（spaceId、制卡开关、review_topic_id）经工厂闭包捕获：
 * 每个会话一份扩展实例，可见性裁决在构造时定死，零运行时查表。
 *
 * 可见性采用执行层拒绝（全量注册，拒绝时返回原因）：模型能感知边界并调整，
 * 与 ADR-0026「学习对话取卡不硬拒、返回值照常给」行为一致。
 */
export function createPiTeacherExtension(sessionContext: SessionToolContext): InlineExtension {
    return {
        name: "pi-teacher-tools",
        factory: (pi: ExtensionAPI) => {
            const allTools = [
                ...createCardTopicTools(sessionContext),
                ...createGlossaryTools(sessionContext),
                ...createReviewTools(sessionContext),
                ...createFileTools(sessionContext),
                createAskUserTool(sessionContext),
            ];
            for (const tool of allTools) {
                pi.registerTool(tool);
            }
        },
    };
}
