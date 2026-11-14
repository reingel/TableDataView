import { initGraphSave } from './graphSave';
import { ExtensionToWebviewMessage } from '../types';
import { TableBuilder, TableFile } from './tableData';
import { getColumnStore } from './columnCache';
import { renderGraph, GraphSource, getVisibleXWindow, resetZoom, resetCrosshairs, hideCrosshairs, closeGraph, setLineWidth, setMarkerStyle, setRowHighlightCallback, setExtraYValuesCallback, setCrosshairToRow, setHoveredColumns, updateViewport, setGraphDiffMode } from './graphRenderer';
import { detectDefaultXAxis, SEQ_X } from './columnSelector';
import { visibleColumns, spacerCell } from './columnWindow';

declare function acquireVsCodeApi(): { postMessage: (msg: object) => void };
const vscode = acquireVsCodeApi();

type Side = 'left' | 'right';

const BUFFER = 15;
let ROW_HEIGHT = 24;

let leftData: TableFile | null = null;
let rightData: TableFile | null = null;
// Rows shown in each pane: the longer file's length, so every row of both files
// is visible. The shorter pane is padded with blank rows to keep scrolling in sync.
let displayRowCount = 0;
// Rows present in both files — the only range where values can be compared.
let commonRowCount = 0;

function sideRowCount(side: Side): number {
  const data = side === 'left' ? leftData : rightData;
  return data ? data.rows.length : 0;
}

// leftColIdx → rightColIdx
let columnMapping = new Map<number, number>();
// rightColIdx → leftColIdx
let reverseMapping = new Map<number, number>();
// Manual overrides on top of buildColumnMapping's auto-detected pairs.
// Keyed by left column index; null means "explicitly unmatched".
let matchOverrides = new Map<number, number | null>();

// Transform state per side
const diffCols: Record<Side, Set<number>> = { left: new Set(), right: new Set() };
const movAvgCols: Record<Side, Map<number, number>> = { left: new Map(), right: new Map() };
const hexCols: Record<Side, Set<number>> = { left: new Set(), right: new Set() };
// Per-column display transform: value * scale + offset. Shown/hidden together
// for both panes by the toolbar buttons; hiding a row resets it to the identity
// so the tables never show adjusted numbers without the controls that produced
// them being visible.
let scaleRowVisible = true;
let offsetRowVisible = true;
const scales: Record<Side, number[]> = { left: [], right: [] };
const offsets: Record<Side, number[]> = { left: [], right: [] };
const xAxisCol: Record<Side, number> = { left: SEQ_X, right: SEQ_X };
const defaultXAxisCol: Record<Side, number> = { left: SEQ_X, right: SEQ_X };
const selectedCols: Record<Side, Set<number>> = { left: new Set(), right: new Set() };

// Columns that have at least one differing cell (by side)
const diffColumnSet: Record<Side, Set<number>> = { left: new Set(), right: new Set() };

// Whether a matched pair differs, keyed by both columns and their transforms.
// computeDiffColumns runs on every render (scroll frame); without this it
// rescanned every row of every identical pair each time.
const pairDiffCache = new Map<string, boolean>();
let pairDiffData: [TableFile | null, TableFile | null] = [null, null];

const IDENTITY_TRANSFORM = '|1|0';

function transformKey(side: Side, col: number): string {
  const t = diffCols[side].has(col) ? 'd' : movAvgCols[side].get(col) ?? '';
  return `${t}|${getScale(side, col)}|${getOffset(side, col)}`;
}

// A cell's effective value for equality checks without building its display
// string: its number, or its text when it has no number (blank -> ''). A text
// cell (e.g. a date, see cellNumber) of an untransformed column compares as
// text; once transformed the table shows its number, so that is compared.
// Numbers compare by value, so "1.50" and "1.5" count as the same.
function cellKeyFn(side: Side, col: number): (row: number) => number | string {
  const data = (side === 'left' ? leftData : rightData)!;
  const vals = effectiveColumn(side, col);
  const transformed = transformKey(side, col) !== IDENTITY_TRANSFORM;
  return row => {
    const t = data.rows.text(row, col);
    if (t !== undefined && !transformed) return t;
    const v = vals[row];
    return isFinite(v) ? v : (t ?? '');
  };
}

function columnsDiffer(li: number, ri: number): boolean {
  const L = cellKeyFn('left', li), R = cellKeyFn('right', ri);
  for (let i = 0; i < commonRowCount; i++) if (L(i) !== R(i)) return true;
  return false;
}

function computeDiffColumns(): void {
  diffColumnSet.left.clear();
  diffColumnSet.right.clear();
  if (!leftData || !rightData) return;
  if (pairDiffData[0] !== leftData || pairDiffData[1] !== rightData) {
    pairDiffCache.clear();
    pairDiffData = [leftData, rightData];
  }
  for (const [li, ri] of columnMapping) {
    const key = `${li}:${transformKey('left', li)}/${ri}:${transformKey('right', ri)}`;
    let differs = pairDiffCache.get(key);
    if (differs === undefined) {
      differs = columnsDiffer(li, ri);
      pairDiffCache.set(key, differs);
    }
    if (differs) {
      diffColumnSet.left.add(li);
      diffColumnSet.right.add(ri);
    }
  }
}

type CompareReloadState = {
  scrollTop: number; scrollLeft: number;
  leftHeaders: string[]; rightHeaders: string[];
  selectedL: number[]; selectedR: number[];
  xAxisL: number; xAxisR: number;
  diffL: number[]; diffR: number[];
  movAvgL: Array<[number, number]>; movAvgR: Array<[number, number]>;
  hexL: number[]; hexR: number[];
  scaleVisible: boolean; offsetVisible: boolean;
  scalesL: number[]; scalesR: number[];
  offsetsL: number[]; offsetsR: number[];
};
let pendingReload: CompareReloadState | null = null;

// Crosshair state
let crosshairRowIdx: number | null = null;

// Render scheduling
let renderPending = false;

// Scroll sync
let syncScrollFlag = false;
// While true, left/right scroll sync is disabled so a column jump can center
// each pane on its own (differently positioned) matched column. Stays on until
// the user scrolls again (wheel/drag), then sync resumes. (A timer is unreliable
// here: on huge files the programmatic scroll event can fire late and re-sync.)
let scrollDecoupled = false;

function otherSide(side: Side): Side {
  return side === 'left' ? 'right' : 'left';
}

function getMappedCol(side: Side, colIdx: number): number | undefined {
  return side === 'left' ? columnMapping.get(colIdx) : reverseMapping.get(colIdx);
}

function lcsLength(a: string, b: string): number {
  const m = a.length, n = b.length;
  const dp = new Array(n + 1).fill(0);
  for (let i = 1; i <= m; i++) {
    let prev = 0;
    for (let j = 1; j <= n; j++) {
      const tmp = dp[j];
      dp[j] = a[i - 1] === b[j - 1] ? prev + 1 : Math.max(dp[j], dp[j - 1]);
      prev = tmp;
    }
  }
  return dp[n];
}

function greedyMatch(
  leftHeaders: string[], rightHeaders: string[],
  unmatchedL: Set<number>, unmatchedR: Set<number>,
  score: (a: string, b: string) => number
): void {
  const pairs: { li: number; ri: number; s: number }[] = [];
  for (const li of unmatchedL) {
    for (const ri of unmatchedR) {
      const s = score(leftHeaders[li], rightHeaders[ri]);
      if (s > 0) pairs.push({ li, ri, s });
    }
  }
  pairs.sort((a, b) => b.s - a.s);
  for (const { li, ri } of pairs) {
    if (unmatchedL.has(li) && unmatchedR.has(ri)) {
      columnMapping.set(li, ri);
      reverseMapping.set(ri, li);
      unmatchedL.delete(li);
      unmatchedR.delete(ri);
    }
  }
}

function buildColumnMapping(leftHeaders: string[], rightHeaders: string[]): void {
  columnMapping.clear();
  reverseMapping.clear();

  const uL = new Set(leftHeaders.map((_, i) => i));
  const uR = new Set(rightHeaders.map((_, i) => i));

  // Tier 1: case-sensitive exact
  for (const li of Array.from(uL)) {
    for (const ri of Array.from(uR)) {
      if (leftHeaders[li] === rightHeaders[ri]) {
        columnMapping.set(li, ri); reverseMapping.set(ri, li);
        uL.delete(li); uR.delete(ri);
        break;
      }
    }
  }

  // Tier 2: case-sensitive most similar (LCS)
  greedyMatch(leftHeaders, rightHeaders, uL, uR,
    (a, b) => lcsLength(a, b));

  // Tier 3: case-insensitive exact
  for (const li of Array.from(uL)) {
    for (const ri of Array.from(uR)) {
      if (leftHeaders[li].toLowerCase() === rightHeaders[ri].toLowerCase()) {
        columnMapping.set(li, ri); reverseMapping.set(ri, li);
        uL.delete(li); uR.delete(ri);
        break;
      }
    }
  }

  // Tier 4: case-insensitive most similar (LCS)
  greedyMatch(leftHeaders, rightHeaders, uL, uR,
    (a, b) => lcsLength(a.toLowerCase(), b.toLowerCase()));
}

// ---- Manual match overrides ----

// Force li (a left column index) to map to ri (a right column index), or to
// no match at all when ri is null. Releases whatever li/ri were previously
// paired with so the mapping never ends up with two left columns pointing at
// the same right column (or vice versa).
function forceMatch(li: number, ri: number | null): void {
  const oldRi = columnMapping.get(li);
  if (oldRi !== undefined) reverseMapping.delete(oldRi);
  if (ri === null) { columnMapping.delete(li); return; }
  const oldLi = reverseMapping.get(ri);
  if (oldLi !== undefined) columnMapping.delete(oldLi);
  columnMapping.set(li, ri);
  reverseMapping.set(ri, li);
}

// Re-applies user-set overrides on top of a freshly rebuilt auto mapping
// (called after buildColumnMapping on load/reload).
function applyMatchOverrides(): void {
  for (const [li, ri] of matchOverrides) forceMatch(li, ri);
}

// `col-has-diff` is baked into the <th> className once in initPane and never
// re-toggled afterward (unlike diff-col/movavg-col/hex-col, which have their
// own applyXHeader functions), so a mapping change needs to refresh it
// explicitly on both header rows.
function refreshColHasDiffHeaders(): void {
  (['left', 'right'] as Side[]).forEach(side => {
    const n = (side === 'left' ? leftData : rightData)?.headers.length ?? 0;
    for (let i = 0; i < n; i++) {
      document.querySelectorAll<HTMLElement>(`#${side}-header-row [data-col-index="${i}"]`)
        .forEach(el => el.classList.toggle('col-has-diff', diffColumnSet[side].has(i)));
    }
  });
}

function afterMappingChanged(): void {
  computeDiffColumns();
  refreshColHasDiffHeaders();
  renderHeaderPanel();
  scheduleRender();
  updateToolbar();
}

function setManualMatch(li: number, ri: number): void {
  matchOverrides.set(li, ri);
  forceMatch(li, ri);
  afterMappingChanged();
  flashColumn('left', li);
  flashColumn('right', ri);
}

function clearManualMatch(side: Side, colIdx: number): void {
  const li = side === 'left' ? colIdx : reverseMapping.get(colIdx);
  if (li === undefined) return;
  matchOverrides.set(li, null);
  forceMatch(li, null);
  afterMappingChanged();
}

// ---- Toolbar ----

function formatNum(val: number): string {
  if (!isFinite(val)) return 'N/A';
  if (val === 0) return '0';
  const abs = Math.abs(val);
  if (abs >= 1e6 || (abs > 0 && abs < 1e-3)) return val.toExponential(4);
  return parseFloat(val.toPrecision(6)).toString();
}

function buildDiffStatsHtml(): string {
  if (!leftData || !rightData) return '';
  const leftCols = Array.from(selectedCols.left);
  const useColAsX = leftCols.includes(xAxisCol.left);
  const dataCols = useColAsX ? leftCols.filter(c => c !== xAxisCol.left) : leftCols;
  if (dataCols.length === 0) return '';

  const parts: string[] = [];
  for (const li of dataCols) {
    const ri = columnMapping.get(li);
    if (ri === undefined) continue;
    let maxAbsDiff = -1;
    let maxRow = -1;
    const L = effectiveColumn('left', li), R = effectiveColumn('right', ri);
    for (let i = 0; i < commonRowCount; i++) {
      const lv = L[i], rv = R[i];
      if (!isFinite(lv) || !isFinite(rv)) continue;
      const d = Math.abs(lv - rv);
      if (d > maxAbsDiff) { maxAbsDiff = d; maxRow = i; }
    }
    if (maxRow < 0) continue;
    const colName = leftData.headers[li];
    let atStr: string;
    if (useColAsX) {
      const xVal = effectiveColumn('left', xAxisCol.left)[maxRow];
      atStr = `${leftData.headers[xAxisCol.left]}=${formatNum(xVal)}`;
    } else {
      atStr = `Row ${maxRow + 1}`;
    }
    parts.push(`<b>${colName}</b>: max|L−R|=${formatNum(maxAbsDiff)} at ${atStr}`);
  }
  return parts.join('&nbsp;&nbsp;|&nbsp;&nbsp;');
}

