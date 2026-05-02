export type Alignment = 'left' | 'center' | 'right';

const alignmentMap = new Map<number, Alignment>();

export function getAlignment(colIndex: number): Alignment {
  return alignmentMap.get(colIndex) ?? 'left';
}

export function setAlignment(colIndices: number[], align: Alignment): void {
  for (const idx of colIndices) {
    alignmentMap.set(idx, align);
    applyToColumn(idx, align);
  }
}

function applyToColumn(colIndex: number, align: Alignment): void {
  const cells = document.querySelectorAll<HTMLElement>(`[data-col-index="${colIndex}"]`);
  cells.forEach(cell => {
    cell.classList.remove('align-left', 'align-center', 'align-right');
    cell.classList.add(`align-${align}`);
  });
}

export function applyAll(colCount: number): void {
  for (let i = 0; i < colCount; i++) {
    const align = getAlignment(i);
    const cells = document.querySelectorAll<HTMLElement>(`[data-col-index="${i}"]`);
    cells.forEach(cell => {
      cell.classList.remove('align-left', 'align-center', 'align-right');
      cell.classList.add(`align-${align}`);
    });
  }
}

export function reset(): void {
  alignmentMap.clear();
}
