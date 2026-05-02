import { setAlignment, Alignment } from './alignmentController';

const selectedColumns = new Set<number>();
let lastClickedIndex: number | null = null;
let totalColumns = 0;
let onSelectionChange: (() => void) | null = null;

export function init(colCount: number, onChange: () => void): void {
  totalColumns = colCount;
  onSelectionChange = onChange;
  selectedColumns.clear();
  lastClickedIndex = null;
}

export function getSelected(): number[] {
  return Array.from(selectedColumns);
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
  lastClickedIndex = colIndex;
  applyHighlight();
  onSelectionChange?.();
}

export function applyAlignment(align: Alignment): void {
  const cols = getSelected();
  if (cols.length > 0) setAlignment(cols, align);
}

function applyHighlight(): void {
  for (let i = 0; i < totalColumns; i++) {
    const cells = document.querySelectorAll<HTMLElement>(`[data-col-index="${i}"]`);
    const isSelected = selectedColumns.has(i);
    cells.forEach(cell => {
      cell.classList.toggle('selected', isSelected);
    });
  }
}

export function reset(): void {
  selectedColumns.clear();
  lastClickedIndex = null;
  applyHighlight();
  onSelectionChange?.();
}
