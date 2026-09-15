import type { Forest, Item } from "./forest.ts";
import { originalIds } from "./forest.ts";

export type Content = string | Array<Record<string, unknown>>;

export interface AgentMessageLike {
  role: string;
  content?: Content;
  timestamp?: number;
  details?: unknown;
  toolCallId?: string;
  toolName?: string;
  isError?: boolean;
  command?: string;
  output?: string;
  summary?: string;
  fromId?: string;
  tokensBefore?: number;
  customType?: string;
  display?: boolean;
  excludeFromContext?: boolean;
  exitCode?: number | null;
  cancelled?: boolean;
  truncated?: boolean;
  fullOutputPath?: string;
}

export interface BranchEntry {
  type: string;
  id?: string;
  timestamp?: string;
  customType?: string;
  data?: unknown;
  message?: AgentMessageLike;
  content?: Content;
  display?: boolean;
  details?: unknown;
  summary?: string;
  fromId?: string;
}

export interface OriginalMessage {
  readonly id: string;
  readonly message: AgentMessageLike;
}

const ADDRESSABLE_ROLES = new Set([
  "user",
  "assistant",
  "toolResult",
  "custom",
  "bashExecution",
  "branchSummary",
]);

/** Convert raw current-branch entries without applying native compaction. */
export function branchOriginals(branch: readonly BranchEntry[]): OriginalMessage[] {
  const output: OriginalMessage[] = [];
  for (const entry of branch) {
    if (!entry.id) continue;
    let message: AgentMessageLike | undefined;
    if (entry.type === "message") message = entry.message;
    else if (entry.type === "custom_message") {
      message = {
        role: "custom",
        customType: entry.customType,
        content: entry.content ?? [],
        display: entry.display,
        details: entry.details,
        timestamp: entry.timestamp ? new Date(entry.timestamp).getTime() : undefined,
      };
    } else if (entry.type === "branch_summary" && typeof entry.summary === "string") {
      message = {
        role: "branchSummary",
        summary: entry.summary,
        fromId: entry.fromId,
        timestamp: entry.timestamp ? new Date(entry.timestamp).getTime() : undefined,
      };
    }
    if (message && ADDRESSABLE_ROLES.has(message.role))
      output.push({ id: entry.id, message });
  }
  return output;
}

const IMAGE_ESTIMATED_CHARS = 4800;

/** Authoritative text projection shared by lookup and search. Binary image bytes stay in the session source. */
export function serializeMessage(message: AgentMessageLike): string {
  if (message.role === "branchSummary") return message.summary ?? "";
  if (message.role === "bashExecution") {
    let text = `Ran \`${message.command ?? ""}\`\n`;
    text += message.output ? `\`\`\`\n${message.output}\n\`\`\`` : "(no output)";
    if (message.cancelled) text += "\n\n(command cancelled)";
    else if (message.exitCode != null && message.exitCode !== 0)
      text += `\n\nCommand exited with code ${message.exitCode}`;
    if (message.truncated && message.fullOutputPath)
      text += `\n\n[Output truncated. Full output: ${message.fullOutputPath}]`;
    return text;
  }
  if (typeof message.content === "string") return message.content;
  if (!Array.isArray(message.content)) return "";
  const parts: string[] = [];
  for (const block of message.content) {
    if (typeof block.text === "string") parts.push(block.text);
    else if (typeof block.thinking === "string") parts.push(`(thinking) ${block.thinking}`);
    else if (block.type === "toolCall")
      parts.push(`(call ${String(block.name ?? "?")} ${JSON.stringify(block.arguments ?? {})})`);
    else if (block.type === "image")
      parts.push(`(image ${String(block.mimeType ?? block.mediaType ?? "unknown type")}; binary source preserved in session)`);
  }
  return parts.join("\n");
}

/** Pi-compatible rough estimate without pretending provider-exact tokenization. */
export function estimateContextTokens(message: AgentMessageLike): number {
  if (message.role === "bashExecution" && message.excludeFromContext) return 0;
  let chars = 0;
  if (["user", "custom", "toolResult"].includes(message.role)) {
    if (typeof message.content === "string") chars = message.content.length;
    else if (Array.isArray(message.content)) {
      for (const block of message.content) {
        if (typeof block.text === "string") chars += block.text.length;
        else if (block.type === "image") chars += IMAGE_ESTIMATED_CHARS;
      }
    }
  } else if (message.role === "assistant" && Array.isArray(message.content)) {
    for (const block of message.content) {
      if (typeof block.text === "string") chars += block.text.length;
      else if (typeof block.thinking === "string") chars += block.thinking.length;
      else if (block.type === "toolCall") {
        chars += typeof block.name === "string" ? block.name.length : 0;
        chars += JSON.stringify(block.arguments ?? {}).length;
      }
    }
  } else if (message.role === "bashExecution") {
    chars = (message.command?.length ?? 0) + (message.output?.length ?? 0);
  } else if (message.role === "branchSummary") chars = message.summary?.length ?? 0;
  return Math.ceil(chars / 4);
}

