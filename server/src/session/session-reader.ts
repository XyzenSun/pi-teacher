// 参考 pi-web v0.9.0 lib/session-reader.ts（MIT License）按平铺布局重写。
// pi-teacher 的差异：会话文件平铺在工作区目录（无 .pi/sessions 树）、无
// subagent 关系、无 worktree 项目信息，所以只需要 pi-web 里的四个原语：
// 读 header、读 entries、切活动分支、从 entries 还原前端消息流。
import { promises as fs, closeSync, existsSync, openSync, readSync, statSync } from "node:fs";
import type {
  AgentMessage,
  SessionEntry,
} from "../bridge/types.ts";
import type Database from "better-sqlite3";

// ============================================================================
// 会话文件类型（mirror pi-web lib/types.ts 的会话部分）
// ============================================================================

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

// ============================================================================
// 受限读取（pi-web readBoundedLines 的 Linux 等价实现，语义一致）
// ============================================================================

const SESSION_HEADER_MAX_BYTES = 64 * 1024;

function readBoundedLines(filePath: string, maxBytes: number, maxLines: number): string[] {
  const fd = openSync(filePath, "r");
  try {
    const chunks: Buffer[] = [];
    let position = 0;
    let newlineCount = 0;
    let reachedEof = false;

    while (position < maxBytes && newlineCount < maxLines) {
      const buffer = Buffer.allocUnsafe(Math.min(4096, maxBytes - position));
      const bytesRead = readSync(fd, buffer, 0, buffer.length, position);
      if (bytesRead === 0) {
        reachedEof = true;
        break;
      }
      position += bytesRead;
      const data = buffer.subarray(0, bytesRead);
      let end = data.length;
      for (let index = 0; index < data.length; index += 1) {
        if (data[index] !== 0x0a) continue;
        newlineCount += 1;
        if (newlineCount === maxLines) {
          end = index + 1;
          break;
        }
      }
      chunks.push(data.subarray(0, end));
    }

    const source = Buffer.concat(chunks).toString("utf8");
    const lines = source.split("\n");
    if (!reachedEof && !source.endsWith("\n")) lines.pop();
    if (lines.at(-1) === "") lines.pop();
    return lines.map((line) => line.endsWith("\r") ? line.slice(0, -1) : line);
  } finally {
    closeSync(fd);
  }
}

export function readSessionHeader(filePath: string): SessionHeader | null {
  const firstLine = readBoundedLines(filePath, SESSION_HEADER_MAX_BYTES, 1)[0]?.trimEnd();
  if (!firstLine) return null;
  try {
    const header = JSON.parse(firstLine) as SessionHeader;
    return header.type === "session" ? header : null;
  } catch {
    return null;
  }
}

/** 全量读 entries：逐行 JSON.parse，坏行跳过（pi-web parseSessionEntries 同语义）。 */
export async function readSessionEntries(filePath: string): Promise<SessionEntry[]> {
  let content: string;
  try {
    content = await fs.readFile(filePath, "utf8");
  } catch {
    return [];
  }
  return content
    .split("\n")
    .flatMap((line) => {
      if (!line.trim()) return [];
      try {
        return [JSON.parse(line) as SessionEntry];
      } catch {
        return [];
      }
    });
}

// ============================================================================
// 活动分支与消息还原
// ============================================================================

/**
 * 从 leafId 沿 parentId 回溯到根，取最近 tail 条（iterative 防栈溢出，
 * pi-web sliceActiveBranch 同逻辑）。leafId 为空取最后一条 entry。
 */
export function sliceActiveBranch(
  entries: SessionEntry[],
  leafId: string | null,
  tail: number,
  excludeLeaf = false,
): SessionEntry[] {
  if (tail <= 0) return entries;
  const byId = new Map<string, SessionEntry>();
  for (const e of entries) byId.set(e.id, e);

  let leaf = leafId ? byId.get(leafId) : entries[entries.length - 1];
  if (excludeLeaf) leaf = leaf?.parentId ? byId.get(leaf.parentId) : undefined;
  if (!leaf) return [];
  const chain: SessionEntry[] = [];
  let current: SessionEntry | undefined = leaf;
  while (current && chain.length < tail) {
    chain.push(current);
    current = current.parentId ? byId.get(current.parentId) : undefined;
  }
  chain.reverse();
  return chain;
}

