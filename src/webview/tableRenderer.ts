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

// Per-column display transform: value * scale + offset. Only in effect while the
// corresponding toolbar row is shown; hiding a row resets it to the identity so
// the table never displays adjusted numbers without the controls that produced
// them being visible.
let scaleRowVisible = false;
let offsetRowVisible = false;
let scales: number[] = [];
let offsets: number[] = [];
let onChangeCallback: (() => void) | null = null;

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

// ---- Scale / offset ----

type SOKind = 'scale' | 'offset';

export type ScaleOffsetState = {
  scaleVisible: boolean; offsetVisible: boolean;
  scales: number[]; offsets: number[];
};

export function isScaleRowVisible(): boolean {
  return scaleRowVisible;
}

export function isOffsetRowVisible(): boolean {
  return offsetRowVisible;
}

export function getScale(col: number): number {
  return scaleRowVisible ? (scales[col] ?? 1) : 1;
}

export function getOffset(col: number): number {
  return offsetRowVisible ? (offsets[col] ?? 0) : 0;
}

export function isScaled(col: number): boolean {
  return getScale(col) !== 1 || getOffset(col) !== 0;
}

// Floating-point multiply/add on parsed decimals leaves noise (0.1 * 3 ->
// 0.30000000000000004); 12 significant digits is well inside double precision
// but past anything a data file realistically carries.
function formatScaled(n: number): string {
  if (!isFinite(n)) return String(n);
  return String(parseFloat(n.toPrecision(12)));
}

export function applyScaleOffset(col: number, val: string): string {
  const s = getScale(col);
  const o = getOffset(col);
  if (s === 1 && o === 0) return val;
  const n = parseFloat(val);
  if (!isFinite(n)) return val;
  return formatScaled(n * s + o);
}

// Render whole numbers as "1.0" / "0.0" so the identity values read as decimals.
function fmtSO(v: number): string {
  return Number.isInteger(v) ? v.toFixed(1) : String(v);
}

function soInput(kind: SOKind, col: number): HTMLInputElement | null {
  return document.querySelector<HTMLInputElement>(`#${kind}-row [data-col-index="${col}"] .so-input`);
}

function refreshSOCol(col: number): void {
  const modified = isScaled(col);
  document.querySelectorAll<HTMLElement>(`#col-index-row [data-col-index="${col}"], #header-row [data-col-index="${col}"]`)
    .forEach(el => el.classList.toggle('scaled-col', modified));
  soInput('scale', col)?.classList.toggle('modified', (scales[col] ?? 1) !== 1);
  soInput('offset', col)?.classList.toggle('modified', (offsets[col] ?? 0) !== 0);
}

function refreshAllSO(): void {
  const n = currentData?.headers.length ?? 0;
  for (let c = 0; c < n; c++) refreshSOCol(c);
}

function commitSO(kind: SOKind, col: number, input: HTMLInputElement): void {
  const arr = kind === 'scale' ? scales : offsets;
  const identity = kind === 'scale' ? 1 : 0;
  const raw = input.value.trim();
  let v = raw === '' ? identity : parseFloat(raw);
  if (!isFinite(v)) v = arr[col] ?? identity;
  arr[col] = v;
  input.value = fmtSO(v);
  refreshSOCol(col);
  scheduleRender();
  onChangeCallback?.();
}

function buildSORow(kind: SOKind, label: string, data: ParsedFile): void {
  const tr = document.getElementById(`${kind}-row`)!;
  tr.innerHTML = '';
  tr.classList.add('hidden');

  const thLabel = document.createElement('th');
  thLabel.textContent = label;
  thLabel.className = 'row-num-cell align-right so-label';
  tr.appendChild(thLabel);

  const identity = kind === 'scale' ? 1 : 0;
  data.headers.forEach((_, colIdx) => {
    const th = document.createElement('th');
    th.dataset.colIndex = String(colIdx);
    th.className = colIdx === 0 ? 'so-cell col-first' : 'so-cell';
    applyFixedWidth(th, colIdx);

    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'so-input';
    input.spellcheck = false;
    input.autocomplete = 'off';
    input.value = fmtSO(identity);
    input.addEventListener('change', () => commitSO(kind, colIdx, input));
    input.addEventListener('keydown', e => {
      if (e.key === 'Enter') { e.preventDefault(); input.blur(); }
      else if (e.key === 'Escape') {
        e.preventDefault();
        input.value = fmtSO((kind === 'scale' ? scales[colIdx] : offsets[colIdx]) ?? identity);
        input.blur();
      }
      e.stopPropagation();
    });
    th.appendChild(input);
    tr.appendChild(th);
  });
}

function resetSOValues(kind: SOKind): void {
  const arr = kind === 'scale' ? scales : offsets;
  const identity = kind === 'scale' ? 1 : 0;
  for (let c = 0; c < arr.length; c++) {
    arr[c] = identity;
    const input = soInput(kind, c);
    if (input) input.value = fmtSO(identity);
  }
}

// The sticky `top` of each header row depends on the heights of the rows above
// it, which change as the scale/offset rows are shown or hidden.
function updateStickyTops(): void {
  const h = (id: string): number => {
    const el = document.getElementById(id);
    if (!el || el.classList.contains('hidden')) return 0;
    return el.getBoundingClientRect().height;
  };
  const colIdxH = h('col-index-row');
  const headerH = h('header-row');
  const scaleH = h('scale-row');
  const style = document.documentElement.style;
  style.setProperty('--col-index-height', `${colIdxH}px`);
  style.setProperty('--scale-row-top', `${colIdxH + headerH}px`);
  style.setProperty('--offset-row-top', `${colIdxH + headerH + scaleH}px`);
}

