// Horizontal virtualization for the data rows. With 100+ columns, building
// every cell of every rendered row made each scroll frame create tens of
// thousands of elements; only the columns in (or near) the viewport are built
// and the rest of the row is filled by one colspan spacer on each side. The
// header rows keep every column, and their fixed widths hold the layout.

const COL_BUFFER = 3;

// Inclusive range [first, last] of the non-sticky columns (1..colCount-1) to
// render. Columns sit back to back from the first non-sticky header cell, each
// exactly widths[c] wide (applyFixedWidth locks them to that).
export function visibleColumns(
  container: HTMLElement, firstTh: HTMLElement | null, widths: number[], colCount: number
): [number, number] {
  if (colCount <= 1) return [1, 0];
  if (!firstTh || widths.length < colCount) return [1, colCount - 1];
  const left = container.scrollLeft;
  const right = left + container.clientWidth;
  // Position in the container's scroll coordinates. Not offsetLeft: that is
  // relative to the offsetParent (the page body here), which put the compare
  // view's right pane ~700 px off and rendered the wrong columns.
  let x = firstTh.getBoundingClientRect().left - container.getBoundingClientRect().left
    + container.clientLeft + left;
  let first = -1, last = colCount - 1;
  for (let c = 1; c < colCount; c++) {
    if (x >= right) { last = c - 1; break; }
    const w = widths[c] ?? 0;
    if (first < 0 && x + w > left) first = c;
    x += w;
  }
  if (first < 0) first = last;
  return [Math.max(1, first - COL_BUFFER), Math.min(colCount - 1, last + COL_BUFFER)];
}

export function spacerCell(span: number): HTMLTableCellElement {
  const td = document.createElement('td');
  td.colSpan = span;
  td.className = 'col-spacer';
  return td;
}
