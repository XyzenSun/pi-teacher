import type { Runtime, SlashCommand } from "../api/types.ts";

/**
 * WebUI 支持的 Pi 原生命令（ADR：compact-command-entry）。
 *
 * Pi 的原生命令（BUILTIN_SLASH_COMMANDS）是 TUI 交互层的，RPC 的 get_commands
 * 只返回 extension / prompt 模板 / skill 三类——所以 `/` 菜单永远看不到它们，
 * 直接把 `/compact` 当消息发也只会被模型当普通文本。这里维护一份「后端命令面
 * 已支持、且在 Web 上有意义」的原生命令白名单：菜单展示与提交路由共用同一份表，
 * 不会出现菜单里有、发送时不认识（或反过来）的错位。
 *
 * 与 skill 重名时原生命令优先——与 Pi TUI 的命令优先级一致。
 */
const NATIVE_COMMANDS: Record<string, string> = {
  compact: "压缩上下文（可在命令后附要求，如 /compact 保留代码示例）",
  abort_compaction: "中止正在进行的上下文压缩",
};

/** 提交文本解析：命中原生命令时返回命令名与余文参数（整词匹配，/compactx 不算）。 */
export function parseNativeCommand(message: string): { name: string; args: string } | null {
  const match = /^\/([a-z_]+)(?:\s+([\s\S]*))?$/.exec(message);
  if (!match || !(match[1] in NATIVE_COMMANDS)) return null;
  return { name: match[1], args: (match[2] ?? "").trim() };
}

/**
 * 按运行态过滤菜单项：compact 常驻（运行中提交会得到后端 409 的明确文案，
 * 而不是把命令发给模型）；abort_compaction 只在压缩进行中出现。
 */
export function nativeCommandsFor(runtime: Runtime | null): SlashCommand[] {
  const commands: SlashCommand[] = [{ name: "compact", description: NATIVE_COMMANDS.compact }];
  if (runtime?.isCompacting) {
    commands.push({ name: "abort_compaction", description: NATIVE_COMMANDS.abort_compaction });
  }
  return commands;
}
