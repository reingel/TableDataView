import { ExtensionToWebviewMessage, ParsedFile, ParsedMeta } from '../types';
import { renderGraph, resetZoom, resetCrosshairs, hideCrosshairs, closeGraph, setLineWidth, setMarkerStyle, setRowHighlightCallback, setExtraYValuesCallback, setCrosshairToRow, setHoveredColumns, updateViewport, setGraphDiffMode } from './graphRenderer';
import { detectDefaultXAxis, SEQ_X } from './columnSelector';

declare function acquireVsCodeApi(): { postMessage: (msg: object) => void };
const vscode = acquireVsCodeApi();

type Side = 'left' | 'right';

const BUFFER = 40;
let ROW_HEIGHT = 24;

let leftData: ParsedFile | null = null;
let rightData: ParsedFile | null = null;
let displayRowCount = 0;

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
let scaleRowVisible = false;
let offsetRowVisible = false;
const scales: Record<Side, number[]> = { left: [], right: [] };
const offsets: Record<Side, number[]> = { left: [], right: [] };
const xAxisCol: Record<Side, number> = { left: SEQ_X, right: SEQ_X };
const defaultXAxisCol: Record<Side, number> = { left: SEQ_X, right: SEQ_X };
const selectedCols: Record<Side, Set<number>> = { left: new Set(), right: new Set() };

// Columns that have at least one differing cell (by side)
const diffColumnSet: Record<Side, Set<number>> = { left: new Set(), right: new Set() };

