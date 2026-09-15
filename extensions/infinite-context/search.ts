import type { Forest } from "./forest.ts";
import { allItems } from "./forest.ts";
import type { OriginalMessage } from "./messages.ts";
import { serializeMessage } from "./messages.ts";

export const SEARCH_MATCHES_PER_ITEM = 5;
export const SEARCH_MATCHES_PER_PATTERN = 50;
const SEARCH_LINE_CHARS = 240;

export interface SearchHit {
  readonly id: string;
  readonly kind: "message" | "fold";
  readonly role: string;
  readonly parentFoldId: string | null;
  readonly matches: readonly { line: number; text: string }[];
  readonly omittedMatches: number;
}

export interface SearchResult {
  readonly hits: readonly SearchHit[];
  readonly totalMatchingLines: number;
  readonly totalMatchingItems: number;
  readonly capped: boolean;
}

export function compilePattern(source: string): RegExp {
  if (!source) throw new SyntaxError("pattern is empty (it would match every line)");
  return new RegExp(source, "i");
}

function previewLine(line: string, matchIndex: number): string {
  let start = Math.max(0, matchIndex - 60);
  let end = Math.min(line.length, start + SEARCH_LINE_CHARS);
  if (start > 0 && /[\uDC00-\uDFFF]/.test(line[start])) --start;
  if (end < line.length && /[\uD800-\uDBFF]/.test(line[end - 1])) --end;
  return `${start ? "…" : ""}${line.slice(start, end).replace(/\s+/g, " ").trim()}${end < line.length ? "…" : ""}`;
}

/** Search each original and each reachable fold summary exactly once. */
export function searchArchive(
  originals: readonly OriginalMessage[],
  roots: Forest,
  pattern: RegExp,
): SearchResult {
  const parentById = new Map<string, string | null>();
  const pending = roots.map((item) => ({ item, parent: null as string | null })).reverse();
  while (pending.length) {
    const { item, parent } = pending.pop()!;
    parentById.set(item.id, parent);
    if (item.kind === "fold")
      for (let i = item.children.length - 1; i >= 0; --i)
        pending.push({ item: item.children[i], parent: item.id });
  }
  const records: Array<{
    id: string;
    kind: "message" | "fold";
    role: string;
    parentFoldId: string | null;
    text: string;
  }> = originals.map(({ id, message }) => ({
    id,
    kind: "message",
    role: message.role,
    parentFoldId: parentById.get(id) ?? null,
    text: serializeMessage(message),
  }));
  for (const item of allItems(roots)) {
    if (item.kind !== "fold") continue;
    records.push({
      id: item.id,
      kind: "fold",
      role: "fold summary",
      parentFoldId: parentById.get(item.id) ?? null,
      text: item.summary,
    });
  }

  const hits: SearchHit[] = [];
  let totalMatchingLines = 0;
  let totalMatchingItems = 0;
  let emitted = 0;
  for (const record of records) {
    const matches: { line: number; text: string }[] = [];
    let itemMatches = 0;
    const lines = record.text.split("\n");
    for (let i = 0; i < lines.length; ++i) {
      const match = pattern.exec(lines[i]);
      if (!match) continue;
      ++itemMatches;
      if (matches.length < SEARCH_MATCHES_PER_ITEM && emitted < SEARCH_MATCHES_PER_PATTERN) {
        matches.push({ line: i + 1, text: previewLine(lines[i], match.index) });
        ++emitted;
      }
    }
    if (!itemMatches) continue;
    totalMatchingLines += itemMatches;
    ++totalMatchingItems;
    if (matches.length)
      hits.push({ ...record, matches, omittedMatches: itemMatches - matches.length });
  }
  return {
    hits,
    totalMatchingLines,
    totalMatchingItems,
    capped: emitted >= SEARCH_MATCHES_PER_PATTERN && emitted < totalMatchingLines,
  };
}