function getSessionSettings(
  entries: SessionEntry[],
  leafId?: string | null,
): Pick<SessionContext, "thinkingLevel" | "model"> {
  if (leafId === null) return { thinkingLevel: "off", model: null };
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  let current = leafId ? byId.get(leafId) : undefined;
  current ??= entries[entries.length - 1];
  let thinkingLevel: string | undefined;
  let model: SessionContext["model"] | undefined;

  while (current && (thinkingLevel === undefined || model === undefined)) {
    if (thinkingLevel === undefined && current.type === "thinking_level_change") {
      thinkingLevel = (current as { thinkingLevel?: string }).thinkingLevel;
    }
    if (model === undefined && current.type === "model_change") {
      const change = current as { provider?: string; modelId?: string };
      if (typeof change.provider === "string" && typeof change.modelId === "string") {
        model = { provider: change.provider, modelId: change.modelId };
      }
    } else if (model === undefined && current.type === "message") {
      const message = (current as { message?: { role?: string; provider?: unknown; model?: unknown } }).message;
      if (message?.role === "assistant" && typeof message.provider === "string" && typeof message.model === "string") {
        model = { provider: message.provider, modelId: message.model };
      }
    }
    current = current.parentId ? byId.get(current.parentId) : undefined;
  }

  return { thinkingLevel: thinkingLevel ?? "off", model: model ?? null };
}

/** entry → 前端消息：message 类型直接取，其余类型（压缩条目等）过滤。 */
function entryToMessage(entry: SessionEntry): AgentMessage | null {
  if (entry.type !== "message") return null;
  return (entry as { message: AgentMessage }).message;
}

export function buildSessionContext(
  entries: SessionEntry[],
  leafId: string | null = null,
  tail = 0,
): SessionContext {
  const sliced = leafId === null
    ? []
    : sliceActiveBranch(entries, leafId, tail && tail > 0 ? tail : entries.length);
  const hasMore = Boolean(tail && tail > 0 && sliced[0]?.parentId);

  const messages: AgentMessage[] = [];
  const entryIds: string[] = [];
  for (const entry of sliced) {
    const message = entryToMessage(entry);
    if (message) {
      messages.push(message);
      entryIds.push(entry.id);
    }
  }

  return {
    messages,
    entryIds,
    oldestEntryId: sliced[0]?.id ?? null,
    hasMore,
    ...getSessionSettings(entries, leafId),
  };
}

// ============================================================================
// pi_session 表桥接：按 jsonl 路径找数据库记录
// ============================================================================

/** 前端对话列表项：pi_session 行 + 文件系统信息拼装。 */
export interface ConversationListItem {
  id: number;              // pi_session.id
  piSessionKey: string;    // jsonl path（会话注册表 key）
  spaceId: number;
  name: string | null;
  enableMakeCard: number;
  agentsMdId: number;
  teachStyleId: number | null;
  reviewTopicId: number | null;
  createdAt: string;
  jsonlExists: boolean;
  messageCount: number;
  modifiedAt: string | null;
}

export interface PiSessionRow {
  id: number;
  session_id: number | null;
  space_id: number;
  name: string | null;
  path: string;
  agents_md_id: number;
  teach_style_id: number | null;
  enable_make_card: number;
  review_topic_id: number | null;
  created_at: string;
}

/**
 * 列出对话（pi_session 行 + 文件系统状态）。
 * messageCount 与 modifiedAt 做成调用方可选填充：列表页不读 jsonl 全文
 * （省 IO），点开对话时才有上下文接口；这里用 mtime 做排序字段。
 */
export function listConversations(db: Database.Database, workspacePath: string | null): ConversationListItem[] {
  const rows = workspacePath
    ? (db.prepare("SELECT * FROM pi_session WHERE path LIKE ? ESCAPE '\\' ORDER BY id DESC").all(escapeLike(workspacePath) + "%") as PiSessionRow[])
    : (db.prepare("SELECT * FROM pi_session ORDER BY id DESC").all() as PiSessionRow[]);

  return rows.map((row) => {
    let modifiedAt: string | null = null;
    try {
      modifiedAt = statSync(row.path).mtime.toISOString();
    } catch {
      // jsonl 未落盘（Pi 延迟首刷）或被清理：modifiedAt 留空
    }
    return {
      id: row.id,
      piSessionKey: row.path,
      spaceId: row.space_id,
      name: row.name,
      enableMakeCard: row.enable_make_card,
      agentsMdId: row.agents_md_id,
      teachStyleId: row.teach_style_id,
      reviewTopicId: row.review_topic_id,
      createdAt: row.created_at,
      jsonlExists: existsSync(row.path),
      messageCount: 0,
      modifiedAt,
    };
  });
}

/** LIKE 转义：路径含 _ % 时防误匹配（sqlite 默认 LIKE 大小写不敏感也无妨）。 */
function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}
