export const MAX_OUTPUT_BYTES = 48 * 1024;
export const MAX_OUTPUT_LINES = 2000;
export const DEFAULT_PAGE_LIMIT = 100;
export const MAX_PAGE_LIMIT = 2000;

export interface LineWindow {
  readonly text: string;
  readonly totalLines: number;
  readonly start: number;
  readonly end: number;
  readonly clippedLine: boolean;
}

function utf8Prefix(text: string, maxBytes: number): string {
  let low = 0;
  let high = text.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (Buffer.byteLength(text.slice(0, mid), "utf8") <= maxBytes) low = mid;
    else high = mid - 1;
  }
  // Never return half of a UTF-16 surrogate pair.
  if (low > 0 && low < text.length) {
    const code = text.charCodeAt(low - 1);
    if (code >= 0xd800 && code <= 0xdbff) --low;
  }
  return text.slice(0, low);
}

/** File-read line semantics with a byte reserve for an explicit clipping notice. */
export function lineWindow(
  text: string,
  offset = 1,
  limit = DEFAULT_PAGE_LIMIT,
  maxBytes = MAX_OUTPUT_BYTES,
): LineWindow {
  const lines = text.split("\n");
  if (offset > lines.length)
    return { text: "", totalLines: lines.length, start: offset, end: offset - 1, clippedLine: false };
  const selected = lines.slice(offset - 1, offset - 1 + limit);
  const joined = selected.join("\n");
  if (Buffer.byteLength(joined, "utf8") <= maxBytes) {
    return {
      text: joined,
      totalLines: lines.length,
      start: offset,
      end: offset + selected.length - 1,
      clippedLine: false,
    };
  }
  const marker = "… [line clipped by output byte cap]";
  const prefix = utf8Prefix(joined, Math.max(0, maxBytes - Buffer.byteLength(marker, "utf8")));
  const complete = prefix.split("\n");
  const clippedLine = !prefix.endsWith("\n");
  return {
    text: `${prefix}${marker}`,
    totalLines: lines.length,
    start: offset,
    end: offset + Math.max(1, complete.length) - 1,
    clippedLine,
  };
}

/** Final defense shared by every model-facing tool response. */
export function boundOutput(text: string): string {
  const lines = text.split("\n");
  let candidate = lines.slice(0, MAX_OUTPUT_LINES).join("\n");
  const truncatedLines = lines.length > MAX_OUTPUT_LINES;
  const marker = `\n… [tool output truncated${truncatedLines ? ` after ${MAX_OUTPUT_LINES} lines` : ""}]`;
  const budget = MAX_OUTPUT_BYTES - Buffer.byteLength(marker, "utf8");
  const truncatedBytes = Buffer.byteLength(candidate, "utf8") > budget;
  if (truncatedBytes) candidate = utf8Prefix(candidate, Math.max(0, budget));
  return truncatedLines || truncatedBytes ? `${candidate}${marker}` : candidate;
}

export function parsePage(offset: number | undefined, limit: number | undefined): { offset: number; limit: number } {
  const actualOffset = offset ?? 1;
  const actualLimit = limit ?? DEFAULT_PAGE_LIMIT;
  if (!Number.isSafeInteger(actualOffset) || actualOffset < 1)
    throw new Error("offset must be a positive safe integer");
  if (!Number.isSafeInteger(actualLimit) || actualLimit < 1 || actualLimit > MAX_PAGE_LIMIT)
    throw new Error(`limit must be a safe integer from 1 to ${MAX_PAGE_LIMIT}`);
  return { offset: actualOffset, limit: actualLimit };
}