function updateToolbar(): void {
  const hasLeft = selectedCols.left.size > 0;
  const hasRight = selectedCols.right.size > 0;
  // Graph toggles the graph pane: always usable to close it, needs a selection to open it.
  const graphOpen = isGraphOpen();
  const graphBtn = document.getElementById('btn-show-graph') as HTMLButtonElement;
  graphBtn.disabled = !graphOpen && !hasLeft && !hasRight;
  graphBtn.classList.toggle('active', graphOpen);

  document.getElementById('btn-scale-offset')!.classList.toggle('active', scaleRowVisible || offsetRowVisible);

  const hasCustomState =
    xAxisCol.left !== defaultXAxisCol.left || xAxisCol.right !== defaultXAxisCol.right ||
    diffCols.left.size > 0 || diffCols.right.size > 0 ||
    movAvgCols.left.size > 0 || movAvgCols.right.size > 0 ||
    hexCols.left.size > 0 || hexCols.right.size > 0 ||
    hasScaleOffset();
  document.getElementById('btn-reset-all')!.classList.toggle('hidden', !hasCustomState);

  updateHeaderPanelSelection();

  const graphContainer = document.getElementById('graph-container')!;
  if (!graphContainer.classList.contains('hidden') && leftData && rightData) {
    renderGraph(
      leftData.headers, graphSource('left'), Array.from(selectedCols.left), xAxisCol.left,
      { headers: rightData.headers, src: graphSource('right'), selectedCols: Array.from(selectedCols.right), xAxisCol: xAxisCol.right, xAxisIsOriginal: isXAxisOriginal('right') },
      isXAxisOriginal('left')
    );
  }
}

// ---- Value computation ----

// The x-axis column is "original" only when its values haven't been transformed
// (numerical diff / moving average). A transformed x-axis distorts the graph, so
// the renderer falls back to the row index in that case.
function isXAxisOriginal(side: Side): boolean {
  const xCol = xAxisCol[side];
  return !diffCols[side].has(xCol) && !movAvgCols[side].has(xCol);
}

function getDiffValue(side: Side, rowIdx: number, colIdx: number): string {
  const data = side === 'left' ? leftData : rightData;
  if (!data) return '';
  const rows = data.rows;
  const n = rows.length;
  if (n < 2) return rows.cell(rowIdx, colIdx);
  const i = rowIdx < n - 1 ? rowIdx : n - 2;
  const vals = rows.column(colIdx);
  const curr = vals[i + 1];
  const prev = vals[i];
  if (isNaN(curr) || isNaN(prev)) return rows.cell(rowIdx, colIdx);
  return String(curr - prev);
}

function getMovAvgValue(side: Side, rowIdx: number, colIdx: number, windowSize: number): string {
  const data = side === 'left' ? leftData : rightData;
  if (!data) return '';
  const start = Math.max(0, rowIdx - windowSize + 1);
  let sum = 0, count = 0;
  const vals = data.rows.column(colIdx);
  for (let i = start; i <= rowIdx; i++) {
    const val = vals[i];
    if (!isNaN(val)) { sum += val; count++; }
  }
  return count > 0 ? String(sum / count) : data.rows.cell(rowIdx, colIdx);
}

function getCellValue(side: Side, rowIdx: number, colIdx: number): string {
  const data = side === 'left' ? leftData : rightData;
  if (!data || rowIdx >= data.rows.length) return '';
  let val: string;
  if (diffCols[side].has(colIdx)) val = getDiffValue(side, rowIdx, colIdx);
  else {
    const ws = movAvgCols[side].get(colIdx);
    val = ws !== undefined ? getMovAvgValue(side, rowIdx, colIdx, ws) : data.rows.cell(rowIdx, colIdx);
  }
  return applyScaleOffset(side, colIdx, val);
}

// What the graph plots for one side: only the columns it asks for, from the
// per-file numeric cache, with that side's transforms applied.
function graphSource(side: Side): GraphSource {
  return {
    rowCount: sideRowCount(side),
    column: col => effectiveColumn(side, col),
    cell: (row, col) => getCellValue(side, row, col),
  };
}

// A column's effective values (that side's diff / moving average /
// scale+offset applied) as numbers, cached per file. Whole-column work
// (stats, go to max diff / NaN, sync) reads this instead of formatting and
// re-parsing every cell.
function effectiveColumn(side: Side, col: number): Float64Array {
  const data = (side === 'left' ? leftData : rightData)!;
  const diff = diffCols[side].has(col);
  return getColumnStore(data).effectiveColumn(col, {
    diff, movAvg: diff ? undefined : movAvgCols[side].get(col),
    scale: getScale(side, col), offset: getOffset(side, col),
  });
}

// ---- Virtual rendering ----

function scheduleRender(): void {
  if (!renderPending) {
    renderPending = true;
    requestAnimationFrame(() => {
      renderPending = false;
      computeDiffColumns();
      renderBody('left');
      renderBody('right');
    });
  }
}

function getPane(side: Side): HTMLElement {
  return document.getElementById(side === 'left' ? 'left-pane' : 'right-pane')!;
}

function renderBody(side: Side): void {
  const data = side === 'left' ? leftData : rightData;
  if (!data) return;
  const pane = getPane(side);
  const scrollTop = pane.scrollTop;
  const clientHeight = pane.clientHeight || 400;
  const totalRows = displayRowCount;
  const colCount = data.headers.length;

  const start = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - BUFFER);
  const end = Math.min(totalRows - 1, Math.ceil((scrollTop + clientHeight) / ROW_HEIGHT) + BUFFER);

  // Read layout before the body is torn down below.
  const firstTh = document.querySelector<HTMLElement>(`#${side}-header-row th[data-col-index="1"]`);
  const [c0, c1] = visibleColumns(pane, firstTh, colWidths[side], colCount);

  const tbody = document.getElementById(`${side}-data-body`)!;
  tbody.innerHTML = '';
  if (!tbody.dataset.clickBound) {
    tbody.dataset.clickBound = '1';
    tbody.addEventListener('click', e => onBodyClick(side, e));
  }

  if (start > 0) {
    const tr = document.createElement('tr');
    const td = document.createElement('td');
    td.colSpan = colCount + 1;
    td.style.cssText = `height:${start * ROW_HEIGHT}px;padding:0;border:none;pointer-events:none;`;
    tr.appendChild(td);
    tbody.appendChild(tr);
  }

  // Per rendered column: equality keys for this side and its matched column.
  const diffKeys = new Map<number, [(r: number) => number | string, (r: number) => number | string]>();
  const keysFor = (j: number) => {
    let k = diffKeys.get(j);
    if (!k) {
      const otherCol = side === 'left' ? columnMapping.get(j) : reverseMapping.get(j);
      if (otherCol === undefined) return undefined;
      k = [cellKeyFn(side, j), cellKeyFn(otherSide(side), otherCol)];
      diffKeys.set(j, k);
    }
    return k;
  };

  const frag = document.createDocumentFragment();
  for (let i = start; i <= end; i++) {
    const row = data.rows.row(i);
    const tr = document.createElement('tr');
    if (!row) {
      // This file has fewer rows than the other one: a blank filler row keeps
      // both panes the same height so their scroll positions stay aligned.
      const td = document.createElement('td');
      td.colSpan = colCount + 1;
      td.className = 'missing-row';
      td.style.height = `${ROW_HEIGHT}px`;
      tr.appendChild(td);
      frag.appendChild(tr);
      continue;
    }
    tr.dataset.rowIndex = String(i);

    const tdNum = document.createElement('td');
    tdNum.textContent = String(i + 1);
    tdNum.className = 'row-num-cell align-right';
    tr.appendChild(tdNum);

    const addCell = (j: number): void => {
      const td = document.createElement('td');
      const inDiff = diffCols[side].has(j);
      const movAvgWin = movAvgCols[side].get(j);
      const inHex = hexCols[side].has(j);
      let displayVal: string;
      let extraCls = '';
      if (inDiff) {
        displayVal = getDiffValue(side, i, j);
        extraCls = ' diff-col';
      } else if (movAvgWin !== undefined) {
        displayVal = getMovAvgValue(side, i, j, movAvgWin);
        extraCls = ' movavg-col';
      } else {
        displayVal = row[j];
      }
      if (isScaled(side, j)) {
        displayVal = applyScaleOffset(side, j, displayVal);
        extraCls += ' scaled-col';
      }
      if (inHex) {
        displayVal = toHexDisplay(displayVal);
        extraCls += ' hex-col';
      }
      const keys = i < commonRowCount ? keysFor(j) : undefined;
      if (keys && keys[0](i) !== keys[1](i)) extraCls += ' value-diff';
      td.textContent = displayVal;
      td.dataset.colIndex = String(j);
      td.dataset.side = side;
      td.className = (j === 0 ? 'align-left col-first' : 'align-left') + extraCls;
      applyFixedWidth(td, side, j);
      tr.appendChild(td);
    };
    if (colCount > 0) addCell(0);
    if (c0 > 1) tr.appendChild(spacerCell(c0 - 1));
    for (let j = c0; j <= c1; j++) addCell(j);
    if (c1 < colCount - 1) tr.appendChild(spacerCell(colCount - 1 - c1));
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

  applyHighlight(side);
  applyRowHighlight(side);
}

// One delegated listener per body instead of two per cell: cell (column)
// first, then row, the order the per-element listeners fired in.
function onBodyClick(side: Side, e: MouseEvent): void {
  const target = e.target as HTMLElement;
  const td = target.closest<HTMLElement>('td[data-col-index]');
  if (td) handleColumnClick(side, parseInt(td.dataset.colIndex!, 10), e);
  const tr = target.closest<HTMLElement>('tr[data-row-index]');
  if (tr) navigateToRow(parseInt(tr.dataset.rowIndex!, 10));
}

// ---- Column selection ----

let lastClickedCol: Record<Side, number | null> = { left: null, right: null };

function selectSingleColumn(side: Side, colIdx: number): void {
  const other = otherSide(side);
  const mappedIdx = getMappedCol(side, colIdx);
  selectedCols.left.clear();
  selectedCols.right.clear();
  selectedCols[side].add(colIdx);
  if (mappedIdx !== undefined) selectedCols[other].add(mappedIdx);
}

function finishColumnSelection(side: Side, colIdx: number): void {
  // Always keep x-axis col selected (skip the sequence-number sentinel)
  if (xAxisCol.left >= 0) selectedCols.left.add(xAxisCol.left);
  if (xAxisCol.right >= 0) selectedCols.right.add(xAxisCol.right);

  lastClickedCol[side] = colIdx;
  applyHighlight('left');
  applyHighlight('right');
  updateToolbar();
}

function handleColumnClick(side: Side, colIdx: number, event: MouseEvent): void {
  const other = otherSide(side);
  const mappedIdx = getMappedCol(side, colIdx);

  if (event.shiftKey && lastClickedCol[side] !== null) {
    const lo = Math.min(lastClickedCol[side]!, colIdx);
    const hi = Math.max(lastClickedCol[side]!, colIdx);
    for (let i = lo; i <= hi; i++) {
      selectedCols[side].add(i);
      const mi = getMappedCol(side, i);
      if (mi !== undefined) selectedCols[other].add(mi);
    }
  } else if (event.ctrlKey || event.metaKey) {
    if (selectedCols[side].has(colIdx)) {
      selectedCols[side].delete(colIdx);
      if (mappedIdx !== undefined) selectedCols[other].delete(mappedIdx);
    } else {
      selectedCols[side].add(colIdx);
      if (mappedIdx !== undefined) selectedCols[other].add(mappedIdx);
    }
  } else {
    selectSingleColumn(side, colIdx);
  }

  finishColumnSelection(side, colIdx);
}