interface UnitBounds {
  readonly start: number[];
  readonly end: number[];
  readonly unfinished: ReadonlySet<number>;
}

/** Completed assistant call batches and all correlated results are indivisible. */
export function unitBounds(messages: readonly OriginalMessage[]): UnitBounds {
  const start = messages.map((_, i) => i);
  const end = messages.map((_, i) => i);
  const ownerByCall = new Map<string, number>();
  const callsByOwner = new Map<number, string[]>();
  for (let i = 0; i < messages.length; ++i) {
    const message = messages[i].message;
    if (message.role !== "assistant" || !Array.isArray(message.content)) continue;
    for (const block of message.content) {
      if (block.type === "toolCall" && typeof block.id === "string") {
        ownerByCall.set(block.id, i);
        const calls = callsByOwner.get(i) ?? [];
        calls.push(block.id);
        callsByOwner.set(i, calls);
      }
    }
  }
  const resultIndex = new Map<string, number>();
  for (let i = 0; i < messages.length; ++i) {
    const message = messages[i].message;
    if (message.role === "toolResult" && message.toolCallId)
      resultIndex.set(message.toolCallId, i);
  }
  const unfinished = new Set<number>();
  for (const [owner, calls] of callsByOwner) {
    const presentResults = calls
      .map((id) => resultIndex.get(id))
      .filter((index): index is number => index !== undefined);
    const last = Math.max(owner, ...presentResults);
    // Even a partial result batch is one unfinished unit. Mark its known range
    // so selecting a result cannot evade the unfinished-owner rejection.
    for (let i = owner; i <= last; ++i) {
      start[i] = owner;
      end[i] = last;
    }
    if (presentResults.length !== calls.length) unfinished.add(owner);
  }
  return { start, end, unfinished };
}

/** Reject persisted states that could project an orphan call or result. */
export function validateToolUnitOwnership(
  roots: Forest,
  originals: readonly OriginalMessage[],
): void {
  const rootByOriginal = new Map<string, { index: number; kind: Item["kind"] }>();
  for (let index = 0; index < roots.length; ++index)
    for (const id of originalIds([roots[index]]))
      rootByOriginal.set(id, { index, kind: roots[index].kind });
  const bounds = unitBounds(originals);
  for (let owner = 0; owner < originals.length; ++owner) {
    if (bounds.start[owner] !== owner || bounds.end[owner] === owner) {
      if (!bounds.unfinished.has(owner)) continue;
    }
    const members = originals.slice(owner, bounds.end[owner] + 1);
    const locations = members.map(({ id }) => rootByOriginal.get(id)!);
    if (bounds.unfinished.has(owner)) {
      if (locations.some((location) => location.kind === "fold"))
        throw new Error(
          "Snapshot folds an unfinished tool-call unit; start a new session",
        );
      continue;
    }
    const allLive = locations.every((location) => location.kind === "message");
    const oneFold =
      locations.every((location) => location.kind === "fold") &&
      locations.every((location) => location.index === locations[0].index);
    if (!allLive && !oneFold)
      throw new Error(
        "Snapshot splits an assistant tool call from its results; start a new session",
      );
  }
}

export interface RootRangeRequest {
  readonly from: string;
  readonly to?: string;
  readonly summary: string;
}

