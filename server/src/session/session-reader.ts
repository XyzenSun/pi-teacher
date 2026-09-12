// 参考 pi-web session-reader（MIT）：活动分支回溯、分页与消息规范化。
import { promises as fs, closeSync, openSync, readSync, statSync } from "node:fs";
import type Database from "better-sqlite3";
import type { AgentMessage, SessionEntry } from "../bridge/types.ts";
import { normalizeToolCalls } from "../bridge/normalize.ts";
import { listPiSessionRows } from "./repository.ts";
import type { PiSessionRow } from "../db/types.ts";
export type { PiSessionRow } from "../db/types.ts";

export interface SessionHeader {
  type: "session";
  version?: number;
  id: string;
  timestamp: string;
  cwd: string;
  parentSession?: string;
}

export interface SessionContext {
  messages: AgentMessage[];
  entryIds: string[];
  oldestEntryId: string | null;
  hasMore: boolean;
  thinkingLevel: string;
  model: { provider: string; modelId: string } | null;
}

/** 仅读首行，扫描目录时不把整条长对话读进内存。 */
export function readSessionHeader(filePath: string): SessionHeader | null {
  const descriptor = openSync(filePath, "r");
  try {
    const buffer = Buffer.alloc(64 * 1024);
    const length = readSync(descriptor, buffer, 0, buffer.length, 0);
    const text = buffer.subarray(0, length).toString("utf8");
    const firstLine = text.split("\n", 1)[0];
    if (!firstLine || (!text.includes("\n") && length === buffer.length)) return null;
    const header = JSON.parse(firstLine) as SessionHeader;
    return header.type === "session" ? header : null;
  } catch {
    return null;
  } finally {
    closeSync(descriptor);
  }
}

/** 文件读失败与空历史分开；只有 SDK 尚未落盘的 ENOENT 可当作空历史。 */
export async function readSessionEntries(filePath: string): Promise<SessionEntry[]> {
  let content: string;
  try {
    content = await fs.readFile(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  return content.split("\n").flatMap((line) => {
    if (!line.trim()) return [];
    try {
      const entry = JSON.parse(line) as SessionEntry;
      return entry.type !== "session" && typeof entry.id === "string" ? [entry] : [];
    } catch {
      // 流式写入期间末尾可能只有半行，下次权威同步会读到完整条目。
      return [];
    }
  });
}

/** undefined 表示当前叶子，null 表示空分支；before 分页排除游标本身。 */
export function sliceActiveBranch(
  entries: SessionEntry[],
  leafId: string | null | undefined,
  tail: number,
  excludeLeaf = false,
): SessionEntry[] {
  if (leafId === null) return [];
  const byId = new Map(entries.filter((entry) => entry.type !== "session").map((entry) => [entry.id, entry]));
  let current = leafId === undefined ? Array.from(byId.values()).at(-1) : byId.get(leafId);
  if (excludeLeaf) current = current?.parentId ? byId.get(current.parentId) : undefined;
  const chain: SessionEntry[] = [];
  const visited = new Set<string>();
  while (current && !visited.has(current.id) && (tail <= 0 || chain.length < tail)) {
    visited.add(current.id);
    chain.push(current);
    current = current.parentId ? byId.get(current.parentId) : undefined;
  }
  return chain.reverse();
}

function sessionSettings(entries: SessionEntry[]): Pick<SessionContext, "model" | "thinkingLevel"> {
  let thinkingLevel = "off";
  let model: SessionContext["model"] = null;
  for (const entry of sliceActiveBranch(entries, undefined, 0)) {
    if (entry.type === "thinking_level_change" && typeof entry.thinkingLevel === "string") thinkingLevel = entry.thinkingLevel;
    if (entry.type === "model_change" && typeof entry.provider === "string" && typeof entry.modelId === "string") {
      model = { provider: entry.provider, modelId: entry.modelId };
    }
  }
  return { thinkingLevel, model };
}

export function buildSessionContext(
  entries: SessionEntry[],
  leafId: string | null | undefined = undefined,
  tail = 60,
  excludeLeaf = false,
): SessionContext {
  const sliced = sliceActiveBranch(entries, leafId, tail, excludeLeaf);
  const messages: AgentMessage[] = [];
  const entryIds: string[] = [];
  for (const entry of sliced) {
    if (entry.type === "message") {
      messages.push(normalizeToolCalls((entry as { message: AgentMessage }).message));
      entryIds.push(entry.id);
    } else if ((entry.type === "compaction" || entry.type === "branch_summary") && typeof entry.summary === "string") {
      messages.push({ role: "custom", customType: "compactionSummary", content: entry.summary, display: true });
      entryIds.push(entry.id);
    }
  }
  return {
    messages, entryIds,
    oldestEntryId: sliced[0]?.id ?? null,
    hasMore: Boolean(sliced[0]?.parentId && entries.some((entry) => entry.id === sliced[0].parentId)),
    ...sessionSettings(entries),
  };
}

/** HTTP 只暴露稳定业务 ID 和列表字段，部署路径留在服务端。 */
export function conversationView(row: PiSessionRow) {
  let modifiedAt: string | null = null;
  try {
    modifiedAt = statSync(row.path).mtime.toISOString();
  } catch {
    // 列表仍保留记录，打开缺失文件时再给明确错误，不静默创建新会话。
  }
  return {
    id: row.id,
    spaceId: row.space_id,
    spaceType: row.space_type,
    name: row.name,
    enableMakeCard: row.enable_make_card === 1,
    agentsMdId: row.agents_md_id,
    teachStyleId: row.teach_style_id,
    reviewTopicId: row.review_topic_id,
    createdAt: row.created_at,
    modifiedAt,
  };
}

export function listConversations(db: Database.Database, spaceId?: number) {
  return listPiSessionRows(db, spaceId).map(conversationView);
}
