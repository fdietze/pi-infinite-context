import type { Forest, Item } from "./forest.ts";
import { type OriginalsById, anchorId, liveTokens, rootTokens } from "./fold-projection.ts";
import { MAX_OUTPUT_BYTES, fmtTokens } from "./output.ts";
import { previewMessage } from "./preview-message.ts";
import type { UnitsById } from "./tool-units.ts";

export const MAX_PREVIEW_CHARS = 40;

/** The first `chars` code points of `text` with whitespace collapsed; `…` marks a cut. */
export function cutPreview(text: string, chars: number): string {
  const points = [...(text.replace(/\s+/g, " ").trim() || "(empty)")];
  return points.length > chars ? `${points.slice(0, chars).join("")}…` : points.join("");
}

/**
 * One line per item, without its preview: the part that is never shortened. A tool call and its
 * results are one `call` line under the call's id: a fold always takes the whole unit
 * (plan-root-ranges.ts), so that id is the only one a fold range needs.
 */
function itemHead(item: Item, byId: OriginalsById, units: UnitsById): string {
  const members = item.kind === "message" ? units.members.get(item.id) : undefined;
  if (members) {
    const tokens = members.reduce((sum, id) => sum + liveTokens(byId.get(id)!), 0);
    return `${item.id} call ${fmtTokens(tokens)}`;
  }
  const cost = anchorId(item, byId) ? fmtTokens(rootTokens(item, byId)) : "not live";
  if (item.kind === "fold") return `${item.id} fold ${cost}`;
  return `${item.id} ${byId.get(item.id)!.message.role} ${cost}`;
}

function itemPreviewSource(item: Item, byId: OriginalsById): string {
  return item.kind === "fold" ? item.summary : previewMessage(byId.get(item.id)!.message);
}

/** Ids without a line of their own: the running unit, which no fold may include, and tool results, listed on their call's line. */
function unlistedIds(units: UnitsById): Set<string> {
  const unlisted = new Set(units.pending);
  for (const [, members] of units.members) for (const id of members.slice(1)) unlisted.add(id);
  return unlisted;
}

export interface MapListing {
  readonly text: string;
  /** Preview length actually used; below MAX_PREVIEW_CHARS when shortened to fit. */
  readonly previewChars: number;
}

/**
 * Lists every item in one response. Completeness beats detail: the map is the
 * id index, so previews shrink uniformly (down to none) until the listing fits
 * MAX_OUTPUT_BYTES. Ids are never dropped; if even the preview-less listing
 * exceeds the cap it is returned whole, since each line is a small fixed-size
 * entry for a root that already occupies context. Lines carry no brackets or
 * separators: every character is re-read on every later request.
 */
export function renderMap(label: string, items: Forest, byId: OriginalsById, units: UnitsById): MapListing {
  const unlisted = unlistedIds(units);
  const listed = items.filter((item) => item.kind === "fold" || !unlisted.has(item.id));
  const heads = listed.map((item) => itemHead(item, byId, units));
  const sources = listed.map((item) => itemPreviewSource(item, byId));
  const render = (chars: number) => {
    const rows = chars === 0 ? heads : heads.map((head, i) => `${head} ${cutPreview(sources[i], chars)}`);
    const note =
      chars === MAX_PREVIEW_CHARS ? "" : chars === 0 ? ", previews omitted to fit" : `, previews shortened to ${chars} chars to fit`;
    return [...rows, `${label}: ${listed.length} items${note}`].join("\n");
  };
  const fits = (text: string) => Buffer.byteLength(text, "utf8") <= MAX_OUTPUT_BYTES;
  // Byte size grows monotonically with the preview length: binary search the largest that fits.
  let low = 0;
  let high = MAX_PREVIEW_CHARS;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (fits(render(mid))) low = mid;
    else high = mid - 1;
  }
  return { text: render(low), previewChars: low };
}
