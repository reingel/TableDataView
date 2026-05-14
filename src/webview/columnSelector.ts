const selectedColumns = new Set<number>();
let lastClickedIndex: number | null = null;
let totalColumns = 0;
let onSelectionChange: (() => void) | null = null;
let xAxisCol: number = 0;

export function init(colCount: number, onChange: () => void): void {
  totalColumns = colCount;
  onSelectionChange = onChange;
  selectedColumns.clear();
  xAxisCol = 0;
  if (colCount > 0) selectedColumns.add(0);
  lastClickedIndex = null;
}

export function getSelected(): number[] {
  return Array.from(selectedColumns);
}

export function getXAxisCol(): number {
  return xAxisCol;
}

export function setXAxisCol(col: number): void {
  selectedColumns.delete(xAxisCol);
  xAxisCol = col;
  selectedColumns.add(xAxisCol);
  applyHighlight();
  onSelectionChange?.();
}

export function resetXAxis(): void {
  xAxisCol = 0;
  selectedColumns.add(0);
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
  selectedColumns.add(xAxisCol);
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
  selectedColumns.add(xAxisCol);
  applyHighlight();
  onSelectionChange?.();
}

export function reset(): void {
  selectedColumns.clear();
  xAxisCol = 0;
  if (totalColumns > 0) selectedColumns.add(0);
  lastClickedIndex = null;
  applyHighlight();
  onSelectionChange?.();
}