function applyHighlight(side: Side): void {
  const data = side === 'left' ? leftData : rightData;
  if (!data) return;
  // One pass over the cells; a query per column rescanned the table once for
  // every column.
  const n = data.headers.length;
  document.querySelectorAll<HTMLElement>(`#${side}-table [data-col-index]`).forEach(cell => {
    const i = Number(cell.dataset.colIndex);
    if (!(i >= 0 && i < n)) return;
    const isXAxis = i === xAxisCol[side];
    cell.classList.toggle('selected', selectedCols[side].has(i) && !isXAxis);
    cell.classList.toggle('x-axis', isXAxis);
  });
}

function applyDiffHeader(side: Side, colIdx: number): void {
  const isDiffCol = diffCols[side].has(colIdx);
  document.querySelectorAll<HTMLElement>(`#${side}-col-index-row [data-col-index="${colIdx}"], #${side}-header-row [data-col-index="${colIdx}"]`).forEach(el => {
    el.classList.toggle('diff-col', isDiffCol);
  });
}

function applyMovAvgHeader(side: Side, colIdx: number): void {
  const isMovAvgCol = movAvgCols[side].has(colIdx);
  document.querySelectorAll<HTMLElement>(`#${side}-col-index-row [data-col-index="${colIdx}"], #${side}-header-row [data-col-index="${colIdx}"]`).forEach(el => {
    el.classList.toggle('movavg-col', isMovAvgCol);
  });
}

function applyHexHeader(side: Side, colIdx: number): void {
  const isHexCol = hexCols[side].has(colIdx);
  document.querySelectorAll<HTMLElement>(`#${side}-col-index-row [data-col-index="${colIdx}"], #${side}-header-row [data-col-index="${colIdx}"]`).forEach(el => {
    el.classList.toggle('hex-col', isHexCol);
  });
}

function toHexDisplay(val: string): string {
  const n = parseFloat(val);
  if (!isFinite(n)) return val;
  const int = Math.trunc(n);
  return (int < 0 ? '-' : '') + '0x' + Math.abs(int).toString(16).toUpperCase();
}

function setHex(side: Side, colIdx: number): void {
  hexCols[side].add(colIdx);
  applyHexHeader(side, colIdx);
  const other = otherSide(side);
  const mi = getMappedCol(side, colIdx);
  if (mi !== undefined) {
    hexCols[other].add(mi);
    applyHexHeader(other, mi);
  }
  scheduleRender();
  updateToolbar();
}

function clearHex(side: Side, colIdx: number): void {
  hexCols[side].delete(colIdx);
  applyHexHeader(side, colIdx);
  const other = otherSide(side);
  const mi = getMappedCol(side, colIdx);
  if (mi !== undefined) {
    hexCols[other].delete(mi);
    applyHexHeader(other, mi);
  }
  scheduleRender();
  updateToolbar();
}

// ---- Scale / offset (independent per side; row visibility is shared) ----

type SOKind = 'scale' | 'offset';

function soArr(kind: SOKind, side: Side): number[] {
  return kind === 'scale' ? scales[side] : offsets[side];
}

function soIdentity(kind: SOKind): number {
  return kind === 'scale' ? 1 : 0;
}

function getScale(side: Side, col: number): number {
  return scaleRowVisible ? (scales[side][col] ?? 1) : 1;
}

function getOffset(side: Side, col: number): number {
  return offsetRowVisible ? (offsets[side][col] ?? 0) : 0;
}

function isScaled(side: Side, col: number): boolean {
  return getScale(side, col) !== 1 || getOffset(side, col) !== 0;
}

// Floating-point multiply/add on parsed decimals leaves noise (0.1 * 3 ->
// 0.30000000000000004); 12 significant digits is well inside double precision
// but past anything a data file realistically carries.
function formatScaled(n: number): string {
  if (!isFinite(n)) return String(n);
  return String(parseFloat(n.toPrecision(12)));
}

function applyScaleOffset(side: Side, col: number, val: string): string {
  const sc = getScale(side, col);
  const off = getOffset(side, col);
  if (sc === 1 && off === 0) return val;
  const n = parseFloat(val);
  if (!isFinite(n)) return val;
  return formatScaled(n * sc + off);
}

// Render whole numbers as "1.0" / "0.0" so the identity values read as decimals.
function fmtSO(v: number): string {
  return Number.isInteger(v) ? v.toFixed(1) : String(v);
}

function soInput(kind: SOKind, side: Side, col: number): HTMLInputElement | null {
  return document.querySelector<HTMLInputElement>(`#${side}-${kind}-row [data-col-index="${col}"] .so-input`);
}

function refreshSOCol(side: Side, col: number): void {
  const modified = isScaled(side, col);
  document.querySelectorAll<HTMLElement>(`#${side}-col-index-row [data-col-index="${col}"], #${side}-header-row [data-col-index="${col}"]`)
    .forEach(el => el.classList.toggle('scaled-col', modified));
  soInput('scale', side, col)?.classList.toggle('modified', (scales[side][col] ?? 1) !== 1);
  soInput('offset', side, col)?.classList.toggle('modified', (offsets[side][col] ?? 0) !== 0);
}

function refreshAllSO(): void {
  for (const side of ['left', 'right'] as Side[]) {
    const n = (side === 'left' ? leftData : rightData)?.headers.length ?? 0;
    for (let c = 0; c < n; c++) refreshSOCol(side, c);
  }
}

// Writes one side's value only. Unlike diff / moving average / x-axis, scale and
// offset are per file (e.g. converting units of just one of them), so they are
// not mirrored onto the matched column opposite.
function setSOValue(kind: SOKind, side: Side, col: number, v: number): void {
  soArr(kind, side)[col] = v;
  const input = soInput(kind, side, col);
  if (input) input.value = fmtSO(v);
  refreshSOCol(side, col);
}

function commitSO(kind: SOKind, side: Side, col: number, input: HTMLInputElement): void {
  const identity = soIdentity(kind);
  const raw = input.value.trim();
  let v = raw === '' ? identity : parseFloat(raw);
  if (!isFinite(v)) v = soArr(kind, side)[col] ?? identity;
  setSOValue(kind, side, col, v);
  scheduleRender();
  updateToolbar();
}

function buildSORow(kind: SOKind, side: Side, label: string, data: TableFile): void {
  const tr = document.getElementById(`${side}-${kind}-row`)!;
  tr.innerHTML = '';
  tr.classList.toggle('hidden', !(kind === 'scale' ? scaleRowVisible : offsetRowVisible));

  const thLabel = document.createElement('th');
  thLabel.textContent = label;
  thLabel.className = 'row-num-cell align-right so-label';
  tr.appendChild(thLabel);

  const identity = soIdentity(kind);
  data.headers.forEach((_, colIdx) => {
    const th = document.createElement('th');
    th.dataset.colIndex = String(colIdx);
    th.dataset.side = side;
    th.className = colIdx === 0 ? 'so-cell col-first' : 'so-cell';
    applyFixedWidth(th, side, colIdx);

    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'so-input';
    input.spellcheck = false;
    input.autocomplete = 'off';
    input.value = fmtSO(soArr(kind, side)[colIdx] ?? identity);
    input.addEventListener('change', () => commitSO(kind, side, colIdx, input));
    input.addEventListener('keydown', e => {
      if (e.key === 'Enter') { e.preventDefault(); input.blur(); }
      else if (e.key === 'Escape') {
        e.preventDefault();
        input.value = fmtSO(soArr(kind, side)[colIdx] ?? identity);
        input.blur();
      }
      e.stopPropagation();
    });
    th.appendChild(input);
    tr.appendChild(th);
  });
}

