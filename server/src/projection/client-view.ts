import os from "node:os";
import type { PiSessionRow } from "../db/types.ts";

/**
 * SDK 工具结果也可能包含真实 cwd/path，不能只过滤会话列表字段。
 * HTTP 与 SSE 共用展示投影：私有文件显示相对路径，JSONL 身份显示业务 ID；
 * 不改 SDK 的内存消息和持久化内容，模型仍使用真实文件路径。
 */
export function clientView<T>(value: T, row: PiSessionRow, homeDir: string): T {
  const project = (input: unknown): unknown => {
    if (typeof input === "string") {
      return input.replaceAll(row.path, `[Pi Session #${row.id} 历史]`)
        .replaceAll(`${row.work_path}/`, "")
        .replaceAll(row.work_path, ".")
        .replaceAll(`${homeDir}/`, "pi-teacher/")
        .replaceAll(homeDir, "pi-teacher")
        .replaceAll(`${os.homedir()}/`, "~/");
    }
    if (Array.isArray(input)) return input.map(project);
    if (input && typeof input === "object") {
      return Object.fromEntries(Object.entries(input).filter(([key]) => !["sessionFile", "sourceInfo"].includes(key)).map(([key, field]) => [key, project(field)]));
    }
    return input;
  };
  return project(value) as T;
}
