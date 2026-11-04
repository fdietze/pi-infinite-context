import { copyFileSync, constants, readFileSync, renameSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { assertSupportedBranch } from "../extensions/infinite-context/assert-supported-branch.ts";
import {
  INFINITE_CONTEXT_ENTRY,
  originalIds,
  parseSnapshot,
  syncOriginals,
  type Item,
} from "../extensions/infinite-context/forest.ts";
import { branchOriginals } from "../extensions/infinite-context/originals.ts";

/**
 * Repairs a Pi session file whose append was interrupted (for example by a full disk):
 * Pi keeps running on its in-memory entries, so the file ends up with a torn line, the next
 * entry glued to its end, and entries whose parents were never written. Those gaps make
 * `assertSupportedBranch` and `syncOriginals` (extensions/infinite-context) reject the branch.
 *
 * The repair is a pure text transform (Functional Core); the CLI below does the file I/O and
 * proves the result with the extension's own checks (Imperative Shell, Correctness by Construction).
 */

interface Entry {
  id: string;
  type: string;
  parentId?: string | null;
  customType?: string;
  data?: { roots?: Item[] };
  [key: string]: unknown;
}

/** `raw` is the original line; it is dropped when the entry changes so intact lines stay byte-identical. */
interface Line {
  entry: Entry;
  raw: string | undefined;
}

// Pi writes `type`, `id`, `parentId` first in every entry (session-manager.js), so a header
// match inside a torn line marks where the next entry starts.
const ENTRY_HEADER = /\{"type":"[a-z_]+","id":"[0-9a-f]+","parentId":/g;

function parseEntry(text: string): Entry | undefined {
  try {
    const value: unknown = JSON.parse(text);
    return value && typeof value === "object" && typeof (value as Entry).id === "string"
      ? (value as Entry)
      : undefined;
  } catch {
    return undefined;
  }
}

/** Keep every intact entry, including those glued to the end of a torn line. */
function readLines(text: string, notes: string[]): Line[] {
  const lines: Line[] = [];
  text.split("\n").forEach((raw, index) => {
    if (!raw.trim()) return;
    const whole = parseEntry(raw);
    if (whole) return void lines.push({ entry: whole, raw });
    // A torn line is a cut-off entry, so only the pieces after it can be intact.
    const starts = [...raw.matchAll(ENTRY_HEADER)].map((match) => match.index).filter((start) => start > 0);
    const pieces = starts.map((start, i) => raw.slice(start, starts[i + 1]));
    const kept = pieces.flatMap((piece) => parseEntry(piece) ?? []);
    kept.forEach((entry, i) => lines.push({ entry, raw: pieces[i] }));
    notes.push(`line ${index + 1}: dropped a torn entry, kept ${kept.length} glued entries`);
  });
  return lines;
}

/** The ids of every snapshot's archive leaves, in file order. */
function snapshotOrders(lines: readonly Line[]): string[][] {
  return lines.flatMap(({ entry }) => {
    if (entry.type !== "custom" || entry.customType !== INFINITE_CONTEXT_ENTRY) return [];
    try {
      return [originalIds(parseSnapshot(entry.data).roots)];
    } catch {
      return [];
    }
  });
}

/**
 * A snapshot records the branch order, so the nearest surviving predecessor of a lost entry in
 * the latest snapshot that knew it is where the branch really continued (The Map Is Not the
 * Territory: the file order of a gapped file is not reliable). Without a snapshot the previous
 * file entry is the best guess; `verifySession` catches a wrong one.
 */
function survivingPredecessor(lost: string, orders: readonly string[][], present: ReadonlySet<string>): string | undefined {
  const order = [...orders].reverse().find((ids) => ids.includes(lost));
  return order && order.slice(0, order.indexOf(lost)).reverse().find((id) => present.has(id));
}

function withoutLost(items: readonly Item[], present: ReadonlySet<string>): Item[] {
  return items.flatMap((item): Item[] => {
    if (item.kind === "message") return present.has(item.id) ? [item] : [];
    const children = withoutLost(item.children, present);
    return children.length ? [{ ...item, children }] : [];
  });
}

export function repairSession(text: string): { text: string; notes: string[] } {
  const notes: string[] = [];
  const lines = readLines(text, notes);
  const present = new Set(lines.map(({ entry }) => entry.id));
  const orders = snapshotOrders(lines);

  lines.forEach((line, i) => {
    const { entry } = line;
    // Pi's branch walk treats a falsy parentId as the root.
    if (!entry.parentId || present.has(entry.parentId)) return;
    const parent = survivingPredecessor(entry.parentId, orders, present) ?? lines[i - 1]?.entry.id ?? null;
    notes.push(`entry ${entry.id}: lost parent ${entry.parentId}, now ${parent}`);
    line.entry = { ...entry, parentId: parent };
    line.raw = undefined;
  });

  for (const line of lines) {
    const { entry } = line;
    if (entry.type !== "custom" || entry.customType !== INFINITE_CONTEXT_ENTRY || !entry.data?.roots) continue;
    const roots = withoutLost(entry.data.roots, present);
    if (originalIds(roots).length === originalIds(entry.data.roots).length) continue;
    notes.push(`snapshot ${entry.id}: dropped lost archive leaves`);
    line.entry = { ...entry, data: { ...entry.data, roots } };
    line.raw = undefined;
  }

  const output = lines.map(({ entry, raw }) => raw ?? JSON.stringify(entry)).join("\n");
  return { text: output ? `${output}\n` : "", notes };
}

/** Load the file like Pi does and run the extension's own branch and snapshot checks; throws on failure. */
export function verifySession(path: string): void {
  const session = SessionManager.open(path);
  const branch = session.getBranch();
  assertSupportedBranch(branch);
  let saved: unknown;
  for (const entry of branch)
    if (entry.type === "custom" && entry.customType === INFINITE_CONTEXT_ENTRY) saved = entry.data;
  if (!saved) return;
  const originals = branchOriginals(branch, session.buildSessionProjection());
  syncOriginals(parseSnapshot(saved).roots, originals.map(({ id }) => id));
}

/** The original file is replaced only after the repaired copy passes `verifySession`. */
function repairFile(path: string): void {
  const { text, notes } = repairSession(readFileSync(path, "utf8"));
  console.log(notes.length ? notes.join("\n") : "nothing to repair");
  if (!notes.length) return;
  const repaired = `${path}.repaired`;
  writeFileSync(repaired, text);
  verifySession(repaired);
  copyFileSync(path, `${path}.bak`, constants.COPYFILE_EXCL);
  renameSync(repaired, path);
  console.log(`repaired; original saved as ${path}.bak`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const path = process.argv[2];
  if (!path) {
    console.error("usage: node scripts/repair-session.ts <session.jsonl>");
    process.exit(2);
  }
  repairFile(path);
}