function resetSOValues(kind: SOKind): void {
  const identity = soIdentity(kind);
  for (const side of ['left', 'right'] as Side[]) {
    const arr = soArr(kind, side);
    for (let c = 0; c < arr.length; c++) {
      arr[c] = identity;
      const input = soInput(kind, side, c);
      if (input) input.value = fmtSO(identity);
    }
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
  const colIdxH = h('left-col-index-row');
  const headerH = h('left-header-row');
  const scaleH = h('left-scale-row');
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
  for (const side of ['left', 'right'] as Side[]) {
    document.getElementById(`${side}-${kind}-row`)?.classList.toggle('hidden', !visible);
  }
  refreshAllSO();
  requestAnimationFrame(updateStickyTops);
  scheduleRender();
}

// "Show original values" on a single column: back to scale 1.0 / offset 0.0.
function resetScaleOffset(side: Side, col: number): void {
  setSOValue('scale', side, col, 1);
  setSOValue('offset', side, col, 0);
}

// Back to the default: both rows shown, every column at 1.0 / 0.0.
function clearAllScaleOffset(): void {
  setSORowVisible('scale', true);
  setSORowVisible('offset', true);
  resetSOValues('scale');
  resetSOValues('offset');
  refreshAllSO();
  scheduleRender();
}

// True when any column on either side has a non-identity scale or offset in effect.
function hasScaleOffset(): boolean {
  return (['left', 'right'] as Side[]).some(side =>
    scales[side].some((_, c) => getScale(side, c) !== 1) || offsets[side].some((_, c) => getOffset(side, c) !== 0));
}

function applyRowHighlight(side: Side): void {
  const tableId = `#${side}-data-body`;
  document.querySelectorAll(`${tableId} td.crosshair-row`).forEach(el => el.classList.remove('crosshair-row'));
  if (crosshairRowIdx === null) return;
  const tr = document.querySelector(`${tableId} tr[data-row-index="${crosshairRowIdx}"]`);
  if (!tr) return;
  selectedCols[side].forEach(colIdx => {
    const td = tr.querySelector<HTMLElement>(`[data-col-index="${colIdx}"]`);
    if (td) td.classList.add('crosshair-row');
  });
}

// ---- Transform operations (synced between sides) ----

function setDiff(side: Side, colIdx: number): void {
  diffCols[side].add(colIdx);
  movAvgCols[side].delete(colIdx);
  applyDiffHeader(side, colIdx);
  applyMovAvgHeader(side, colIdx);
  const other = otherSide(side);
  const mi = getMappedCol(side, colIdx);
  if (mi !== undefined) {
    diffCols[other].add(mi);
    movAvgCols[other].delete(mi);
    applyDiffHeader(other, mi);
    applyMovAvgHeader(other, mi);
  }
  scheduleRender();
  updateToolbar();
}

function setMovAvg(side: Side, colIdx: number, windowSize: number): void {
  diffCols[side].delete(colIdx);
  movAvgCols[side].set(colIdx, windowSize);
  applyDiffHeader(side, colIdx);
  applyMovAvgHeader(side, colIdx);
  const other = otherSide(side);
  const mi = getMappedCol(side, colIdx);
  if (mi !== undefined) {
    diffCols[other].delete(mi);
    movAvgCols[other].set(mi, windowSize);
    applyDiffHeader(other, mi);
    applyMovAvgHeader(other, mi);
  }
  scheduleRender();
  updateToolbar();
}

function clearTransform(side: Side, colIdx: number): void {
  diffCols[side].delete(colIdx);
  movAvgCols[side].delete(colIdx);
  hexCols[side].delete(colIdx);
  applyDiffHeader(side, colIdx);
  applyMovAvgHeader(side, colIdx);
  applyHexHeader(side, colIdx);
  const other = otherSide(side);
  const mi = getMappedCol(side, colIdx);
  if (mi !== undefined) {
    diffCols[other].delete(mi);
    movAvgCols[other].delete(mi);
    hexCols[other].delete(mi);
    applyDiffHeader(other, mi);
    applyMovAvgHeader(other, mi);
    applyHexHeader(other, mi);
  }
  resetScaleOffset(side, colIdx);
  scheduleRender();
  updateToolbar();
}

function setXAxis(side: Side, colIdx: number): void {
  xAxisCol[side] = colIdx;
  selectedCols[side].add(colIdx);
  applyHighlight(side);
  const other = otherSide(side);
  const mi = getMappedCol(side, colIdx);
  if (mi !== undefined) {
    xAxisCol[other] = mi;
    selectedCols[other].add(mi);
    applyHighlight(other);
  }
  updateToolbar();
}

function resetXAxis(side: Side): void {
  // Reset both sides to their own auto-detected default (mirrored action).
  xAxisCol.left = defaultXAxisCol.left;
  xAxisCol.right = defaultXAxisCol.right;
  if (xAxisCol.left >= 0) selectedCols.left.add(xAxisCol.left);
  if (xAxisCol.right >= 0) selectedCols.right.add(xAxisCol.right);
  void side;
  applyHighlight('left');
  applyHighlight('right');
  updateToolbar();
}

function navigateToRow(rowIdx: number): void {
  crosshairRowIdx = rowIdx;
  applyRowHighlight('left');
  applyRowHighlight('right');
  scrollToRow(rowIdx);
  const graphContainer = document.getElementById('graph-container')!;
  if (!graphContainer.classList.contains('hidden')) setCrosshairToRow(rowIdx);
}

function gotoNextDiff(side: Side, colIdx: number): void {
  const otherCol = getMappedCol(side, colIdx);
  if (otherCol === undefined) return;
  const mine = cellKeyFn(side, colIdx), theirs = cellKeyFn(otherSide(side), otherCol);
  const start = (crosshairRowIdx !== null ? crosshairRowIdx + 1 : 0);
  for (let pass = 0; pass < 2; pass++) {
    const from = pass === 0 ? start : 0;
    const to = pass === 0 ? commonRowCount : Math.min(crosshairRowIdx ?? 0, commonRowCount);
    for (let i = from; i < to; i++) {
      if (mine(i) !== theirs(i)) {
        navigateToRow(i);
        return;
      }
    }
  }
}

function gotoPrevDiff(side: Side, colIdx: number): void {
  const otherCol = getMappedCol(side, colIdx);
  if (otherCol === undefined) return;
  const mine = cellKeyFn(side, colIdx), theirs = cellKeyFn(otherSide(side), otherCol);
  const start = Math.min(crosshairRowIdx !== null ? crosshairRowIdx - 1 : commonRowCount - 1, commonRowCount - 1);
  for (let pass = 0; pass < 2; pass++) {
    const from = pass === 0 ? start : commonRowCount - 1;
    const to = pass === 0 ? -1 : (crosshairRowIdx ?? commonRowCount);
    for (let i = from; i > to; i--) {
      if (mine(i) !== theirs(i)) {
        navigateToRow(i);
        return;
      }
    }
  }
}

function gotoMaxDiff(side: Side, colIdx: number): void {
  const otherCol = getMappedCol(side, colIdx);
  if (otherCol === undefined) return;
  let maxDiff = -1;
  let maxRow = -1;
  const A = effectiveColumn(side, colIdx), B = effectiveColumn(otherSide(side), otherCol);
  for (let i = 0; i < commonRowCount; i++) {
    const lv = A[i], rv = B[i];
    if (!isFinite(lv) || !isFinite(rv)) continue;
    const d = Math.abs(lv - rv);
    if (d > maxDiff) { maxDiff = d; maxRow = i; }
  }
  if (maxRow < 0) return;
  navigateToRow(maxRow);
}

function gotoNaN(side: Side, colIdx: number, dir: 1 | -1): void {
  const n = sideRowCount(side);
  if (n === 0) return;
  // Wrap around so repeated invocations walk through every gap in the column.
  const start = crosshairRowIdx !== null
    ? crosshairRowIdx + dir
    : (dir === 1 ? 0 : n - 1);
  const vals = effectiveColumn(side, colIdx);
  for (let k = 0; k < n; k++) {
    const i = ((start + dir * k) % n + n) % n;
    if (!isFinite(vals[i])) {
      navigateToRow(i);
      return;
    }
  }
}

function saveCompareReloadState(): void {
  if (!leftData || !rightData) return;
  const pane = document.getElementById('left-pane')!;
  pendingReload = {
    scrollTop: pane.scrollTop, scrollLeft: pane.scrollLeft,
    leftHeaders: leftData.headers.slice(), rightHeaders: rightData.headers.slice(),
    selectedL: Array.from(selectedCols.left), selectedR: Array.from(selectedCols.right),
    xAxisL: xAxisCol.left, xAxisR: xAxisCol.right,
    diffL: Array.from(diffCols.left), diffR: Array.from(diffCols.right),
    movAvgL: Array.from(movAvgCols.left.entries()), movAvgR: Array.from(movAvgCols.right.entries()),
    hexL: Array.from(hexCols.left), hexR: Array.from(hexCols.right),
    scaleVisible: scaleRowVisible, offsetVisible: offsetRowVisible,
    scalesL: scales.left.slice(), scalesR: scales.right.slice(),
    offsetsL: offsets.left.slice(), offsetsR: offsets.right.slice(),
  };
}

function restoreCompareReloadState(): void {
  const s = pendingReload;
  pendingReload = null;
  if (!s || !leftData || !rightData) return;
  if (s.leftHeaders.join('\0') !== leftData.headers.join('\0')) return;
  if (s.rightHeaders.join('\0') !== rightData.headers.join('\0')) return;

  for (const c of s.diffL) { diffCols.left.add(c); applyDiffHeader('left', c); }
  for (const c of s.diffR) { diffCols.right.add(c); applyDiffHeader('right', c); }
  for (const [c, w] of s.movAvgL) { movAvgCols.left.set(c, w); applyMovAvgHeader('left', c); }
  for (const [c, w] of s.movAvgR) { movAvgCols.right.set(c, w); applyMovAvgHeader('right', c); }
  for (const c of s.hexL) { hexCols.left.add(c); applyHexHeader('left', c); }
  for (const c of s.hexR) { hexCols.right.add(c); applyHexHeader('right', c); }
  setSORowVisible('scale', s.scaleVisible);
  setSORowVisible('offset', s.offsetVisible);
  for (const [side, sc, off] of [['left', s.scalesL, s.offsetsL], ['right', s.scalesR, s.offsetsR]] as Array<[Side, number[], number[]]>) {
    for (let c = 0; c < scales[side].length; c++) {
      scales[side][c] = sc[c] ?? 1;
      offsets[side][c] = off[c] ?? 0;
      const sIn = soInput('scale', side, c);
      if (sIn) sIn.value = fmtSO(scales[side][c]);
      const oIn = soInput('offset', side, c);
      if (oIn) oIn.value = fmtSO(offsets[side][c]);
      refreshSOCol(side, c);
    }
  }
  xAxisCol.left = s.xAxisL; xAxisCol.right = s.xAxisR;
  selectedCols.left = new Set(s.selectedL);
  selectedCols.right = new Set(s.selectedR);
  applyHighlight('left');
  applyHighlight('right');
  computeDiffColumns();
  scheduleRender();
  requestAnimationFrame(() => {
    const pane = document.getElementById('left-pane')!;
    const rPane = document.getElementById('right-pane')!;
    pane.scrollTop = s.scrollTop; pane.scrollLeft = s.scrollLeft;
    rPane.scrollTop = s.scrollTop; rPane.scrollLeft = s.scrollLeft;
  });
}

function resetAll(): void {
  xAxisCol.left = defaultXAxisCol.left; xAxisCol.right = defaultXAxisCol.right;
  if (xAxisCol.left >= 0) selectedCols.left.add(xAxisCol.left);
  if (xAxisCol.right >= 0) selectedCols.right.add(xAxisCol.right);
  diffCols.left.clear(); diffCols.right.clear();
  movAvgCols.left.clear(); movAvgCols.right.clear();
  hexCols.left.clear(); hexCols.right.clear();
  clearAllScaleOffset();
  if (leftData) {
    for (let i = 0; i < leftData.headers.length; i++) {
      applyDiffHeader('left', i);
      applyMovAvgHeader('left', i);
      applyHexHeader('left', i);
    }
    applyHighlight('left');
  }
  if (rightData) {
    for (let i = 0; i < rightData.headers.length; i++) {
      applyDiffHeader('right', i);
      applyMovAvgHeader('right', i);
      applyHexHeader('right', i);
    }
    applyHighlight('right');
  }
  scheduleRender();
  updateToolbar();
}

// ---- Table init ----

const PX_PER_CHAR = 9;
const PADDING = 24;

const COL_MIN_W = 50;
const COL_MAX_W = 480;
const COL_PAD = 22;
const colWidths: Record<Side, number[]> = { left: [], right: [] };
let measureEl: HTMLSpanElement | null = null;

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

// Fixed pixel width per column from header + sampled values, so columns don't
// jitter as the virtual scroller renders different rows.
function computeColumnWidths(data: TableFile): number[] {
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
      const v = data.rows.row(i)?.[col];
      if (v) { const w = measureTextWidth(v, normalFont); if (w > dataMax) dataMax = w; }
    }
    const dataW = Math.min(COL_MAX_W, Math.ceil(dataMax) + COL_PAD);
    return Math.max(COL_MIN_W, headerW, dataW);
  });
}

function applyFixedWidth(el: HTMLElement, side: Side, colIdx: number): void {
  if (colIdx === 0) return; // first column uses the sticky col-first width
  const w = colWidths[side][colIdx];
  if (w === undefined) return;
  el.style.width = el.style.minWidth = el.style.maxWidth = `${w}px`;
}

function initPane(side: Side, data: TableFile): void {
  // The floor also has to fit the "Offset" label in the scale/offset rows.
  const rowNumPx = Math.max(String(displayRowCount).length * PX_PER_CHAR + PADDING, 54);
  const table = document.getElementById(`${side}-table`)!;
  table.style.setProperty('--row-num-width', `${rowNumPx}px`);

  const n = data.rows.length;
  const s = Math.min(100, n);
  let maxLen = data.headers[0]?.length ?? 0;
  for (let i = 0; i < s; i++) {
    const v = data.rows.row(i)?.[0];
    if (v && v.length > maxLen) maxLen = v.length;
  }
  for (let i = Math.max(s, n - 100); i < n; i++) {
    const v = data.rows.row(i)?.[0];
    if (v && v.length > maxLen) maxLen = v.length;
  }
  // colWidths[side] is precomputed (and matched-pair-equalized) in commitCompareData.
  const colFirstPx = colWidths[side][0] ?? Math.max(maxLen * PX_PER_CHAR + PADDING, 50);
  table.style.setProperty('--col-first-width', `${colFirstPx}px`);

  const colIndexRow = document.getElementById(`${side}-col-index-row`)!;
  colIndexRow.innerHTML = '';
  const thEmpty = document.createElement('th');
  thEmpty.className = 'row-num-cell align-right';
  colIndexRow.appendChild(thEmpty);
  data.headers.forEach((_, colIdx) => {
    const th = document.createElement('th');
    th.textContent = String(colIdx);
    th.dataset.colIndex = String(colIdx);
    th.className = colIdx === 0 ? 'col-first align-right' : 'align-right';
    applyFixedWidth(th, side, colIdx);
    colIndexRow.appendChild(th);
  });

  const headerRow = document.getElementById(`${side}-header-row`)!;
  headerRow.innerHTML = '';
  const thRowNum = document.createElement('th');
  thRowNum.textContent = '#';
  thRowNum.className = 'row-num-cell align-right';
  headerRow.appendChild(thRowNum);
  data.headers.forEach((header, colIdx) => {
    const th = document.createElement('th');
    th.textContent = header;
    th.dataset.colIndex = String(colIdx);
    const hasDiff = diffColumnSet[side].has(colIdx) ? ' col-has-diff' : '';
    th.className = (colIdx === 0 ? 'align-left col-first' : 'align-left') + hasDiff;
    applyFixedWidth(th, side, colIdx);
    th.addEventListener('click', e => handleColumnClick(side, colIdx, e as MouseEvent));
    headerRow.appendChild(th);
  });

  // Keep any values the user already entered when the pane is rebuilt (swap,
  // re-match); grow/shrink to the new column count.
  const colCount = data.headers.length;
  scales[side].length = colCount;
  offsets[side].length = colCount;
  for (let i = 0; i < colCount; i++) {
    if (scales[side][i] === undefined) scales[side][i] = 1;
    if (offsets[side][i] === undefined) offsets[side][i] = 0;
  }
  buildSORow('scale', side, 'Scale', data);
  buildSORow('offset', side, 'Offset', data);
  for (let i = 0; i < colCount; i++) refreshSOCol(side, i);

  // Initial column selection: col 0. The x-axis defaults to the row sequence
  // unless the first column looks like an index/time axis.
  selectedCols[side].clear();
  selectedCols[side].add(0);
  defaultXAxisCol[side] = detectDefaultXAxis(data.headers, data.rows);
  xAxisCol[side] = defaultXAxisCol[side];
  if (xAxisCol[side] >= 0) selectedCols[side].add(xAxisCol[side]);

  renderBody(side);

  requestAnimationFrame(() => {
    const firstRow = document.querySelector(`#${side}-data-body tr[data-row-index]`) as HTMLElement | null;
    if (firstRow) {
      const h = firstRow.getBoundingClientRect().height;
      if (h > 0) ROW_HEIGHT = h;
    }
    updateStickyTops();
  });
}

// ---- Scroll ----

