import { ParsedFile } from '../types';
import { init as initSelector, handleColumnClick, applyHighlight, getSelected, detectDefaultXAxis } from './columnSelector';

const BUFFER = 40;
let ROW_HEIGHT = 24;

let currentData: ParsedFile | null = null;
let crosshairRowIdx: number | null = null;
let crosshairColIdxs: number[] = [];
let renderPending = false;
let rowClickCallback: ((rowIdx: number) => void) | null = null;

export function setRowClickCallback(cb: (rowIdx: number) => void): void {
  rowClickCallback = cb;
}
const diffCols = new Set<number>();
const movAvgCols = new Map<number, number>(); // col -> window size
const hexCols = new Set<number>();

export function getData(): ParsedFile | null {
  return currentData;
}

export function getDiffColsSnapshot(): number[] {
  return Array.from(diffCols);
}

export function getMovAvgColsSnapshot(): Array<[number, number]> {
  return Array.from(movAvgCols.entries());
}

export function getHexColsSnapshot(): number[] {
  return Array.from(hexCols);
}

export function getRowHeight(): number {
  return ROW_HEIGHT;
}

export function isDiff(col: number): boolean {
  return diffCols.has(col);
}

export function hasDiff(): boolean {
  return diffCols.size > 0;
}

export function isMovAvg(col: number): boolean {
  return movAvgCols.has(col);
}

export function hasMovAvg(): boolean {
  return movAvgCols.size > 0;
}

export function getMovAvgWindowSize(col: number): number | undefined {
  return movAvgCols.get(col);
}

export function isHex(col: number): boolean {
  return hexCols.has(col);
}

export function hasHex(): boolean {
  return hexCols.size > 0;
}

export function setHex(col: number): void {
  hexCols.add(col);
  applyHexHeader(col);
  scheduleRender();
}

export function clearHex(col: number): void {
  hexCols.delete(col);
  applyHexHeader(col);
  scheduleRender();
}

export function clearAllHex(): void {
  const cols = Array.from(hexCols);
  hexCols.clear();
  cols.forEach(col => applyHexHeader(col));
  scheduleRender();
}

export function toHexDisplay(val: string): string {
  const n = parseFloat(val);
  if (!isFinite(n)) return val;
  const int = Math.trunc(n);
  return (int < 0 ? '-' : '') + '0x' + Math.abs(int).toString(16).toUpperCase();
}

export function setMovAvg(col: number, windowSize: number): void {
  diffCols.delete(col);
  applyDiffHeader(col);
  movAvgCols.set(col, windowSize);
  applyMovAvgHeader(col);
  scheduleRender();
}

export function clearMovAvg(col: number): void {
  movAvgCols.delete(col);
  applyMovAvgHeader(col);
  scheduleRender();
}

export function clearAllMovAvg(): void {
  const cols = Array.from(movAvgCols.keys());
  movAvgCols.clear();
  cols.forEach(col => applyMovAvgHeader(col));
  scheduleRender();
}

export function setDiff(col: number): void {
  diffCols.add(col);
  applyDiffHeader(col);
  scheduleRender();
}

export function clearDiff(col: number): void {
  diffCols.delete(col);
  applyDiffHeader(col);
  scheduleRender();
}

export function clearAllDiff(): void {
  const cols = Array.from(diffCols);
  diffCols.clear();
  cols.forEach(col => applyDiffHeader(col));
  scheduleRender();
}

function applyDiffHeader(col: number): void {
  const isDiffCol = diffCols.has(col);
  document.querySelectorAll<HTMLElement>(`#col-index-row [data-col-index="${col}"], #header-row [data-col-index="${col}"]`).forEach(el => {
    el.classList.toggle('diff-col', isDiffCol);
  });
}

function applyMovAvgHeader(col: number): void {
  const isMovAvgCol = movAvgCols.has(col);
  document.querySelectorAll<HTMLElement>(`#col-index-row [data-col-index="${col}"], #header-row [data-col-index="${col}"]`).forEach(el => {
    el.classList.toggle('movavg-col', isMovAvgCol);
  });
}

