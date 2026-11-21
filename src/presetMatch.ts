// Header matching for file formats and their saved column settings. Pure (no
// DOM / Node APIs) so both the extension and the webview use it.

// Two headers lists are the same file format when at least this share of
// columns match (see formatMatchRatio).
export const FORMAT_MATCH_RATIO = 0.8;

export type MatchResult = number | 'missing' | 'ambiguous';

// Finds the column a saved header refers to. Tried in order, the first stage
// with any candidate decides: exactly one -> that column, several ->
// 'ambiguous' (looser stages would only add more):
//   1. case-sensitive, whole header equal
//   2. case-sensitive, column header contains it
//   3. case-insensitive, column header contains it
export function matchHeader(header: string, headers: string[]): MatchResult {
  const lower = header.toLowerCase();
  const stages: Array<(h: string) => boolean> = [
    h => h === header,
    h => h.includes(header),
    h => h.toLowerCase().includes(lower),
  ];
  for (const test of stages) {
    let found = -1;
    for (let i = 0; i < headers.length; i++) {
      if (!test(headers[i])) continue;
      if (found >= 0) return 'ambiguous';
      found = i;
    }
    if (found >= 0) return found;
  }
  return 'missing';
}

export type Resolved = { map: Map<string, number>; missing: string[]; ambiguous: string[] };

export function resolveHeaders(refs: string[], headers: string[]): Resolved {
  const map = new Map<string, number>();
  const missing: string[] = [];
  const ambiguous: string[] = [];
  for (const ref of refs) {
    const r = matchHeader(ref, headers);
    if (r === 'missing') missing.push(ref);
    else if (r === 'ambiguous') ambiguous.push(ref);
    else map.set(ref, r);
  }
  return { map, missing, ambiguous };
}

// Share of columns the two header lists have in common: distinct file columns
// matched by the format's headers, over the longer of the two lists (so a
// small file whose few columns all appear in a big format doesn't count as
// that format).
export function formatMatchRatio(formatHeaders: string[], fileHeaders: string[]): number {
  const n = Math.max(formatHeaders.length, fileHeaders.length);
  if (n === 0) return 0;
  const cols = new Set<number>();
  for (const h of formatHeaders) {
    const r = matchHeader(h, fileHeaders);
    if (typeof r === 'number') cols.add(r);
  }
  return cols.size / n;
}

// Headers that name exactly one column of the file — the only ones a saved
// setting can refer to.
export function isUniqueHeader(header: string, headers: string[]): boolean {
  let n = 0;
  for (const h of headers) if (h === header && ++n > 1) return false;
  return n === 1;
}