function syncViewport(): void {
  const graphContainer = document.getElementById('graph-container')!;
  if (graphContainer.classList.contains('hidden')) return;
  const pane = document.getElementById('left-pane')!;
  const rh = ROW_HEIGHT;
  const startRow = Math.floor(pane.scrollTop / rh);
  const endRow = Math.ceil((pane.scrollTop + pane.clientHeight) / rh);
  updateViewport(startRow, endRow);
}

function scrollToRow(rowIdx: number): void {
  const pane = document.getElementById('left-pane')!;
  const clientHeight = pane.clientHeight;
  const rowTop = rowIdx * ROW_HEIGHT;
  const scrollTop = pane.scrollTop;
  if (rowTop < scrollTop || rowTop + ROW_HEIGHT > scrollTop + clientHeight) {
    const newTop = Math.max(0, rowTop - clientHeight / 3);
    pane.scrollTop = newTop;
    document.getElementById('right-pane')!.scrollTop = newTop;
  }
  scheduleRender();
}

// ---- Time sync (cross-correlation) ----

// Sync needs a real time column as x-axis on both sides (an offset on the row
// sequence means nothing) and that column must not be value-transformed.
function canSyncTime(side: Side, colIdx: number): boolean {
  const other = otherSide(side);
  const otherCol = getMappedCol(side, colIdx);
  return otherCol !== undefined &&
    xAxisCol[side] >= 0 && xAxisCol[other] >= 0 &&
    colIdx !== xAxisCol[side] && otherCol !== xAxisCol[other] &&
    isXAxisOriginal(side) && isXAxisOriginal(other);
}

// (time, value) pairs of a column in effective units (scale/offset and value
// transforms applied), sorted by time for interpolation.
function timeSeries(side: Side, colIdx: number): { t: number[]; v: number[] } {
  const pts: Array<[number, number]> = [];
  const T = effectiveColumn(side, xAxisCol[side]), V = effectiveColumn(side, colIdx);
  for (let i = 0; i < T.length; i++) {
    const t = T[i];
    const v = V[i];
    if (isFinite(t) && isFinite(v)) pts.push([t, v]);
  }
  pts.sort((a, b) => a[0] - b[0]);
  return { t: pts.map(p => p[0]), v: pts.map(p => p[1]) };
}

// Linear interpolation of the series at uniformly spaced times start + k*step;
// NaN outside the series' time range.
function resampleUniform(s: { t: number[]; v: number[] }, start: number, step: number, count: number): Float64Array {
  const out = new Float64Array(count);
  let j = 0;
  for (let k = 0; k < count; k++) {
    const x = start + k * step;
    if (s.t.length === 0 || x < s.t[0] || x > s.t[s.t.length - 1]) { out[k] = NaN; continue; }
    while (j < s.t.length - 2 && s.t[j + 1] < x) j++;
    const t0 = s.t[j], t1 = s.t[j + 1] ?? t0;
    const f = t1 > t0 ? (x - t0) / (t1 - t0) : 0;
    out[k] = s.v[j] + f * ((s.v[j + 1] ?? s.v[j]) - s.v[j]);
  }
  return out;
}

const SYNC_GRID = 1000;

// Lag search over m in [-N, N] grid steps: the reference r[j] is compared with
// ext[j - m + N]. Pearson correlation ranks the lags; lags within SYNC_CORR_TIE
// of the best are treated as ties and decided by the smallest mean squared
// difference, because a trend (ramp) correlates ~1 at every lag and only the
// level difference pins down the true shift. Returns the lag in (fractional)
// grid steps, or null when no lag has enough overlap and variation.
const SYNC_CORR_TIE = 1e-4;
function findBestLag(r: Float64Array, ext: Float64Array, N: number): { lag: number; corr: number } | null {
  const minOverlap = Math.floor(N / 4);
  const corr = new Float64Array(2 * N + 1).fill(NaN);
  const mse = new Float64Array(2 * N + 1).fill(NaN);
  for (let m = -N; m <= N; m++) {
    // Two-pass (centered) sums: values like latitude (37.00001...) lose all
    // precision in the one-pass sum-of-squares formula.
    let n = 0, sx = 0, sy = 0;
    for (let j = 0; j < N; j++) {
      const x = r[j], y = ext[j - m + N];
      if (!isFinite(x) || !isFinite(y)) continue;
      n++; sx += x; sy += y;
    }
    if (n < minOverlap) continue;
    const mx = sx / n, my = sy / n;
    let vx = 0, vy = 0, cxy = 0, d2 = 0;
    for (let j = 0; j < N; j++) {
      const x = r[j], y = ext[j - m + N];
      if (!isFinite(x) || !isFinite(y)) continue;
      const dx = x - mx, dy = y - my;
      vx += dx * dx; vy += dy * dy; cxy += dx * dy;
      d2 += (x - y) * (x - y);
    }
    // A flat stretch (no variation) carries no timing information.
    const tiny = 1e-24 * n * Math.max(1, mx * mx, my * my);
    if (vx <= tiny || vy <= tiny) continue;
    corr[m + N] = Math.max(-1, Math.min(1, cxy / Math.sqrt(vx * vy)));
    mse[m + N] = d2 / n;
  }

  let bestC = -Infinity;
  for (const c of corr) if (c > bestC) bestC = c;
  if (bestC === -Infinity) return null;
  let best = 0, bestE = Infinity;
  for (let m = -N; m <= N; m++) {
    const c = corr[m + N];
    if (!(c >= bestC - SYNC_CORR_TIE)) continue;
    const e = mse[m + N];
    if (e < bestE || (e === bestE && Math.abs(m) < Math.abs(best))) { bestE = e; best = m; }
  }

  // Parabolic refinement between neighbouring lags for sub-step accuracy, on
  // whichever measure is curved there (correlation is flat along a trend).
  const k = best + N;
  let frac = 0;
  const parabola = (a: number, b: number, c: number) => {
    const den = a - 2 * b + c;
    return den !== 0 ? Math.max(-0.5, Math.min(0.5, 0.5 * (a - c) / den)) : 0;
  };
  if (k > 0 && k < 2 * N) {
    const c0 = corr[k - 1], c1 = corr[k], c2 = corr[k + 1];
    const e0 = mse[k - 1], e1 = mse[k], e2 = mse[k + 1];
    if (isFinite(c0) && isFinite(c2) && c0 - 2 * c1 + c2 < -1e-9) frac = parabola(c0, c1, c2);
    else if (isFinite(e0) && isFinite(e2) && e0 - 2 * e1 + e2 > 0) frac = parabola(e0, e1, e2);
  }
  return { lag: best + frac, corr: corr[k] };
}

// Shifts `side`'s time (offset of its x-axis column) so that colIdx lines up
// with its matched column on the other side. The reference is the other side's
// data inside the graph's visible x window; the lag with the highest Pearson
// correlation, searched over +-one window width, wins.
function syncTimeOffset(side: Side, colIdx: number): void {
  if (!canSyncTime(side, colIdx)) return;
  const notify = (level: 'info' | 'warning', message: string) =>
    vscode.postMessage({ type: 'notify', level, message });
  const other = otherSide(side);
  const ref = timeSeries(other, getMappedCol(side, colIdx)!);
  const mov = timeSeries(side, colIdx);
  if (ref.t.length < 3 || mov.t.length < 3) { notify('warning', 'Not enough numeric data to sync.'); return; }

  // Visible window in time units. A graph plotted against row number is
  // converted through the reference side's time column.
  let a = ref.t[0], b = ref.t[ref.t.length - 1];
  const graphOpen = !document.getElementById('graph-container')!.classList.contains('hidden');
  const win = graphOpen ? getVisibleXWindow() : null;
  if (win) {
    if (win.isRowIndex) {
      const n = sideRowCount(other);
      const T = effectiveColumn(other, xAxisCol[other]);
      const rowTime = (r: number) => T[Math.max(0, Math.min(n - 1, Math.round(r) - 1))];
      const ta = rowTime(win.min), tb = rowTime(win.max);
      if (isFinite(ta) && isFinite(tb)) { a = Math.min(ta, tb); b = Math.max(ta, tb); }
    } else {
      a = win.min; b = win.max;
    }
  }
  a = Math.max(a, ref.t[0]);
  b = Math.min(b, ref.t[ref.t.length - 1]);
  if (!(b > a)) { notify('warning', 'The visible graph range has no reference data to sync with.'); return; }

  const N = SYNC_GRID;
  const dt = (b - a) / (N - 1);
  const r = resampleUniform(ref, a, dt, N);
  // Moving signal on an extended grid covering every tested lag:
  // s_lag(g_j) = mov(a + (j - m)*dt) = ext[j - m + N] for m in [-N, N].
  const ext = resampleUniform(mov, a - N * dt, dt, 3 * N);
  const found = findBestLag(r, ext, N);
  if (!found) { notify('warning', 'No variation to align in the visible range (flat data). Zoom out or pick another range.'); return; }
  const lag = found.lag * dt;
  const bestC = found.corr;

  const xCol = xAxisCol[side];
  const newOffset = parseFloat((getOffset(side, xCol) + lag).toPrecision(12));
  setSORowVisible('scale', true);
  setSORowVisible('offset', true);
  setSOValue('offset', side, xCol, newOffset);
  scheduleRender();
  updateToolbar();
  const name = (side === 'left' ? leftData : rightData)!.headers[xCol];
  notify('info', `${side === 'left' ? 'Left' : 'Right'} ${name} offset ${newOffset} (shift ${formatScaled(lag)}, correlation ${bestC.toFixed(3)})`);
}

// Undo a sync: this side's time (x-axis column) offset back to 0.0.
function resetTimeOffset(side: Side): void {
  const xCol = xAxisCol[side];
  if (xCol < 0) return;
  setSOValue('offset', side, xCol, 0);
  scheduleRender();
  updateToolbar();
}

// ---- Context menu ----

let ctxSide: Side = 'left';
let ctxColIdx: number = -1;
let lastCtxX = 0;
let lastCtxY = 0;

// "Match with…" flyout: lists the opposite side's columns so the user can
// pick which one this column should be paired with.
let matchListCtx: { side: Side; col: number } | null = null;

function showMatchList(side: Side, colIdx: number, x: number, y: number): void {
  const other = otherSide(side);
  const headers = (other === 'left' ? leftData : rightData)?.headers ?? [];
  const currentOther = getMappedCol(side, colIdx);
  const listEl = document.getElementById('ctx-match-list')!;
  listEl.innerHTML = '';
  headers.forEach((h, i) => {
    const li = document.createElement('li');
    li.dataset.col = String(i);
    li.classList.toggle('selected', i === currentOther);
    const tag = document.createElement('span');
    tag.className = `col-side ${other}`;
    tag.textContent = other === 'left' ? 'L' : 'R';
    const num = document.createElement('span');
    num.className = 'col-num';
    num.textContent = String(i);
    const name = document.createElement('span');
    name.className = 'col-name';
    name.textContent = h;
    li.append(tag, num, name);
    listEl.appendChild(li);
  });
  listEl.style.left = `${x}px`;
  listEl.style.top = `${y}px`;
  listEl.classList.remove('hidden');
  matchListCtx = { side, col: colIdx };
}

function hideMatchList(): void {
  document.getElementById('ctx-match-list')!.classList.add('hidden');
  matchListCtx = null;
}