function applyHexHeader(col: number): void {
  const isHexCol = hexCols.has(col);
  document.querySelectorAll<HTMLElement>(`#col-index-row [data-col-index="${col}"], #header-row [data-col-index="${col}"]`).forEach(el => {
    el.classList.toggle('hex-col', isHexCol);
  });
}

export function setCrosshairRow(rowIdx: number | null, colIdxs: number[]): void {
  crosshairRowIdx = rowIdx;
  crosshairColIdxs = colIdxs;
  applyRowHighlight();
}

export function scrollToRow(rowIdx: number): void {
  const container = document.getElementById('table-container')!;
  const clientHeight = container.clientHeight;
  const rowTop = rowIdx * ROW_HEIGHT;
  const scrollTop = container.scrollTop;
  if (rowTop < scrollTop || rowTop + ROW_HEIGHT > scrollTop + clientHeight) {
    container.scrollTop = Math.max(0, rowTop - clientHeight / 3);
  }
  scheduleRender();
}

let colWidths: number[] = [];
let measureCanvas: HTMLCanvasElement | null = null;

const COL_MIN_W = 50;
const COL_MAX_W = 480;
const COL_PAD = 22; // padding (10+10) + border + a little slack

// Compute a fixed pixel width per column from the header and a sample of values,
// measured with the table's actual font. Locking widths keeps columns from
// jittering as the virtual scroller renders different rows.
function computeColumnWidths(data: ParsedFile): number[] {
  if (!measureCanvas) measureCanvas = document.createElement('canvas');
  const ctx = measureCanvas.getContext('2d')!;
  const cs = getComputedStyle(document.body);
  ctx.font = `${cs.fontSize} ${cs.fontFamily}`;
  const normalFont = ctx.font;
  const boldFont = `bold ${cs.fontSize} ${cs.fontFamily}`;

  const n = data.rows.length;
  const sampleIdx: number[] = [];
  const head = Math.min(120, n);
  for (let i = 0; i < head; i++) sampleIdx.push(i);
  for (let i = Math.max(head, n - 120); i < n; i++) sampleIdx.push(i);

  return data.headers.map((h, col) => {
    // The header must always be fully visible, so its width is a hard lower
    // bound (not subject to COL_MAX_W). Only the data-driven width is capped.
    // Selected headers render bold (th.selected), which is wider than the
    // regular font, so measure both and take the larger.
    ctx.font = boldFont;
    const headerWBold = ctx.measureText(h ?? '').width;
    ctx.font = normalFont;
    const headerWNormal = ctx.measureText(h ?? '').width;
    const headerW = Math.ceil(Math.max(headerWBold, headerWNormal)) + COL_PAD;
    let dataMax = 0;
    for (const i of sampleIdx) {
      const v = data.rows[i]?.[col];
      if (v) { const w = ctx.measureText(v).width; if (w > dataMax) dataMax = w; }
    }
    const dataW = Math.min(COL_MAX_W, Math.ceil(dataMax) + COL_PAD);
    return Math.max(COL_MIN_W, headerW, dataW);
  });
}

// Lock a cell to its column's computed width. Column 0 is the sticky first
// column, sized separately via the --col-first-width CSS variable.
function applyFixedWidth(el: HTMLElement, colIdx: number): void {
  if (colIdx === 0) return;
  const w = colWidths[colIdx];
  if (w === undefined) return;
  el.style.width = el.style.minWidth = el.style.maxWidth = `${w}px`;
}

function fixStickyWidths(data: ParsedFile): void {
  const PX_PER_CHAR = 9;
  const PADDING = 24;

  const rowNumPx = Math.max(String(data.rows.length).length * PX_PER_CHAR + PADDING, 40);
  document.documentElement.style.setProperty('--row-num-width', `${rowNumPx}px`);

  const n = data.rows.length;
  const s = Math.min(100, n);
  let maxLen = data.headers[0]?.length ?? 0;
  for (let i = 0; i < s; i++) {
    const v = data.rows[i]?.[0];
    if (v && v.length > maxLen) maxLen = v.length;
  }
  for (let i = Math.max(s, n - 100); i < n; i++) {
    const v = data.rows[i]?.[0];
    if (v && v.length > maxLen) maxLen = v.length;
  }
  const colFirstPx = Math.max(maxLen * PX_PER_CHAR + PADDING, 50);
  document.documentElement.style.setProperty('--col-first-width', `${colFirstPx}px`);
}