/** Resolve visible root ids, then expand ranges just enough to preserve whole completed tool units. */
export function planRootRanges(
  roots: Forest,
  originals: readonly OriginalMessage[],
  requests: readonly RootRangeRequest[],
): { first: number; last: number; summary: string }[] {
  if (requests.length === 0) throw new Error("At least one fold range is required");
  const rootIndex = new Map(roots.map((root, i) => [root.id, i] as const));
  const originalIndex = new Map(originals.map((message, i) => [message.id, i] as const));
  const rootOfOriginal = new Map<string, number>();
  for (let i = 0; i < roots.length; ++i)
    for (const id of originalIds([roots[i]])) rootOfOriginal.set(id, i);
  const bounds = unitBounds(originals);

  return requests.map((request) => {
    const a = rootIndex.get(request.from);
    const b = rootIndex.get(request.to ?? request.from);
    if (a === undefined || b === undefined)
      throw new Error("A fold endpoint is not a visible root");
    let first = Math.min(a, b);
    let last = Math.max(a, b);
    let changed = true;
    while (changed) {
      changed = false;
      const selectedIds = roots
        .slice(first, last + 1)
        .flatMap((root) => originalIds([root]));
      for (const id of selectedIds) {
        const index = originalIndex.get(id)!;
        const owner = bounds.start[index];
        if (bounds.unfinished.has(owner))
          throw new Error("Cannot fold an unfinished tool-call unit");
        const unitFirst = rootOfOriginal.get(originals[bounds.start[index]].id)!;
        const unitLast = rootOfOriginal.get(originals[bounds.end[index]].id)!;
        if (unitFirst < first) {
          first = unitFirst;
          changed = true;
        }
        if (unitLast > last) {
          last = unitLast;
          changed = true;
        }
      }
    }
    return { first, last, summary: request.summary };
  });
}

/** Overlay only the request copy; raw session messages remain untouched. */
export function buildOverlay(
  messages: AgentMessageLike[],
  originals: readonly OriginalMessage[],
  roots: Forest,
): AgentMessageLike[] {
  const byId = new Map(originals.map((original) => [original.id, original] as const));
  // Excluded bash entries remain searchable archive sources but cannot anchor a
  // synthetic fold projection: Pi would otherwise receive content it excluded.
  const projectionAnchor = new Map<Item, string>();
  for (const root of roots) {
    const anchor = originalIds([root]).find((id) => {
      const message = byId.get(id)!.message;
      return message.role !== "bashExecution" || !message.excludeFromContext;
    });
    if (anchor) projectionAnchor.set(root, anchor);
  }
  const rootByOriginal = new Map<string, Item>();
  for (const root of roots)
    for (const id of originalIds([root])) rootByOriginal.set(id, root);

  const queues = new Map<string, string[]>();
  const customQueues = new Map<string, string[]>();
  const customOriginalCounts = new Map<string, number>();
  const available = new Set(originals.map(({ id }) => id));
  const customKey = (message: AgentMessageLike) =>
    `${message.customType}|${serializeMessage(message)}`;
  const foldedCallIds = new Set<string>();
  for (const { id, message } of originals) {
    const key = `${message.timestamp}|${message.role}`;
    const queue = queues.get(key) ?? [];
    queue.push(id);
    queues.set(key, queue);
    if (message.role === "custom") {
      const fallback = customQueues.get(customKey(message)) ?? [];
      fallback.push(id);
      const key = customKey(message);
      customQueues.set(key, fallback);
      customOriginalCounts.set(key, (customOriginalCounts.get(key) ?? 0) + 1);
    }
    const root = rootByOriginal.get(id);
    if (root?.kind === "fold" && message.role === "assistant" && Array.isArray(message.content)) {
      for (const block of message.content)
        if (block.type === "toolCall" && typeof block.id === "string") foldedCallIds.add(block.id);
    }
  }

  const customEventCounts = new Map<string, number>();
  for (const message of messages) {
    if (message.role !== "custom") continue;
    const key = customKey(message);
    customEventCounts.set(key, (customEventCounts.get(key) ?? 0) + 1);
  }
  const take = (queue: string[] | undefined) => {
    while (queue?.length) {
      const id = queue.shift()!;
      if (available.delete(id)) return id;
    }
    return undefined;
  };
  const output: AgentMessageLike[] = [];
  for (const message of messages) {
    if (message.role === "toolResult" && message.toolCallId && foldedCallIds.has(message.toolCallId))
      continue;
    if (!ADDRESSABLE_ROLES.has(message.role)) {
      output.push(message);
      continue;
    }
    // Custom-message persistence timestamps are created independently from the
    // in-memory message timestamp. Fall back to its stable payload projection.
    const id =
      take(queues.get(`${message.timestamp}|${message.role}`)) ??
      (message.role === "custom" &&
      customOriginalCounts.get(customKey(message)) === 1 &&
      customEventCounts.get(customKey(message)) === 1
        ? take(customQueues.get(customKey(message)))
        : undefined);
    if (!id) {
      output.push(message);
      continue;
    }
    const root = rootByOriginal.get(id);
    if (!root || root.kind === "message") {
      output.push(message);
      continue;
    }
    if (projectionAnchor.get(root) !== id) continue;
    const count = originalIds([root]).length;
    output.push({
      role: "user",
      content: root.summary || `(folded archive: ${count} messages)`,
      timestamp: message.timestamp,
    });
  }
  return output;
}