function initContextMenu(): void {
  const menuEl = document.getElementById('context-menu')!;
  const matchListEl = document.getElementById('ctx-match-list')!;

  document.getElementById('ctx-reset-xaxis')!.addEventListener('click', () => {
    menuEl.classList.add('hidden');
    resetXAxis(ctxSide);
  });
  document.getElementById('ctx-set-xaxis')!.addEventListener('click', () => {
    menuEl.classList.add('hidden');
    if (ctxColIdx >= 0) setXAxis(ctxSide, ctxColIdx);
  });
  document.getElementById('ctx-show-hex')!.addEventListener('click', () => {
    menuEl.classList.add('hidden');
    if (ctxColIdx >= 0) setHex(ctxSide, ctxColIdx);
  });
  document.getElementById('ctx-show-diff')!.addEventListener('click', () => {
    menuEl.classList.add('hidden');
    if (ctxColIdx >= 0) setDiff(ctxSide, ctxColIdx);
  });
  document.getElementById('ctx-show-original')!.addEventListener('click', () => {
    menuEl.classList.add('hidden');
    if (ctxColIdx >= 0) clearTransform(ctxSide, ctxColIdx);
  });
  document.getElementById('ctx-goto-next-diff')!.addEventListener('click', () => {
    menuEl.classList.add('hidden');
    if (ctxColIdx >= 0) gotoNextDiff(ctxSide, ctxColIdx);
  });
  document.getElementById('ctx-goto-prev-diff')!.addEventListener('click', () => {
    menuEl.classList.add('hidden');
    if (ctxColIdx >= 0) gotoPrevDiff(ctxSide, ctxColIdx);
  });
  document.getElementById('ctx-goto-max-diff')!.addEventListener('click', () => {
    menuEl.classList.add('hidden');
    if (ctxColIdx >= 0) gotoMaxDiff(ctxSide, ctxColIdx);
  });
  document.getElementById('ctx-goto-prev-nan')!.addEventListener('click', () => {
    menuEl.classList.add('hidden');
    if (ctxColIdx >= 0) gotoNaN(ctxSide, ctxColIdx, -1);
  });
  document.getElementById('ctx-goto-next-nan')!.addEventListener('click', () => {
    menuEl.classList.add('hidden');
    if (ctxColIdx >= 0) gotoNaN(ctxSide, ctxColIdx, 1);
  });
  [10, 30, 100, 1000].forEach(n => {
    document.getElementById(`ctx-show-movavg-${n}`)!.addEventListener('click', () => {
      menuEl.classList.add('hidden');
      if (ctxColIdx >= 0) setMovAvg(ctxSide, ctxColIdx, n);
    });
  });
  document.getElementById('ctx-match-with')!.addEventListener('click', e => {
    // Stop this click from reaching the document-level listener below, which
    // would otherwise immediately hide the flyout list we're about to open.
    e.stopPropagation();
    menuEl.classList.add('hidden');
    if (ctxColIdx >= 0) showMatchList(ctxSide, ctxColIdx, lastCtxX, lastCtxY);
  });
  document.getElementById('ctx-clear-match')!.addEventListener('click', () => {
    menuEl.classList.add('hidden');
    if (ctxColIdx >= 0) clearManualMatch(ctxSide, ctxColIdx);
  });
  document.getElementById('ctx-sync')!.addEventListener('click', () => {
    menuEl.classList.add('hidden');
    if (ctxColIdx >= 0) syncTimeOffset(ctxSide, ctxColIdx);
  });
  document.getElementById('ctx-reset-sync')!.addEventListener('click', () => {
    menuEl.classList.add('hidden');
    resetTimeOffset(ctxSide);
  });
  matchListEl.addEventListener('click', e => {
    const li = (e.target as HTMLElement).closest<HTMLElement>('li[data-col]');
    if (!li || !matchListCtx) return;
    const otherCol = parseInt(li.dataset.col!, 10);
    const li_ = matchListCtx.side === 'left' ? matchListCtx.col : otherCol;
    const ri_ = matchListCtx.side === 'left' ? otherCol : matchListCtx.col;
    setManualMatch(li_, ri_);
    hideMatchList();
  });

  document.addEventListener('click', () => { menuEl.classList.add('hidden'); hideMatchList(); });
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') { menuEl.classList.add('hidden'); hideMatchList(); }
  });
}

function showContextMenu(side: Side, x: number, y: number, colIndex: number): void {
  hideMatchList();
  ctxSide = side;
  ctxColIdx = colIndex;

  const isXAxis = colIndex >= 0 && colIndex === xAxisCol[side];
  const isDiff = colIndex >= 0 && diffCols[side].has(colIndex);
  const movAvgWin = colIndex >= 0 ? movAvgCols[side].get(colIndex) : undefined;
  const isHexCol = colIndex >= 0 && hexCols[side].has(colIndex);
  // Scale/offset is orthogonal to the value transforms, so it only affects
  // whether "Show original values" is offered — not the diff/movavg entries.
  const isValueTransformed = isDiff || movAvgWin !== undefined || isHexCol;
  const isTransformed = isValueTransformed || (colIndex >= 0 && isScaled(side, colIndex));
  const xAxisIsDefault = xAxisCol[side] === defaultXAxisCol[side];

  const setItemVisible = (id: string, visible: boolean) =>
    document.getElementById(id)!.classList.toggle('hidden', !visible);

  setItemVisible('ctx-reset-xaxis', isXAxis && !xAxisIsDefault);
  setItemVisible('ctx-set-xaxis', colIndex >= 0 && !isXAxis);
  setItemVisible('ctx-show-hex', colIndex >= 0 && !isHexCol);
  setItemVisible('ctx-show-diff', colIndex >= 0 && !isValueTransformed);
  setItemVisible('ctx-show-movavg-10', colIndex >= 0 && !isDiff && !isHexCol && movAvgWin !== 10);
  setItemVisible('ctx-show-movavg-30', colIndex >= 0 && !isDiff && !isHexCol && movAvgWin !== 30);
  setItemVisible('ctx-show-movavg-100', colIndex >= 0 && !isDiff && !isHexCol && movAvgWin !== 100);
  setItemVisible('ctx-show-movavg-1000', colIndex >= 0 && !isDiff && !isHexCol && movAvgWin !== 1000);
  setItemVisible('ctx-show-original', colIndex >= 0 && isTransformed);
  const hasDiffCol = colIndex >= 0 && diffColumnSet[side].has(colIndex);
  const hasMappedCol = colIndex >= 0 && getMappedCol(side, colIndex) !== undefined;
  setItemVisible('ctx-goto-next-diff', hasDiffCol);
  setItemVisible('ctx-goto-prev-diff', hasDiffCol);
  setItemVisible('ctx-goto-max-diff', hasMappedCol);
  setItemVisible('ctx-diff-sep', (hasDiffCol || hasMappedCol) && colIndex >= 0);
  setItemVisible('ctx-match-sep', colIndex >= 0);
  setItemVisible('ctx-match-with', colIndex >= 0);
  setItemVisible('ctx-clear-match', hasMappedCol);
  const canSync = hasMappedCol && canSyncTime(side, colIndex);
  // Reset sync is also offered on the time (x-axis) column itself, where
  // syncing makes no sense but undoing a previous sync does.
  const canResetSync = (canSync || isXAxis) && xAxisCol[side] >= 0 && getOffset(side, xAxisCol[side]) !== 0;
  setItemVisible('ctx-sync-sep', canSync || canResetSync);
  setItemVisible('ctx-sync', canSync);
  setItemVisible('ctx-reset-sync', canResetSync);
  setItemVisible('ctx-sync-sep2', canSync || canResetSync);
  document.getElementById('ctx-sync')!.textContent =
    side === 'left' ? 'Sync with right data' : 'Sync with left data';

  const hasStats = colIndex >= 0;
  // Turned on below if the column has NaNs.
  setItemVisible('ctx-goto-prev-nan', false);
  setItemVisible('ctx-goto-next-nan', false);
  setItemVisible('ctx-stats-sep', hasStats);
  setItemVisible('ctx-stats', hasStats);
  if (hasStats) {
    let maxV = -Infinity, minV = Infinity, sum = 0, count = 0, nanCount = 0;
    const vals = effectiveColumn(side, colIndex);
    for (let i = 0; i < vals.length; i++) {
      const v = vals[i];
      if (isFinite(v)) { maxV = Math.max(maxV, v); minV = Math.min(minV, v); sum += v; count++; }
      else nanCount++;
    }
    // Only worth offering on a numeric column that actually has gaps — a text
    // column would be all "NaN" by this measure.
    setItemVisible('ctx-goto-prev-nan', count > 0 && nanCount > 0);
    setItemVisible('ctx-goto-next-nan', count > 0 && nanCount > 0);
    const fmt = (v: number) => {
      if (!isFinite(v)) return 'N/A';
      const abs = Math.abs(v);
      if (abs === 0) return '0';
      if (abs >= 1e6 || (abs > 0 && abs < 1e-3)) return v.toExponential(4);
      return parseFloat(v.toPrecision(6)).toString();
    };
    const statsEl = document.getElementById('ctx-stats')!;
    if (count > 0) {
      statsEl.innerHTML =
        `max: ${fmt(maxV)}<br>min: ${fmt(minV)}<br>max−min: ${fmt(maxV - minV)}<br>mean: ${fmt(sum / count)}` +
        `<br>NaN: ${nanCount.toLocaleString()}`;
    } else {
      statsEl.innerHTML = '(no numeric data)';
    }
  }

  lastCtxX = x;
  lastCtxY = y;

  const menuEl = document.getElementById('context-menu')!;
  menuEl.style.left = `${x}px`;
  menuEl.style.top = `${y}px`;
  menuEl.classList.remove('hidden');
}

// ---- Message handling ----

// Each file is streamed as loadStart -> loadChunk* -> loadEnd (see
// CompareViewProvider) to stay under the webview message size limit. Accumulate
// each side's rows, then commit once BOTH sides finish for the same sequence.
type SideAccum = { seq: number; table: TableBuilder; done: boolean };
const compareAccum: { left: SideAccum | null; right: SideAccum | null } =
  { left: null, right: null };

function showLoading(): void {
  document.getElementById('loading-overlay')?.classList.remove('hidden');
  updateLoadingProgress();
}

function hideLoading(): void {
  document.getElementById('loading-overlay')?.classList.add('hidden');
}

function updateLoadingProgress(): void {
  const el = document.getElementById('loading-text');
  if (!el) return;
  const loaded = (compareAccum.left?.table.loaded ?? 0) + (compareAccum.right?.table.loaded ?? 0);
  const total = (compareAccum.left?.table.meta.totalRows ?? 0) + (compareAccum.right?.table.meta.totalRows ?? 0);
  el.textContent = total > 0
    ? `로딩 중... ${loaded.toLocaleString()} / ${total.toLocaleString()} 행`
    : '로딩 중...';
}

window.addEventListener('message', (event: MessageEvent) => {
  const msg = event.data as ExtensionToWebviewMessage;

  if (msg.type === 'loadStart' && (msg.channel === 'left' || msg.channel === 'right')) {
    compareAccum[msg.channel] = { seq: msg.seq, table: new TableBuilder(msg.meta), done: false };
    showLoading();
  } else if (msg.type === 'loadChunk' && (msg.channel === 'left' || msg.channel === 'right')) {
    const a = compareAccum[msg.channel];
    if (a && a.seq === msg.seq) {
      a.table.add(msg);
      updateLoadingProgress();
    }
  } else if (msg.type === 'loadEnd' && (msg.channel === 'left' || msg.channel === 'right')) {
    const a = compareAccum[msg.channel];
    if (a && a.seq === msg.seq) {
      a.done = true;
      const l = compareAccum.left;
      const r = compareAccum.right;
      if (l && r && l.done && r.done && l.seq === r.seq) {
        const left = l.table.finish();
        const right = r.table.finish();
        compareAccum.left = null;
        compareAccum.right = null;
        commitCompareData(left, right);
        hideLoading();
      }
    }
  } else if (msg.type === 'error') {
    document.getElementById('compare-wrapper')!.innerHTML =
      `<div class="error-message">${escapeHtml(msg.message)}</div>`;
    hideLoading();
  }
});

function updateFileLabels(): void {
  if (!leftData || !rightData) return;
  const lPath = leftData.filePath ?? leftData.fileName;
  const rPath = rightData.filePath ?? rightData.fileName;
  const sep = lPath.includes('/') ? '/' : '\\';
  const lParts = lPath.split(sep);
  const rParts = rPath.split(sep);
  let common = 0;
  while (common < lParts.length - 1 && common < rParts.length - 1 && lParts[common] === rParts[common]) common++;
  document.getElementById('left-file-name')!.textContent = lParts.slice(common).join(sep);
  document.getElementById('right-file-name')!.textContent = rParts.slice(common).join(sep);

  if (leftData.truncated || rightData.truncated || leftData.rows.length !== rightData.rows.length) {
    document.getElementById('truncate-notice')!.textContent =
      `Rows ${leftData.rows.length.toLocaleString()} / ${rightData.rows.length.toLocaleString()} (values compared over first ${commonRowCount.toLocaleString()})`;
    document.getElementById('truncate-notice')!.classList.remove('hidden');
  } else {
    document.getElementById('truncate-notice')!.classList.add('hidden');
  }
}