export function render(data: ParsedFile, onSelectionChange: () => void): void {
  currentData = data;
  crosshairRowIdx = null;
  crosshairColIdxs = [];
  diffCols.clear();
  movAvgCols.clear();
  hexCols.clear();

  initSelector(data.headers.length, onSelectionChange, detectDefaultXAxis(data.headers, data.rows));

  fixStickyWidths(data);
  colWidths = computeColumnWidths(data);
  if (colWidths[0] !== undefined) {
    document.documentElement.style.setProperty('--col-first-width', `${colWidths[0]}px`);
  }

  const colIndexRow = document.getElementById('col-index-row')!;
  colIndexRow.innerHTML = '';
  const thColIndexEmpty = document.createElement('th');
  thColIndexEmpty.className = 'row-num-cell align-right';
  colIndexRow.appendChild(thColIndexEmpty);
  data.headers.forEach((_, colIdx) => {
    const th = document.createElement('th');
    th.textContent = String(colIdx + 1);
    th.dataset.colIndex = String(colIdx);
    th.className = colIdx === 0 ? 'col-first align-right' : 'align-right';
    applyFixedWidth(th, colIdx);
    colIndexRow.appendChild(th);
  });

  const headerRow = document.getElementById('header-row')!;
  headerRow.innerHTML = '';

  const thRowNum = document.createElement('th');
  thRowNum.textContent = '#';
  thRowNum.className = 'row-num-cell align-right';
  headerRow.appendChild(thRowNum);

  data.headers.forEach((header, colIdx) => {
    const th = document.createElement('th');
    th.textContent = header;
    th.dataset.colIndex = String(colIdx);
    th.className = colIdx === 0 ? 'align-left col-first' : 'align-left';
    applyFixedWidth(th, colIdx);
    th.addEventListener('click', e => handleColumnClick(colIdx, e as MouseEvent));
    headerRow.appendChild(th);
  });

  const container = document.getElementById('table-container')!;
  container.removeEventListener('scroll', onScroll);
  container.addEventListener('scroll', onScroll, { passive: true });
  container.scrollTop = 0;

  renderBody();

  requestAnimationFrame(() => {
    const firstRow = document.querySelector('#data-body tr[data-row-index]') as HTMLElement | null;
    if (firstRow) {
      const h = firstRow.getBoundingClientRect().height;
      if (h > 0) ROW_HEIGHT = h;
    }
    const rowNumTh = document.querySelector('th.row-num-cell') as HTMLElement | null;
    if (rowNumTh) {
      document.documentElement.style.setProperty('--row-num-width', `${rowNumTh.offsetWidth}px`);
    }
    const colIndexRowEl = document.getElementById('col-index-row');
    if (colIndexRowEl) {
      document.documentElement.style.setProperty('--col-index-height', `${colIndexRowEl.getBoundingClientRect().height}px`);
    }
  });
}

function onScroll(): void {
  scheduleRender();
}

function scheduleRender(): void {
  if (!renderPending) {
    renderPending = true;
    requestAnimationFrame(() => {
      renderPending = false;
      renderBody();
    });
  }
}

export function getDiffValue(rowIdx: number, colIdx: number): string {
  if (!currentData) return '';
  const n = currentData.rows.length;
  if (n < 2) return currentData.rows[rowIdx][colIdx];
  const i = rowIdx < n - 1 ? rowIdx : n - 2;
  const curr = parseFloat(currentData.rows[i + 1][colIdx]);
  const prev = parseFloat(currentData.rows[i][colIdx]);
  if (isNaN(curr) || isNaN(prev)) return currentData.rows[rowIdx][colIdx];
  return String(curr - prev);
}