function computeDiffColumns(): void {
  diffColumnSet.left.clear();
  diffColumnSet.right.clear();
  if (!leftData || !rightData) return;
  for (const [li, ri] of columnMapping) {
    for (let i = 0; i < displayRowCount; i++) {
      if (getCellValue('left', i, li) !== getCellValue('right', i, ri)) {
        diffColumnSet.left.add(li);
        diffColumnSet.right.add(ri);
        break;
      }
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
    for (let i = 0; i < displayRowCount; i++) {
      const lv = parseFloat(getCellValue('left', i, li));
      const rv = parseFloat(getCellValue('right', i, ri));
      if (!isFinite(lv) || !isFinite(rv)) continue;
      const d = Math.abs(lv - rv);
      if (d > maxAbsDiff) { maxAbsDiff = d; maxRow = i; }
    }
    if (maxRow < 0) continue;
    const colName = leftData.headers[li];
    let atStr: string;
    if (useColAsX) {
      const xVal = parseFloat(getCellValue('left', maxRow, xAxisCol.left));
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
  (document.getElementById('btn-show-graph') as HTMLButtonElement).disabled = !hasLeft && !hasRight;

  document.getElementById('btn-scale')!.classList.toggle('active', scaleRowVisible);
  document.getElementById('btn-offset')!.classList.toggle('active', offsetRowVisible);

  const hasCustomState =
    xAxisCol.left !== defaultXAxisCol.left || xAxisCol.right !== defaultXAxisCol.right ||
    diffCols.left.size > 0 || diffCols.right.size > 0 ||
    movAvgCols.left.size > 0 || movAvgCols.right.size > 0 ||
    hexCols.left.size > 0 || hexCols.right.size > 0 ||
    scaleRowVisible || offsetRowVisible;
  document.getElementById('btn-reset-all')!.classList.toggle('hidden', !hasCustomState);

  updateHeaderPanelSelection();

  const graphContainer = document.getElementById('graph-container')!;
  if (!graphContainer.classList.contains('hidden') && leftData && rightData) {
    renderGraph(
      leftData.headers, getEffectiveRows('left'), Array.from(selectedCols.left), xAxisCol.left,
      { headers: rightData.headers, rows: getEffectiveRows('right'), selectedCols: Array.from(selectedCols.right), xAxisCol: xAxisCol.right, xAxisIsOriginal: isXAxisOriginal('right') },
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
  const n = data.rows.length;
  if (n < 2) return data.rows[rowIdx][colIdx];
  const i = rowIdx < n - 1 ? rowIdx : n - 2;
  const curr = parseFloat(data.rows[i + 1][colIdx]);
  const prev = parseFloat(data.rows[i][colIdx]);
  if (isNaN(curr) || isNaN(prev)) return data.rows[rowIdx][colIdx];
  return String(curr - prev);
}

function getMovAvgValue(side: Side, rowIdx: number, colIdx: number, windowSize: number): string {
  const data = side === 'left' ? leftData : rightData;
  if (!data) return '';
  const start = Math.max(0, rowIdx - windowSize + 1);
  let sum = 0, count = 0;
  for (let i = start; i <= rowIdx; i++) {
    const val = parseFloat(data.rows[i][colIdx]);
    if (!isNaN(val)) { sum += val; count++; }
  }
  return count > 0 ? String(sum / count) : data.rows[rowIdx][colIdx];
}

function getCellValue(side: Side, rowIdx: number, colIdx: number): string {
  const data = side === 'left' ? leftData : rightData;
  if (!data) return '';
  let val: string;
  if (diffCols[side].has(colIdx)) val = getDiffValue(side, rowIdx, colIdx);
  else {
    const ws = movAvgCols[side].get(colIdx);
    val = ws !== undefined ? getMovAvgValue(side, rowIdx, colIdx, ws) : (data.rows[rowIdx]?.[colIdx] ?? '');
  }
  return applyScaleOffset(side, colIdx, val);
}

function getEffectiveRows(side: Side): string[][] {
  const data = side === 'left' ? leftData : rightData;
  if (!data) return [];
  return data.rows.slice(0, displayRowCount).map((row, i) =>
    row.map((_, j) => getCellValue(side, i, j))
  );
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

  const tbody = document.getElementById(`${side}-data-body`)!;
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
    const row = data.rows[i];
    const tr = document.createElement('tr');
    tr.dataset.rowIndex = String(i);
    tr.addEventListener('click', () => navigateToRow(i));

    const tdNum = document.createElement('td');
    tdNum.textContent = String(i + 1);
    tdNum.className = 'row-num-cell align-right';
    tr.appendChild(tdNum);

    for (let j = 0; j < row.length; j++) {
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
      const otherCol = side === 'left' ? columnMapping.get(j) : reverseMapping.get(j);
      if (otherCol !== undefined) {
        const otherVal = getCellValue(otherSide(side), i, otherCol);
        if (displayVal !== otherVal) extraCls += ' value-diff';
      }
      td.textContent = displayVal;
      td.dataset.colIndex = String(j);
      td.dataset.side = side;
      td.className = (j === 0 ? 'align-left col-first' : 'align-left') + extraCls;
      applyFixedWidth(td, side, j);
      td.addEventListener('click', e => handleColumnClick(side, j, e as MouseEvent));
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

  applyHighlight(side);
  applyRowHighlight(side);
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
  for (let i = 0; i < data.headers.length; i++) {
    const cells = document.querySelectorAll<HTMLElement>(`#${side}-table [data-col-index="${i}"]`);
    const isXAxis = i === xAxisCol[side];
    const isSelected = selectedCols[side].has(i) && !isXAxis;
    cells.forEach(cell => {
      cell.classList.toggle('selected', isSelected);
      cell.classList.toggle('x-axis', isXAxis);
    });
  }
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

// ---- Scale / offset (synced between sides) ----

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

// Writes one side's value and mirrors it onto the matched column opposite, the
// same way diff / moving average / x-axis changes are mirrored.
function setSOValue(kind: SOKind, side: Side, col: number, v: number): void {
  const write = (sd: Side, c: number) => {
    soArr(kind, sd)[c] = v;
    const input = soInput(kind, sd, c);
    if (input) input.value = fmtSO(v);
    refreshSOCol(sd, c);
  };
  write(side, col);
  const mi = getMappedCol(side, col);
  if (mi !== undefined) write(otherSide(side), mi);
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

function buildSORow(kind: SOKind, side: Side, label: string, data: ParsedFile): void {
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

function clearAllScaleOffset(): void {
  setSORowVisible('scale', false);
  setSORowVisible('offset', false);
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
  const start = (crosshairRowIdx !== null ? crosshairRowIdx + 1 : 0);
  for (let pass = 0; pass < 2; pass++) {
    const from = pass === 0 ? start : 0;
    const to = pass === 0 ? displayRowCount : (crosshairRowIdx ?? 0);
    for (let i = from; i < to; i++) {
      if (getCellValue(side, i, colIdx) !== getCellValue(otherSide(side), i, otherCol)) {
        navigateToRow(i);
        return;
      }
    }
  }
}

function gotoPrevDiff(side: Side, colIdx: number): void {
  const otherCol = getMappedCol(side, colIdx);
  if (otherCol === undefined) return;
  const start = (crosshairRowIdx !== null ? crosshairRowIdx - 1 : displayRowCount - 1);
  for (let pass = 0; pass < 2; pass++) {
    const from = pass === 0 ? start : displayRowCount - 1;
    const to = pass === 0 ? -1 : (crosshairRowIdx ?? displayRowCount);
    for (let i = from; i > to; i--) {
      if (getCellValue(side, i, colIdx) !== getCellValue(otherSide(side), i, otherCol)) {
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
  for (let i = 0; i < displayRowCount; i++) {
    const lv = parseFloat(getCellValue(side, i, colIdx));
    const rv = parseFloat(getCellValue(otherSide(side), i, otherCol));
    if (!isFinite(lv) || !isFinite(rv)) continue;
    const d = Math.abs(lv - rv);
    if (d > maxDiff) { maxDiff = d; maxRow = i; }
  }
  if (maxRow < 0) return;
  navigateToRow(maxRow);
}

function gotoNaN(side: Side, colIdx: number, dir: 1 | -1): void {
  const n = displayRowCount;
  if (n === 0) return;
  // Wrap around so repeated invocations walk through every gap in the column.
  const start = crosshairRowIdx !== null
    ? crosshairRowIdx + dir
    : (dir === 1 ? 0 : n - 1);
  for (let k = 0; k < n; k++) {
    const i = ((start + dir * k) % n + n) % n;
    if (!isFinite(parseFloat(getCellValue(side, i, colIdx)))) {
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

function applyFixedWidth(el: HTMLElement, side: Side, colIdx: number): void {
  if (colIdx === 0) return; // first column uses the sticky col-first width
  const w = colWidths[side][colIdx];
  if (w === undefined) return;
  el.style.width = el.style.minWidth = el.style.maxWidth = `${w}px`;
}

function initPane(side: Side, data: ParsedFile): void {
  // The floor also has to fit the "Offset" label in the scale/offset rows.
  const rowNumPx = Math.max(String(displayRowCount).length * PX_PER_CHAR + PADDING, 54);
  const table = document.getElementById(`${side}-table`)!;
  table.style.setProperty('--row-num-width', `${rowNumPx}px`);

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
    th.textContent = String(colIdx + 1);
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
    num.textContent = String(i + 1);
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

  const hasStats = colIndex >= 0;
  // Turned on below if the column has NaNs.
  setItemVisible('ctx-goto-prev-nan', false);
  setItemVisible('ctx-goto-next-nan', false);
  setItemVisible('ctx-stats-sep', hasStats);
  setItemVisible('ctx-stats', hasStats);
  if (hasStats) {
    let maxV = -Infinity, minV = Infinity, sum = 0, count = 0, nanCount = 0;
    for (let i = 0; i < displayRowCount; i++) {
      const v = parseFloat(getCellValue(side, i, colIndex));
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
type SideAccum = { seq: number; meta: ParsedMeta; rows: string[][]; done: boolean };
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
  const loaded = (compareAccum.left?.rows.length ?? 0) + (compareAccum.right?.rows.length ?? 0);
  const total = (compareAccum.left?.meta.totalRows ?? 0) + (compareAccum.right?.meta.totalRows ?? 0);
  el.textContent = total > 0
    ? `로딩 중... ${loaded.toLocaleString()} / ${total.toLocaleString()} 행`
    : '로딩 중...';
}

window.addEventListener('message', (event: MessageEvent) => {
  const msg = event.data as ExtensionToWebviewMessage;

  if (msg.type === 'loadStart' && (msg.channel === 'left' || msg.channel === 'right')) {
    compareAccum[msg.channel] = { seq: msg.seq, meta: msg.meta, rows: [], done: false };
    showLoading();
  } else if (msg.type === 'loadChunk' && (msg.channel === 'left' || msg.channel === 'right')) {
    const a = compareAccum[msg.channel];
    if (a && a.seq === msg.seq) {
      for (let i = 0; i < msg.rows.length; i++) a.rows.push(msg.rows[i]);
      updateLoadingProgress();
    }
  } else if (msg.type === 'loadEnd' && (msg.channel === 'left' || msg.channel === 'right')) {
    const a = compareAccum[msg.channel];
    if (a && a.seq === msg.seq) {
      a.done = true;
      const l = compareAccum.left;
      const r = compareAccum.right;
      if (l && r && l.done && r.done && l.seq === r.seq) {
        const left: ParsedFile = { ...l.meta, rows: l.rows };
        const right: ParsedFile = { ...r.meta, rows: r.rows };
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
      `Comparing ${displayRowCount.toLocaleString()} rows (of ${leftData.rows.length.toLocaleString()} / ${rightData.rows.length.toLocaleString()})`;
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

function commitCompareData(left: ParsedFile, right: ParsedFile): void {
  {
    leftData = left;
    rightData = right;
    displayRowCount = Math.min(leftData.rows.length, rightData.rows.length);
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

// ---- Header panel (column list) ----

let headerPanelOpen = false;

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
      num.textContent = String(i + 1);
      const name = document.createElement('span');
      name.className = 'col-name';
      name.textContent = h;
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
    num.textContent = String(m.col + 1);
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
    if (!leftData || !rightData) return;
    resetZoom();
    resetCrosshairs();
    renderGraph(
      leftData.headers, getEffectiveRows('left'), Array.from(selectedCols.left), xAxisCol.left,
      { headers: rightData.headers, rows: getEffectiveRows('right'), selectedCols: Array.from(selectedCols.right), xAxisCol: xAxisCol.right, xAxisIsOriginal: isXAxisOriginal('right') },
      isXAxisOriginal('left')
    );
    syncViewport();
  });

  document.getElementById('btn-scale')!.addEventListener('click', () => { setSORowVisible('scale', !scaleRowVisible); updateToolbar(); });
  document.getElementById('btn-offset')!.addEventListener('click', () => { setSORowVisible('offset', !offsetRowVisible); updateToolbar(); });
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

  document.getElementById('btn-close-graph')!.addEventListener('click', () => {
    closeGraph();
    (document.getElementById('sel-graph-mode') as HTMLSelectElement).value = 'original';
    crosshairRowIdx = null;
    applyRowHighlight('left');
    applyRowHighlight('right');
  });

  document.getElementById('sel-line-width')!.addEventListener('change', e => {
    setLineWidth(parseFloat((e.target as HTMLSelectElement).value));
  });
  document.getElementById('sel-marker')!.addEventListener('change', e => {
    setMarkerStyle((e.target as HTMLSelectElement).value);
  });

  vscode.postMessage({ type: 'ready' });
});