// Swap which side (left/right) each loaded file is displayed on, along with
// all per-side view state (selection, x-axis, diff/movavg/hex, column widths).
function swapSides(): void {
  if (!leftData || !rightData) return;

  [leftData, rightData] = [rightData, leftData];
  [selectedCols.left, selectedCols.right] = [selectedCols.right, selectedCols.left];
  [xAxisCol.left, xAxisCol.right] = [xAxisCol.right, xAxisCol.left];
  [defaultXAxisCol.left, defaultXAxisCol.right] = [defaultXAxisCol.right, defaultXAxisCol.left];
  [diffCols.left, diffCols.right] = [diffCols.right, diffCols.left];
  [movAvgCols.left, movAvgCols.right] = [movAvgCols.right, movAvgCols.left];
  [hexCols.left, hexCols.right] = [hexCols.right, hexCols.left];
  [scales.left, scales.right] = [scales.right, scales.left];
  [offsets.left, offsets.right] = [offsets.right, offsets.left];
  [colWidths.left, colWidths.right] = [colWidths.right, colWidths.left];
  [lastClickedCol.left, lastClickedCol.right] = [lastClickedCol.right, lastClickedCol.left];

  // Manual overrides are keyed by left-column index; swapping which physical
  // side is "left" would invert their meaning, so drop them and let the
  // fresh auto-match run instead of transposing them.
  matchOverrides.clear();
  buildColumnMapping(leftData.headers, rightData.headers);
  computeDiffColumns();
  updateFileLabels();

  initPane('left', leftData);
  initPane('right', rightData);
  applyHighlight('left');
  applyHighlight('right');
  renderHeaderPanel();
  scheduleRender();
  updateToolbar();
}

function commitCompareData(left: TableFile, right: TableFile): void {
  {
    leftData = left;
    rightData = right;
    displayRowCount = Math.max(leftData.rows.length, rightData.rows.length);
    commonRowCount = Math.min(leftData.rows.length, rightData.rows.length);
    buildColumnMapping(leftData.headers, rightData.headers);
    applyMatchOverrides();

    updateFileLabels();

    computeDiffColumns();

    // Compute per-pane column widths, then force each matched (mapped) pair to a
    // common width so left/right columns of the same header line up.
    colWidths.left = computeColumnWidths(leftData);
    colWidths.right = computeColumnWidths(rightData);
    for (const [li, ri] of columnMapping) {
      const w = Math.max(colWidths.left[li] ?? 0, colWidths.right[ri] ?? 0);
      if (w > 0) { colWidths.left[li] = w; colWidths.right[ri] = w; }
    }

    initPane('left', leftData);
    initPane('right', rightData);
    applyHighlight('left');
    applyHighlight('right');
    restoreCompareReloadState();
    renderHeaderPanel();
    updateToolbar();
  }
}


function escapeHtml(str: string): string {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ---- Drag scroll ----

// Show the full cell value in a floating overlay when the pointer rests on a
// cell whose value is clipped by the fixed column width.
let cellTipTimer: ReturnType<typeof setTimeout> | null = null;

function hideCellTooltip(): void {
  if (cellTipTimer !== null) { clearTimeout(cellTipTimer); cellTipTimer = null; }
  document.getElementById('cell-tooltip')?.classList.add('hidden');
}

function showCellTooltip(td: HTMLElement): void {
  const tip = document.getElementById('cell-tooltip')!;
  tip.textContent = td.textContent ?? '';
  tip.classList.remove('hidden');
  const cell = td.getBoundingClientRect();
  const tw = tip.offsetWidth;
  const th = tip.offsetHeight;
  let x = cell.left;
  let y = cell.bottom + 2;
  if (x + tw > window.innerWidth - 4) x = window.innerWidth - tw - 4;
  if (x < 4) x = 4;
  if (y + th > window.innerHeight - 4) y = cell.top - th - 2;
  tip.style.left = `${x}px`;
  tip.style.top = `${y}px`;
}

// Hovering a column in either pane lights up that column's line in the graph.
// Only the hovered side lights up: the matched column on the other side keeps
// its normal styling so the two lines stay distinguishable.
function initColumnHover(side: Side, container: HTMLElement): void {
  container.addEventListener('mouseover', e => {
    const cell = (e.target as HTMLElement).closest<HTMLElement>('[data-col-index]');
    const col = cell ? parseInt(cell.dataset.colIndex!, 10) : NaN;
    if (isNaN(col)) { setHoveredColumns(null, null); return; }
    setHoveredColumns(side === 'left' ? col : null, side === 'left' ? null : col);
  });
  container.addEventListener('mouseleave', () => setHoveredColumns(null, null));
}

function initCellTooltip(container: HTMLElement): void {
  container.addEventListener('mouseover', e => {
    const td = (e.target as HTMLElement).closest<HTMLElement>('td[data-col-index], th[data-col-index]');
    if (!td) { hideCellTooltip(); return; }
    if (td.scrollWidth <= td.clientWidth + 1) { hideCellTooltip(); return; }
    if (cellTipTimer !== null) clearTimeout(cellTipTimer);
    cellTipTimer = setTimeout(() => { cellTipTimer = null; showCellTooltip(td); }, 400);
  });
  container.addEventListener('mouseout', hideCellTooltip);
  container.addEventListener('scroll', hideCellTooltip, { passive: true });
}

// ---- Column search (type-to-find header) ----
// Typing an alphanumeric key opens an overlay listing headers (from both panes)
// containing the typed text; Up/Down + Enter or a click centers that column.
let colSearchActive = false;
let colSearchMatches: { side: Side; col: number }[] = [];
let colSearchSel = 0;

function centerPaneColumn(side: Side, col: number): void {
  const pane = document.getElementById(`${side}-pane`)!;
  if (col === 0) { pane.scrollLeft = 0; return; }
  const th = document.querySelector<HTMLElement>(`#${side}-header-row th[data-col-index="${col}"]`);
  if (!th) return;
  // offsetLeft is measured against offsetParent, and a `position: sticky` th has
  // no table/pane offsetParent — it falls through to <body>. On the right pane
  // that adds the left pane's width, scrolling far past the target column, so
  // measure the header cell against the pane itself instead.
  const paneRect = pane.getBoundingClientRect();
  const thRect = th.getBoundingClientRect();
  const colLeft = thRect.left - paneRect.left + pane.scrollLeft;
  pane.scrollLeft = Math.max(0, colLeft + thRect.width / 2 - pane.clientWidth / 2);
}

function flashColumn(side: Side, col: number): void {
  document.querySelectorAll(`#${side}-header-row th[data-col-index="${col}"], #${side}-col-index-row th[data-col-index="${col}"]`)
    .forEach(el => { void (el as HTMLElement).offsetWidth; el.classList.add('col-flash'); });
}

function gotoCompareColumn(side: Side, col: number): void {
  const other = otherSide(side);
  // The column mapping is the only authority on which pair belongs together:
  // it already prefers exact header names and carries the user's "Match with…"
  // overrides. Looking the other pane up by header name instead would center
  // the panes on two columns that are not actually matched (e.g. a manually
  // re-matched column whose name still exists elsewhere on the other side).
  const otherCol = getMappedCol(side, col);

  document.querySelectorAll('.col-flash').forEach(el => el.classList.remove('col-flash'));

  // Break scroll sync so each pane can center its own matched column. Sync
  // resumes on the next user scroll (see recouple listeners).
  scrollDecoupled = true;
  centerPaneColumn(side, col);
  if (otherCol !== undefined) centerPaneColumn(other, otherCol);

  flashColumn(side, col);
  if (otherCol !== undefined) flashColumn(other, otherCol);
}

// ---- Graph open ----

function isGraphOpen(): boolean {
  return !document.getElementById('graph-container')!.classList.contains('hidden');
}

function closeGraphPane(): void {
  closeGraph();
  (document.getElementById('sel-graph-mode') as HTMLSelectElement).value = 'original';
  crosshairRowIdx = null;
  applyRowHighlight('left');
  applyRowHighlight('right');
  updateToolbar();
}

function showGraph(): void {
  if (!leftData || !rightData) return;
  resetZoom();
  resetCrosshairs();
  renderGraph(
    leftData.headers, graphSource('left'), Array.from(selectedCols.left), xAxisCol.left,
    { headers: rightData.headers, src: graphSource('right'), selectedCols: Array.from(selectedCols.right), xAxisCol: xAxisCol.right, xAxisIsOriginal: isXAxisOriginal('right') },
    isXAxisOriginal('left')
  );
  syncViewport();
  document.getElementById('btn-show-graph')!.classList.add('active');
}

// The first column click in the table or Header panel opens the graph for it, so a fresh view
// needs no separate "Show graph" step. Only once per view: after the user closes
// the graph, further clicks just select.
let autoGraphDone = false;

function autoShowGraphOnFirstClick(e: MouseEvent): void {
  const cell = (e.target as HTMLElement).closest('td[data-col-index], th[data-col-index]');
  if (!cell || cell.closest('.scale-row, .offset-row')) return;
  maybeAutoShowGraph();
}

// Called after a column click (table or Header panel) updated the selection.
function maybeAutoShowGraph(): void {
  if (autoGraphDone) return;
  if (!document.getElementById('graph-container')!.classList.contains('hidden')) { autoGraphDone = true; return; }
  const dataSelected = (side: Side) => Array.from(selectedCols[side]).some(c => c !== xAxisCol[side]);
  if (!dataSelected('left') && !dataSelected('right')) return;
  autoGraphDone = true;
  showGraph();
}

// ---- Header panel (column list) ----

let headerPanelOpen = true;

function renderHeaderPanel(): void {
  const list = document.getElementById('header-panel-list')!;
  list.innerHTML = '';
  const addRows = (side: Side, headers: string[] | undefined, skip?: (i: number) => boolean) => {
    headers?.forEach((h, i) => {
      if (skip?.(i)) return;
      const li = document.createElement('li');
      li.dataset.side = side;
      li.dataset.col = String(i);
      li.classList.toggle('col-has-diff', diffColumnSet[side].has(i));
      const tag = document.createElement('span');
      tag.className = `col-side ${side}`;
      tag.textContent = side === 'left' ? 'L' : 'R';
      const num = document.createElement('span');
      num.className = 'col-num';
      num.textContent = String(i);
      const name = document.createElement('span');
      name.className = 'col-name';
      // A left column matched to a differently named right column (fuzzy or
      // manual match) shows both names so the pairing is visible.
      const ri = side === 'left' ? columnMapping.get(i) : undefined;
      const rightName = ri !== undefined ? rightData?.headers[ri] : undefined;
      name.textContent = rightName !== undefined && rightName !== h ? `${h} \u2194 ${rightName}` : h;
      name.title = name.textContent;
      li.appendChild(tag);
      li.appendChild(num);
      li.appendChild(name);
      list.appendChild(li);
    });
  };
  addRows('left', leftData?.headers);
  // Left/right columns are mostly the same (matched by header name), so only
  // list right-side columns that have no match on the left; matched columns
  // are already reachable via their left-side row (selecting it selects both).
  addRows('right', rightData?.headers, i => reverseMapping.has(i));
  updateHeaderPanelSelection();
}

function updateHeaderPanelSelection(): void {
  document.querySelectorAll<HTMLElement>('#header-panel-list li').forEach(li => {
    const side = li.dataset.side as Side;
    const col = parseInt(li.dataset.col!, 10);
    const isXAxis = col === xAxisCol[side];
    li.classList.toggle('selected', selectedCols[side].has(col) && !isXAxis);
    li.classList.toggle('x-axis', isXAxis);
  });
}

function toggleHeaderPanel(): void {
  headerPanelOpen = !headerPanelOpen;
  document.getElementById('header-panel')!.classList.toggle('hidden', !headerPanelOpen);
  document.getElementById('btn-toggle-header')!.classList.toggle('active', headerPanelOpen);
}

function initHeaderPanel(): void {
  document.getElementById('btn-toggle-header')!.addEventListener('click', toggleHeaderPanel);
  const list = document.getElementById('header-panel-list')!;
  // Prevent native text-selection drag when shift-clicking to select a range.
  list.addEventListener('mousedown', e => { if (e.shiftKey) e.preventDefault(); });
  list.addEventListener('click', e => {
    const li = (e.target as HTMLElement).closest<HTMLElement>('li[data-side]');
    if (!li) return;
    const side = li.dataset.side as Side;
    const colIdx = parseInt(li.dataset.col!, 10);
    handleColumnClick(side, colIdx, e);
    gotoCompareColumn(side, colIdx);
    maybeAutoShowGraph();
  });
  list.addEventListener('contextmenu', e => {
    const li = (e.target as HTMLElement).closest<HTMLElement>('li[data-side]');
    if (!li) return;
    e.preventDefault();
    showContextMenu(li.dataset.side as Side, e.clientX, e.clientY, parseInt(li.dataset.col!, 10));
  });
}

function renderColSearchList(): void {
  const ul = document.getElementById('col-search-list')!;
  ul.innerHTML = '';
  if (colSearchMatches.length === 0) {
    const empty = document.createElement('li');
    empty.id = 'col-search-empty';
    empty.textContent = 'No matching column';
    ul.appendChild(empty);
    return;
  }
  colSearchMatches.forEach((m, idx) => {
    const headers = m.side === 'left' ? leftData?.headers : rightData?.headers;
    const li = document.createElement('li');
    li.dataset.matchIdx = String(idx);
    if (idx === colSearchSel) li.classList.add('selected');
    const tag = document.createElement('span');
    tag.className = `col-side ${m.side}`;
    tag.textContent = m.side === 'left' ? 'L' : 'R';
    const num = document.createElement('span');
    num.className = 'col-num';
    num.textContent = String(m.col);
    const name = document.createElement('span');
    name.textContent = headers?.[m.col] ?? '';
    li.appendChild(tag);
    li.appendChild(num);
    li.appendChild(name);
    ul.appendChild(li);
  });
}

function updateColSearch(): void {
  const input = document.getElementById('col-search-input') as HTMLInputElement;
  // Space-separated terms are ANDed: "abc def" matches headers containing both.
  const tokens = input.value.trim().toLowerCase().split(/\s+/).filter(t => t.length > 0);
  const matchHeader = (h: string) => { const hl = h.toLowerCase(); return tokens.every(t => hl.includes(t)); };
  colSearchMatches = [];
  const listedLeft = new Set<number>();
  leftData?.headers.forEach((h, i) => {
    if (!matchHeader(h)) return;
    colSearchMatches.push({ side: 'left', col: i });
    listedLeft.add(i);
  });
  // A matched pair is one logical column, so listing it from both sides would
  // give two rows that jump to the exact same place (the "R …" row would look
  // like it selected the left pane). Keep a right-side row only when its
  // partner is not already listed — i.e. the column is unmatched, or only the
  // right pane's header matches what was typed.
  rightData?.headers.forEach((h, i) => {
    if (!matchHeader(h)) return;
    const li = reverseMapping.get(i);
    if (li !== undefined && listedLeft.has(li)) return;
    colSearchMatches.push({ side: 'right', col: i });
  });
  colSearchSel = 0;
  renderColSearchList();
}

function moveColSearchSel(delta: number): void {
  if (colSearchMatches.length === 0) return;
  colSearchSel = Math.max(0, Math.min(colSearchMatches.length - 1, colSearchSel + delta));
  renderColSearchList();
  document.querySelector('#col-search-list li.selected')?.scrollIntoView({ block: 'nearest' });
}

function commitColSearch(): void {
  if (colSearchMatches.length === 0) return;
  const m = colSearchMatches[colSearchSel];
  closeColSearch();
  gotoCompareColumn(m.side, m.col);
}

function openColSearch(initialChar: string): void {
  if (!leftData && !rightData) return;
  colSearchActive = true;
  document.getElementById('col-search')!.classList.remove('hidden');
  const input = document.getElementById('col-search-input') as HTMLInputElement;
  input.value = initialChar;
  input.focus();
  updateColSearch();
}

function closeColSearch(): void {
  if (!colSearchActive) return;
  colSearchActive = false;
  document.getElementById('col-search')!.classList.add('hidden');
  const input = document.getElementById('col-search-input') as HTMLInputElement;
  input.value = '';
  input.blur();
}

function initColSearch(): void {
  const input = document.getElementById('col-search-input') as HTMLInputElement;
  const list = document.getElementById('col-search-list')!;

  input.addEventListener('input', updateColSearch);
  input.addEventListener('keydown', e => {
    if (e.key === 'ArrowDown') { e.preventDefault(); moveColSearchSel(1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); moveColSearchSel(-1); }
    else if (e.key === 'Enter') { e.preventDefault(); commitColSearch(); }
    else if (e.key === 'Escape') { e.preventDefault(); closeColSearch(); }
  });
  list.addEventListener('mousedown', e => e.preventDefault());
  list.addEventListener('click', e => {
    const li = (e.target as HTMLElement).closest<HTMLElement>('li[data-match-idx]');
    if (!li) return;
    colSearchSel = parseInt(li.dataset.matchIdx!);
    commitColSearch();
  });

  document.addEventListener('keydown', e => {
    if (colSearchActive) return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const tag = (document.activeElement as HTMLElement)?.tagName;
    if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
    if (e.key.length === 1 && /[a-zA-Z0-9]/.test(e.key)) {
      e.preventDefault();
      openColSearch(e.key);
    }
  });

  document.addEventListener('mousedown', e => {
    if (!colSearchActive) return;
    if (!(e.target as HTMLElement).closest('#col-search')) closeColSearch();
  });
}

function addDragScroll(container: HTMLElement): void {
  container.addEventListener('mousedown', (e: MouseEvent) => {
    if (e.button !== 0) return;
    // Don't hijack drags that start inside a scale/offset input — those select text.
    if ((e.target as HTMLElement).closest('input, select, textarea')) return;
    const startX = e.clientX;
    const startY = e.clientY;
    const startScrollLeft = container.scrollLeft;
    const startScrollTop = container.scrollTop;
    let dragging = false;

    const onMove = (ev: MouseEvent) => {
      const dx = ev.clientX - startX;
      const dy = ev.clientY - startY;
      if (!dragging && Math.abs(dx) + Math.abs(dy) > 5) {
        dragging = true;
        container.style.cursor = 'grabbing';
        document.body.style.userSelect = 'none';
      }
      if (dragging) {
        container.scrollLeft = startScrollLeft - dx;
        container.scrollTop = startScrollTop - dy;
      }
    };

    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      if (dragging) {
        container.style.cursor = '';
        document.body.style.userSelect = '';
        const onClickCapture = (ev: MouseEvent) => {
          ev.stopPropagation();
          container.removeEventListener('click', onClickCapture, true);
        };
        container.addEventListener('click', onClickCapture, true);
        setTimeout(() => container.removeEventListener('click', onClickCapture, true), 300);
      }
    };

    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  });
}