export function getMovAvgValue(rowIdx: number, colIdx: number, windowSize: number): string {
  if (!currentData) return '';
  const start = Math.max(0, rowIdx - windowSize + 1);
  let sum = 0, count = 0;
  for (let i = start; i <= rowIdx; i++) {
    const val = parseFloat(currentData.rows[i][colIdx]);
    if (!isNaN(val)) { sum += val; count++; }
  }
  return count > 0 ? String(sum / count) : currentData.rows[rowIdx][colIdx];
}

function renderBody(): void {
  if (!currentData) return;
  const container = document.getElementById('table-container')!;
  const scrollTop = container.scrollTop;
  const clientHeight = container.clientHeight || 400;
  const totalRows = currentData.rows.length;
  const colCount = currentData.headers.length;

  const start = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - BUFFER);
  const end = Math.min(totalRows - 1, Math.ceil((scrollTop + clientHeight) / ROW_HEIGHT) + BUFFER);

  const tbody = document.getElementById('data-body')!;
  tbody.innerHTML = '';

  if (start > 0) {
    const tr = document.createElement('tr');
    const td = document.createElement('td');
    td.colSpan = colCount + 1;
    td.style.cssText = `height:${start * ROW_HEIGHT}px;padding:0;border:none;pointer-events:none;`;
    tr.appendChild(td);
    tbody.appendChild(tr);
  }

  const frag = document.createDocumentFragment();
  for (let i = start; i <= end; i++) {
    const row = currentData.rows[i];
    const tr = document.createElement('tr');
    tr.dataset.rowIndex = String(i);
    tr.addEventListener('click', () => { if (rowClickCallback) rowClickCallback(i); });

    const tdNum = document.createElement('td');
    tdNum.textContent = String(i + 1);
    tdNum.className = 'row-num-cell align-right';
    tr.appendChild(tdNum);

    for (let j = 0; j < row.length; j++) {
      const td = document.createElement('td');
      const inDiff = diffCols.has(j);
      const movAvgWin = movAvgCols.get(j);
      const inHex = hexCols.has(j);
      let displayVal: string;
      let extraCls = '';
      if (inDiff) {
        displayVal = getDiffValue(i, j);
        extraCls = ' diff-col';
      } else if (movAvgWin !== undefined) {
        displayVal = getMovAvgValue(i, j, movAvgWin);
        extraCls = ' movavg-col';
      } else {
        displayVal = row[j];
      }
      if (inHex) {
        displayVal = toHexDisplay(displayVal);
        extraCls += ' hex-col';
      }
      td.textContent = displayVal;
      td.dataset.colIndex = String(j);
      td.className = (j === 0 ? 'align-left col-first' : 'align-left') + extraCls;
      applyFixedWidth(td, j);
      td.addEventListener('click', e => handleColumnClick(j, e as MouseEvent));
      tr.appendChild(td);
    }
    frag.appendChild(tr);
  }
  tbody.appendChild(frag);

  if (end < totalRows - 1) {
    const tr = document.createElement('tr');
    const td = document.createElement('td');
    td.colSpan = colCount + 1;
    td.style.cssText = `height:${(totalRows - 1 - end) * ROW_HEIGHT}px;padding:0;border:none;pointer-events:none;`;
    tr.appendChild(td);
    tbody.appendChild(tr);
  }

  applyHighlight();
  applyRowHighlight();
}

function applyRowHighlight(): void {
  document.querySelectorAll('td.crosshair-row').forEach(el => el.classList.remove('crosshair-row'));
  if (crosshairRowIdx === null) return;
  const tr = document.querySelector(`#data-body tr[data-row-index="${crosshairRowIdx}"]`);
  if (!tr) return;
  crosshairColIdxs.forEach(colIdx => {
    const td = tr.querySelector<HTMLElement>(`[data-col-index="${colIdx}"]`);
    if (td) td.classList.add('crosshair-row');
  });
}
