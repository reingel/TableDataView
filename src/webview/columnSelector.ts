const selectedColumns = new Set<number>();
let lastClickedIndex: number | null = null;
let totalColumns = 0;
let onSelectionChange: (() => void) | null = null;

// Sentinel meaning "use the row sequence number (1, 2, ...) as the x-axis"
// instead of a real column. xAxisCol holds either a column index (>= 0) or SEQ_X.
export const SEQ_X = -1;
let xAxisCol: number = SEQ_X;
let defaultXAxisCol: number = SEQ_X;

const X_HEADER_PATTERN = /^(time|times|t|sec|secs|second|seconds|ms|msec|msecs|date|datetime|timestamp|ts|index|idx|no|num|n|count|sample|samples|step|steps|frame|frames|epoch|iter|iteration|x)$/i;

function isMonotonicNumeric(rows: string[][], col: number): boolean {
  const lim = Math.min(rows.length, 500);
  if (lim < 2) return false;
  let prev = parseFloat(rows[0]?.[col]);
  if (!isFinite(prev)) return false;
  let increased = false;
  for (let i = 1; i < lim; i++) {
    const v = parseFloat(rows[i]?.[col]);
    if (!isFinite(v)) return false;
    if (v < prev) return false;
    if (v > prev) increased = true;
    prev = v;
  }
  return increased;
}

// The first column is treated as the x-axis only when it looks like an index or
// time axis: either its header matches a known keyword, or its values are numeric
// and monotonically increasing. Otherwise the x-axis defaults to the row sequence.
export function detectDefaultXAxis(headers: string[], rows: string[][]): number {
  if (headers.length === 0) return SEQ_X;
  const h = (headers[0] ?? '').trim().toLowerCase();
  if (X_HEADER_PATTERN.test(h) || h.includes('time') || h.includes('date')) return 0;
  if (isMonotonicNumeric(rows, 0)) return 0;
  return SEQ_X;
}

export function init(colCount: number, onChange: () => void, defaultXAxis: number = SEQ_X): void {
  totalColumns = colCount;
  onSelectionChange = onChange;
  selectedColumns.clear();
  defaultXAxisCol = defaultXAxis;
  xAxisCol = defaultXAxis;
  if (colCount > 0) selectedColumns.add(0);
  if (xAxisCol >= 0) selectedColumns.add(xAxisCol);
  lastClickedIndex = null;
}

export function getSelected(): number[] {
  return Array.from(selectedColumns);
}

export function getXAxisCol(): number {
  return xAxisCol;
}

export function getDefaultXAxisCol(): number {
  return defaultXAxisCol;
}

export function setXAxisCol(col: number): void {
  if (xAxisCol >= 0) selectedColumns.delete(xAxisCol);
  xAxisCol = col;
  if (xAxisCol >= 0) selectedColumns.add(xAxisCol);
  applyHighlight();
  onSelectionChange?.();
}

export function resetXAxis(): void {
  xAxisCol = defaultXAxisCol;
  if (xAxisCol >= 0) selectedColumns.add(xAxisCol);
  applyHighlight();
  onSelectionChange?.();
}

export function handleColumnClick(colIndex: number, event: MouseEvent): void {
  if (event.shiftKey && lastClickedIndex !== null) {
    const lo = Math.min(lastClickedIndex, colIndex);
    const hi = Math.max(lastClickedIndex, colIndex);
    for (let i = lo; i <= hi; i++) selectedColumns.add(i);
  } else if (event.ctrlKey || event.metaKey) {
    if (selectedColumns.has(colIndex)) selectedColumns.delete(colIndex);
    else selectedColumns.add(colIndex);
  } else {
    selectedColumns.clear();
    selectedColumns.add(colIndex);
  }
  if (xAxisCol >= 0) selectedColumns.add(xAxisCol);
  lastClickedIndex = colIndex;
  applyHighlight();
  onSelectionChange?.();
}

export function applyHighlight(): void {
  for (let i = 0; i < totalColumns; i++) {
    const cells = document.querySelectorAll<HTMLElement>(`[data-col-index="${i}"]`);
    const isXAxis = i === xAxisCol;
    const isSelected = selectedColumns.has(i) && !isXAxis;
    cells.forEach(cell => {
      cell.classList.toggle('selected', isSelected);
      cell.classList.toggle('x-axis', isXAxis);
    });
  }
}

export function restoreSelection(cols: number[], xAxis: number): void {
  selectedColumns.clear();
  xAxisCol = xAxis;
  cols.forEach(c => { if (c < totalColumns) selectedColumns.add(c); });
  if (xAxisCol >= 0) selectedColumns.add(xAxisCol);
  applyHighlight();
  onSelectionChange?.();
}

export function reset(): void {
  selectedColumns.clear();
  xAxisCol = defaultXAxisCol;
  if (totalColumns > 0) selectedColumns.add(0);
  if (xAxisCol >= 0) selectedColumns.add(xAxisCol);
  lastClickedIndex = null;
  applyHighlight();
  onSelectionChange?.();
}