// ---- DOMContentLoaded ----

document.addEventListener('DOMContentLoaded', () => {
  initContextMenu();

  setRowHighlightCallback((rowIdx: number) => {
    crosshairRowIdx = rowIdx;
    applyRowHighlight('left');
    applyRowHighlight('right');
    scrollToRow(rowIdx);
  });
  setExtraYValuesCallback(buildDiffStatsHtml);

  // Scroll sync
  const leftPane = document.getElementById('left-pane')!;
  const rightPane = document.getElementById('right-pane')!;

  addDragScroll(leftPane);
  addDragScroll(rightPane);
  initCellTooltip(leftPane);
  initCellTooltip(rightPane);
  initColumnHover('left', leftPane);
  initColumnHover('right', rightPane);
  initColSearch();
  initHeaderPanel();

  // A user-initiated scroll (wheel or drag) re-enables left/right sync after a
  // column-search jump decoupled the panes.
  const recouple = () => { scrollDecoupled = false; };
  leftPane.addEventListener('wheel', recouple, { passive: true });
  rightPane.addEventListener('wheel', recouple, { passive: true });
  leftPane.addEventListener('mousedown', recouple);
  rightPane.addEventListener('mousedown', recouple);

  leftPane.addEventListener('scroll', () => {
    if (syncScrollFlag) return;
    if (scrollDecoupled) { scheduleRender(); syncViewport(); return; }
    syncScrollFlag = true;
    rightPane.scrollTop = leftPane.scrollTop;
    rightPane.scrollLeft = leftPane.scrollLeft;
    syncScrollFlag = false;
    scheduleRender();
    syncViewport();
  }, { passive: true });

  rightPane.addEventListener('scroll', () => {
    if (syncScrollFlag) return;
    if (scrollDecoupled) { scheduleRender(); syncViewport(); return; }
    syncScrollFlag = true;
    leftPane.scrollTop = rightPane.scrollTop;
    leftPane.scrollLeft = rightPane.scrollLeft;
    syncScrollFlag = false;
    scheduleRender();
    syncViewport();
  }, { passive: true });

  // Context menu on both panes
  for (const side of ['left', 'right'] as Side[]) {
    document.getElementById(`${side}-pane`)!.addEventListener('contextmenu', e => {
      e.preventDefault();
      const target = e.target as HTMLElement;
      const colIndexStr = target.closest<HTMLElement>('[data-col-index]')?.dataset.colIndex;
      const colIndex = colIndexStr !== undefined ? parseInt(colIndexStr) : -1;
      showContextMenu(side, e.clientX, e.clientY, colIndex);
    });
  }

  // Graph resize
  const graphContainer = document.getElementById('graph-container')!;
  document.getElementById('graph-resize-handle')!.addEventListener('mousedown', e => {
    const startY = e.clientY;
    const startHeight = graphContainer.offsetHeight;
    document.body.style.cursor = 'ns-resize';
    document.body.style.userSelect = 'none';
    const onMove = (ev: MouseEvent) => {
      const newHeight = Math.max(80, Math.min(window.innerHeight - 60, startHeight + startY - ev.clientY));
      graphContainer.style.height = `${newHeight}px`;
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', () => {
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      document.removeEventListener('mousemove', onMove);
    }, { once: true });
    e.preventDefault();
  });

  // Pane divider drag
  const divider = document.getElementById('pane-divider')!;
  const wrapper = document.getElementById('compare-wrapper')!;
  divider.addEventListener('mousedown', e => {
    const startX = e.clientX;
    const startLeftW = leftPane.offsetWidth;
    const totalW = wrapper.offsetWidth - divider.offsetWidth;
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    const onMove = (ev: MouseEvent) => {
      const newLeftW = Math.max(80, Math.min(totalW - 80, startLeftW + ev.clientX - startX));
      leftPane.style.flex = 'none';
      leftPane.style.width = `${newLeftW}px`;
      rightPane.style.flex = '1';
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', () => {
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      document.removeEventListener('mousemove', onMove);
    }, { once: true });
    e.preventDefault();
  });

  // Toolbar buttons
  document.getElementById('btn-top')!.addEventListener('click', () => {
    leftPane.scrollTop = 0;
    rightPane.scrollTop = 0;
    scheduleRender();
  });
  document.getElementById('btn-bottom')!.addEventListener('click', () => {
    leftPane.scrollTop = leftPane.scrollHeight;
    rightPane.scrollTop = rightPane.scrollHeight;
    scheduleRender();
  });
  document.getElementById('btn-left')!.addEventListener('click', () => {
    recouple();
    leftPane.scrollLeft = 0;
    rightPane.scrollLeft = 0;
  });
  document.getElementById('btn-right')!.addEventListener('click', () => {
    recouple();
    leftPane.scrollLeft = leftPane.scrollWidth;
    rightPane.scrollLeft = rightPane.scrollWidth;
  });

  document.getElementById('btn-show-graph')!.addEventListener('click', () => {
    if (isGraphOpen()) closeGraphPane(); else showGraph();
  });
  // Bubble phase: runs after the cell's own click handler updated the selection.
  document.getElementById('left-pane')!.addEventListener('click', autoShowGraphOnFirstClick);
  document.getElementById('right-pane')!.addEventListener('click', autoShowGraphOnFirstClick);

  document.getElementById('btn-scale-offset')!.addEventListener('click', () => {
    const visible = !(scaleRowVisible && offsetRowVisible);
    setSORowVisible('scale', visible);
    setSORowVisible('offset', visible);
    updateToolbar();
  });
  document.getElementById('btn-reset-all')!.addEventListener('click', resetAll);
  document.getElementById('btn-swap')!.addEventListener('click', swapSides);
  document.getElementById('btn-reload')!.addEventListener('click', () => {
    saveCompareReloadState();
    showLoading();
    vscode.postMessage({ type: 'reload' });
  });

  document.getElementById('btn-hide-crosshair')!.addEventListener('click', hideCrosshairs);

  document.getElementById('sel-graph-mode')!.addEventListener('change', e => {
    const mode = (e.target as HTMLSelectElement).value as 'original' | 'L-R' | 'R-L' | '|L-R|';
    setGraphDiffMode(mode);
  });

  document.getElementById('btn-close-graph')!.addEventListener('click', closeGraphPane);

  document.getElementById('sel-line-width')!.addEventListener('change', e => {
    setLineWidth(parseFloat((e.target as HTMLSelectElement).value));
  });
  document.getElementById('sel-marker')!.addEventListener('change', e => {
    setMarkerStyle((e.target as HTMLSelectElement).value);
  });

  initGraphSave(msg => vscode.postMessage(msg));
  vscode.postMessage({ type: 'ready' });
});