function setSORowVisible(kind: SOKind, visible: boolean): void {
  const wasVisible = kind === 'scale' ? scaleRowVisible : offsetRowVisible;
  if (visible === wasVisible) return;
  if (kind === 'scale') scaleRowVisible = visible; else offsetRowVisible = visible;
  if (!visible) resetSOValues(kind);
  document.getElementById(`${kind}-row`)?.classList.toggle('hidden', !visible);
  refreshAllSO();
  requestAnimationFrame(updateStickyTops);
  scheduleRender();
}

export function toggleScaleRow(): void {
  setSORowVisible('scale', !scaleRowVisible);
}

export function toggleOffsetRow(): void {
  setSORowVisible('offset', !offsetRowVisible);
}

// "Show original values" on a single column: back to scale 1.0 / offset 0.0.
export function resetScaleOffset(col: number): void {
  scales[col] = 1;
  offsets[col] = 0;
  const sIn = soInput('scale', col);
  if (sIn) sIn.value = fmtSO(1);
  const oIn = soInput('offset', col);
  if (oIn) oIn.value = fmtSO(0);
  refreshSOCol(col);
  scheduleRender();
}

export function clearAllScaleOffset(): void {
  setSORowVisible('scale', false);
  setSORowVisible('offset', false);
}

export function getScaleOffsetSnapshot(): ScaleOffsetState {
  return {
    scaleVisible: scaleRowVisible, offsetVisible: offsetRowVisible,
    scales: scales.slice(), offsets: offsets.slice(),
  };
}

export function restoreScaleOffset(s: ScaleOffsetState): void {
  setSORowVisible('scale', s.scaleVisible);
  setSORowVisible('offset', s.offsetVisible);
  for (let c = 0; c < scales.length; c++) {
    scales[c] = s.scales[c] ?? 1;
    offsets[c] = s.offsets[c] ?? 0;
    const sIn = soInput('scale', c);
    if (sIn) sIn.value = fmtSO(scales[c]);
    const oIn = soInput('offset', c);
    if (oIn) oIn.value = fmtSO(offsets[c]);
    refreshSOCol(c);
  }
  scheduleRender();
}

export function setCrosshairRow(rowIdx: number | null, colIdxs: number[]): void {
  crosshairRowIdx = rowIdx;
  crosshairColIdxs = colIdxs;
  applyRowHighlight();
}

export function getCrosshairRow(): number | null {
  return crosshairRowIdx;
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
let measureEl: HTMLSpanElement | null = null;

const COL_MIN_W = 50;
const COL_MAX_W = 480;
const COL_PAD = 22; // padding (10+10) + border + a little slack

// Measure text width via an offscreen DOM element rather than Canvas2D.
// Canvas text metrics can diverge from actual layout by a few pixels
// depending on the platform's font rasterizer (notably on Windows), which
// was enough to clip long headers even though headerW is meant to be a
// hard lower bound. DOM measurement uses the same layout engine that
// renders the real cells, so it always matches.
function measureTextWidth(text: string, font: string): number {
  if (!measureEl) {
    measureEl = document.createElement('span');
    measureEl.style.position = 'absolute';
    measureEl.style.visibility = 'hidden';
    measureEl.style.whiteSpace = 'pre';
    measureEl.style.left = '-9999px';
    measureEl.style.top = '0';
    document.body.appendChild(measureEl);
  }
  measureEl.style.font = font;
  measureEl.textContent = text;
  return measureEl.getBoundingClientRect().width;
}

// Compute a fixed pixel width per column from the header and a sample of values,
// measured with the table's actual font. Locking widths keeps columns from
// jittering as the virtual scroller renders different rows.
function computeColumnWidths(data: ParsedFile): number[] {
  const cs = getComputedStyle(document.body);
  const normalFont = `${cs.fontSize} ${cs.fontFamily}`;
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
    const headerWBold = measureTextWidth(h ?? '', boldFont);
    const headerWNormal = measureTextWidth(h ?? '', normalFont);
    const headerW = Math.ceil(Math.max(headerWBold, headerWNormal)) + COL_PAD;
    let dataMax = 0;
    for (const i of sampleIdx) {
      const v = data.rows[i]?.[col];
      if (v) { const w = measureTextWidth(v, normalFont); if (w > dataMax) dataMax = w; }
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

  // The floor also has to fit the "Offset" label in the scale/offset rows.
  const rowNumPx = Math.max(String(data.rows.length).length * PX_PER_CHAR + PADDING, 54);
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
  scaleRowVisible = false;
  offsetRowVisible = false;
  scales = new Array(data.headers.length).fill(1);
  offsets = new Array(data.headers.length).fill(0);
  onChangeCallback = onSelectionChange;

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

  buildSORow('scale', 'Scale', data);
  buildSORow('offset', 'Offset', data);

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
    updateStickyTops();
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
      if (isScaled(j)) {
        displayVal = applyScaleOffset(j, displayVal);
        extraCls += ' scaled-col';
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
