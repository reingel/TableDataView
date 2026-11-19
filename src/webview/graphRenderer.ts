import Chart from 'chart.js/auto';
import { computeFFT } from './fft';

const DRAG_THRESHOLD = 5;
const PALETTE = ['#4bc0c0', '#ff6384', '#36a2eb', '#ff9f40', '#9966ff', '#ffcd56', '#c9cbcf'];
const MARKER_RADIUS: Record<string, number> = { none: 0, dot: 2, circle: 5 };

let chartInstance: any = null;
let fftChartInstance: any = null;
let lineWidth: number = 1;
let markerStyle: string = 'dot';
let crosshairDataX: number | null = null;
let crosshairOrigRowIdx: number | null = null;
let crosshair2DataX: number | null = null;
let crosshair2OrigRowIdx: number | null = null;
let lastHeaders: string[] = [];
let lastCols: number[] = [];
let rowHighlightCallback: ((rowIdx: number) => void) | null = null;
let canvasListenerAdded = false;
let lastXAxisCol: number = 0;
// When the x-axis column's values have been transformed (numerical diff, moving
// average, ...), using them as the x coordinate produces a distorted graph, so
// we fall back to the row index instead. This tracks whether the x-axis column
// still holds its original values.
let lastXAxisIsOriginal: boolean = true;
let lastRightData: RightGraphData | undefined;

// What the graph reads from a table: whole numeric columns (effective values,
// cached by the caller so repeated renders don't re-parse) and the display
// string of one cell for the value readout.
export type GraphSource = {
  rowCount: number;
  column: (col: number) => Float64Array;
  cell: (row: number, col: number) => string;
};
export type RightGraphData = {
  headers: string[]; src: GraphSource; selectedCols: number[]; xAxisCol: number; xAxisIsOriginal?: boolean;
};
const EMPTY_SRC: GraphSource = { rowCount: 0, column: () => new Float64Array(0), cell: () => '' };
let lastSrc: GraphSource = EMPTY_SRC;

// Use the x-axis column's values as the x coordinate only when that column is
// among the plotted columns AND it still holds its original (untransformed)
// values; otherwise plot against the row index.
function colUsedAsX(): boolean {
  return lastCols.includes(lastXAxisCol) && lastXAxisIsOriginal;
}
let viewportStartRow: number = 0;
let viewportEndRow: number = 0;
let zoomXMin: number | null = null;
let zoomXMax: number | null = null;

// Downsampled overview of the full (un-zoomed) data, drawn as a minimap in the
// top-right corner while zoomed. Recomputed only when the underlying data
// changes (keyed by reference), not on every pan/zoom redraw.
type MinimapSeries = { color: string; dash: number[]; pts: { x: number; y: number }[] };
type Minimap = { xRange: { min: number; max: number }; yRange: { min: number; max: number }; series: MinimapSeries[] };
// Pixel rect + data mapping of a drawn minimap, so clicks/drags on it can be
// hit-tested and translated back to an x position. Null when hidden.
type MinimapRect = { x0: number; y0: number; w: number; h: number; pad: number; xMin: number; xMax: number };
let currentMinimap: Minimap | null = null;
let minimapKey: unknown[] = [];
let minimapCache: Minimap | null = null;
let minimapRect: MinimapRect | null = null;
let isMinimapDrag = false;
// Same, for the FFT pane's independent chart/zoom.
let currentFftMinimap: Minimap | null = null;
let fftMinimapKey: unknown[] = [];
let fftMinimapCache: Minimap | null = null;
let fftMinimapRect: MinimapRect | null = null;
let isFftMinimapDrag = false;
let isMouseDown = false;
let isDragging = false;
let mouseDownClientX = 0;
let dragStartPixel = 0;
let dragCurrentPixel = 0;
let isPanDown = false;
let panLastPixel = 0;
let panStartClientX = 0;
let panIsDragging = false;
let crosshairClickTimer: ReturnType<typeof setTimeout> | null = null;
let pendingClickEvent: MouseEvent | null = null;

type DiffMode = 'original' | 'L-R' | 'R-L' | '|L-R|';
let diffMode: DiffMode = 'original';

let lastFftDatasets: any[] = [];
let fftCrosshairDataX: number | null = null;
let fftZoomXMin: number | null = null;
let fftZoomXMax: number | null = null;
let fftIsMouseDown = false;
let fftIsDragging = false;
let fftMouseDownClientX = 0;
let fftDragStartPixel = 0;
let fftDragCurrentPixel = 0;
let fftIsPanDown = false;
let fftPanLastPixel = 0;
let fftCanvasListenerAdded = false;
// Debounce FFT recompute so continuous pan/zoom of the time graph doesn't
// rebuild the (relatively expensive) FFT on every frame.
let fftRefreshTimer: ReturnType<typeof setTimeout> | null = null;

function scheduleFftRefresh(): void {
  if (!isFFTPaneVisible()) return;
  if (fftRefreshTimer !== null) clearTimeout(fftRefreshTimer);
  fftRefreshTimer = setTimeout(() => {
    fftRefreshTimer = null;
    renderFFTPaneFromGraph();
  }, 120);
}

export function setRowHighlightCallback(cb: (rowIdx: number) => void): void {
  rowHighlightCallback = cb;
}

// ---- Hover highlight ----
// The table tells the graph which column the pointer is over and the matching
// series is re-drawn, lit up, on a transparent canvas stacked over the chart.
// Everything here stays clear of Chart.js: asking it to restyle a dataset means
// an update() that re-processes every point, which stalls on large files.
let hoveredLeftCol: number | null = null;
let hoveredRightCol: number | null = null;
let hoverOverlay: HTMLCanvasElement | null = null;
let hoverDrawPending = false;
// Screen-space polylines, keyed by the chart geometry they were built from so
// they survive pointer movement but are rebuilt after a zoom / pan / resize.
const hoverPathCache = new Map<number, { key: string; pts: number[] }>();

const HOVER_EXTRA_WIDTH = 2;
const HOVER_GLOW_WIDTH = 9;

// Mix a #rrggbb color toward white so the hovered line reads as "lit up".
function lighten(hex: string, amount: number): string {
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  if (!m) return hex;
  const mix = (c: number) => Math.round(c + (255 - c) * amount);
  const [r, g, b] = [m[1], m[2], m[3]].map(h => mix(parseInt(h, 16)));
  return `rgb(${r},${g},${b})`;
}

function withAlpha(hex: string, alpha: number): string {
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  if (!m) return hex;
  const [r, g, b] = [m[1], m[2], m[3]].map(h => parseInt(h, 16));
  return `rgba(${r},${g},${b},${alpha})`;
}

export function setHoveredColumns(leftCol: number | null, rightCol: number | null): void {
  if (leftCol === hoveredLeftCol && rightCol === hoveredRightCol) return;
  hoveredLeftCol = leftCol;
  hoveredRightCol = rightCol;
  scheduleHoverDraw();
}

// Sweeping the pointer across the table crosses a column every few pixels;
// coalesce into one repaint per frame.
function scheduleHoverDraw(): void {
  if (hoverDrawPending) return;
  hoverDrawPending = true;
  requestAnimationFrame(() => {
    hoverDrawPending = false;
    drawHoverOverlay();
  });
}

function getHoverOverlay(): HTMLCanvasElement | null {
  const canvas = document.getElementById('chart-canvas') as HTMLCanvasElement | null;
  const parent = canvas?.parentElement;
  if (!canvas || !parent) return null;
  if (!hoverOverlay || hoverOverlay.parentElement !== parent) {
    hoverOverlay = document.createElement('canvas');
    hoverOverlay.style.cssText = 'position:absolute;pointer-events:none;';
    // Makes the parent the canvas' offsetParent, so the offsets below line the
    // overlay up with the chart in both layouts (the compare view puts the
    // canvas below a header inside the same container).
    if (!parent.style.position) parent.style.position = 'relative';
    parent.appendChild(hoverOverlay);
  }
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  if (hoverOverlay.width !== Math.round(w * dpr) || hoverOverlay.height !== Math.round(h * dpr)) {
    hoverOverlay.width = Math.round(w * dpr);
    hoverOverlay.height = Math.round(h * dpr);
    hoverOverlay.style.width = `${w}px`;
    hoverOverlay.style.height = `${h}px`;
  }
  hoverOverlay.style.left = `${canvas.offsetLeft}px`;
  hoverOverlay.style.top = `${canvas.offsetTop}px`;
  return hoverOverlay;
}

function hoveredDatasetIndexes(): number[] {
  if (!chartInstance) return [];
  const out: number[] = [];
  chartInstance.data.datasets.forEach((ds: any, i: number) => {
    // A difference series stands for both columns of a matched pair, so it
    // lights up from whichever side is hovered.
    if (ds._rightCol !== undefined && hoveredRightCol !== null && ds._rightCol === hoveredRightCol) {
      out.push(i);
      return;
    }
    const hovered = ds._side === 'right' ? hoveredRightCol : hoveredLeftCol;
    if (hovered !== null && ds._col === hovered) out.push(i);
  });
  return out;
}

// Reduce a dataset to at most two points per horizontal pixel (its min/max
// there). Visually identical at line width, but bounded by the canvas width
// instead of the row count, so a million-row column still repaints instantly.
function buildHoverPath(dsIndex: number): number[] {
  const els = chartInstance.getDatasetMeta(dsIndex).data as { x: number; y: number }[];
  const pts: number[] = [];
  let curX = NaN, minY = 0, maxY = 0;
  const flush = () => {
    if (isNaN(curX)) return;
    pts.push(curX, minY, curX, maxY);
  };
  for (const el of els) {
    // A gap point: break the path (NaN pair) like the chart's line does.
    if (!isFinite(el.x) || !isFinite(el.y)) {
      flush();
      curX = NaN;
      if (pts.length > 0 && !isNaN(pts[pts.length - 1])) pts.push(NaN, NaN);
      continue;
    }
    const px = Math.round(el.x);
    if (px !== curX) {
      flush();
      curX = px; minY = el.y; maxY = el.y;
    } else {
      if (el.y < minY) minY = el.y;
      if (el.y > maxY) maxY = el.y;
    }
  }
  flush();
  return pts;
}

function getHoverPath(dsIndex: number): number[] {
  const sx = chartInstance.scales.x;
  const sy = chartInstance.scales.y;
  const a = chartInstance.chartArea;
  const key = `${sx.min},${sx.max},${sy.min},${sy.max},${a.left},${a.right},${a.top},${a.bottom}`;
  const hit = hoverPathCache.get(dsIndex);
  if (hit && hit.key === key) return hit.pts;
  const pts = buildHoverPath(dsIndex);
  hoverPathCache.set(dsIndex, { key, pts });
  return pts;
}

function drawHoverOverlay(): void {
  const overlay = getHoverOverlay();
  if (!overlay) return;
  const ctx = overlay.getContext('2d')!;
  const dpr = window.devicePixelRatio || 1;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, overlay.width, overlay.height);

  if (!chartInstance) return;
  // Chart.js element coordinates are in the size it last measured; if the
  // canvas is currently laid out at a different size (mid-resize, or a
  // container that squashes it) the bitmap is scaled into that box, so scale
  // the overlay the same way instead of drawing the path where it isn't.
  const sx = chartInstance.width ? overlay.clientWidth / chartInstance.width : 1;
  const sy = chartInstance.height ? overlay.clientHeight / chartInstance.height : 1;
  if (sx !== 1 || sy !== 1) ctx.setTransform(dpr * sx, 0, 0, dpr * sy, 0, 0);
  const indexes = hoveredDatasetIndexes();
  if (indexes.length === 0) return;

  const a = chartInstance.chartArea;
  ctx.save();
  ctx.beginPath();
  ctx.rect(a.left, a.top, a.right - a.left, a.bottom - a.top);
  ctx.clip();
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';

  for (const i of indexes) {
    const pts = getHoverPath(i);
    if (pts.length < 2) continue;
    const color = chartInstance.data.datasets[i]._color as string;
    ctx.beginPath();
    let pen = false;
    for (let p = 0; p < pts.length; p += 2) {
      if (isNaN(pts[p])) { pen = false; continue; }
      if (pen) ctx.lineTo(pts[p], pts[p + 1]); else ctx.moveTo(pts[p], pts[p + 1]);
      pen = true;
    }
    // Wide translucent halo first, then the bright line on top of it.
    ctx.strokeStyle = withAlpha(color, 0.35);
    ctx.lineWidth = lineWidth + HOVER_GLOW_WIDTH;
    ctx.stroke();
    ctx.strokeStyle = lighten(color, 0.5);
    ctx.lineWidth = lineWidth + HOVER_EXTRA_WIDTH;
    ctx.stroke();
  }
  ctx.restore();
}

let extraYValuesCallback: (() => string) | null = null;
export function setGraphDiffMode(mode: DiffMode): void {
  diffMode = mode;
  seriesCache = null;
  redraw();
}

export function setExtraYValuesCallback(fn: (() => string) | null): void {
  extraYValuesCallback = fn;
}

export function setCrosshairToRow(rowIdx: number): void {
  if (!chartInstance || lastSrc.rowCount === 0) return;
  const xVal = rowX(rowIdx);
  if (!isFinite(xVal)) return;
  crosshairDataX = xVal;
  crosshairOrigRowIdx = rowIdx;
  chartInstance.update('none');
  updateYValues();
}

type DataPoint = { x: number; y: number; rowIdx: number };
// Line break marker in a dataset (rowIdx -1).
const GAP_POINT: DataPoint = { x: NaN, y: NaN, rowIdx: -1 };

// One plotted line before decimation: its full x/y columns (xs null = row
// number) plus the styling every dataset cut from it shares.
type Series = {
  xs: Float64Array | null; ys: Float64Array; n: number;
  label: string; color: string; dash?: number[];
  col: number; rightCol?: number; side: 'left' | 'right';
};

// Rebuilt only when the plotted data changes (renderGraph / diff mode), so
// pan and zoom reuse the same columns.
let seriesCache: Series[] | null = null;

function seriesX(s: Series, i: number): number {
  return s.xs ? s.xs[i] : i + 1;
}

// x coordinate of a (left-side) row on the graph.
function rowX(rowIdx: number): number {
  return colUsedAsX() ? lastSrc.column(lastXAxisCol)[rowIdx] : rowIdx + 1;
}

const monotonicCache = new WeakMap<Float64Array, boolean>();
// Non-decreasing over its finite values: the precondition for decimating by x
// bucket (an x-y plot that doubles back would be scrambled by it).
function isMonotonic(xs: Float64Array | null): boolean {
  if (!xs) return true;
  let m = monotonicCache.get(xs);
  if (m === undefined) {
    m = true;
    let prev = -Infinity;
    for (let i = 0; i < xs.length; i++) {
      const v = xs[i];
      if (!isFinite(v)) continue;
      if (v < prev) { m = false; break; }
      prev = v;
    }
    monotonicCache.set(xs, m);
  }
  return m;
}

function buildSeries(): Series[] {
  if (seriesCache) return seriesCache;
  const out: Series[] = [];
  const xs = colUsedAsX() ? lastSrc.column(lastXAxisCol) : null;
  const dataCols = getDataCols();
  const rd = lastRightData;

  if (diffMode !== 'original' && rd) {
    const rightDataCols = getRightDataCols();
    const n = Math.min(lastSrc.rowCount, rd.src.rowCount);
    const prefix = diffMode === '|L-R|' ? '|Δ|' : 'Δ';
    dataCols.forEach((leftCol, colorIdx) => {
      const rc = rightDataCols[colorIdx];
      if (rc === undefined) return;
      const lv = lastSrc.column(leftCol);
      const rv = rd.src.column(rc);
      const ys = new Float64Array(n);
      for (let i = 0; i < n; i++) {
        ys[i] = diffMode === 'R-L' ? rv[i] - lv[i] : diffMode === '|L-R|' ? Math.abs(lv[i] - rv[i]) : lv[i] - rv[i];
      }
      out.push({
        xs, ys, n, label: `${prefix}${lastHeaders[leftCol]}`, color: PALETTE[colorIdx % PALETTE.length],
        col: leftCol, rightCol: rc, side: 'left',
      });
    });
  } else {
    const labelPrefix = rd ? 'L: ' : '';
    dataCols.forEach((col, colorIdx) => {
      out.push({
        xs, ys: lastSrc.column(col), n: lastSrc.rowCount, label: labelPrefix + lastHeaders[col],
        color: PALETTE[colorIdx % PALETTE.length], col, side: 'left',
      });
    });
    if (rd) {
      const useRightColAsX = rd.selectedCols.includes(rd.xAxisCol) && (rd.xAxisIsOriginal ?? true);
      const rxs = useRightColAsX ? rd.src.column(rd.xAxisCol) : null;
      getRightDataCols().forEach((col, colorIdx) => {
        out.push({
          xs: rxs, ys: rd.src.column(col), n: rd.src.rowCount, label: 'R: ' + rd.headers[col],
          color: PALETTE[(colorIdx + Math.ceil(PALETTE.length / 2)) % PALETTE.length], dash: [5, 3],
          col, side: 'right',
        });
      });
    }
  }
  seriesCache = out;
  return out;
}

// Cut a series into the points handed to Chart.js for the x window
// [xMin, xMax]. Per bucket of width (xMax - xMin) / buckets only the
// first/min/max/last points are kept, which draws the same picture as every
// point at screen resolution but stays bounded by the canvas width rather than
// the row count. The nearest point outside the window on each side is kept so
// lines run to the edge.
//
// A NaN row breaks the line: one gap point (x/y NaN, which Chart.js skips and
// doesn't connect across) instead of a separate dataset per segment. Chart.js
// updates cost O(datasets^2), so a column with 5% blanks (~20k segments) froze
// the view for tens of seconds. A gap narrower than a bucket (pixel) is
// dropped, as it couldn't be seen anyway.
function decimate(s: Series, xMin: number, xMax: number, buckets: number): DataPoint[] {
  const out: DataPoint[] = [];
  const ys = s.ys;
  const pt = (i: number): DataPoint => ({ x: seriesX(s, i), y: ys[i], rowIdx: i });
  const gap = () => {
    if (out.length > 0 && out[out.length - 1].rowIdx >= 0) out.push(GAP_POINT);
  };

  if (!isMonotonic(s.xs)) {
    for (let i = 0; i < s.n; i++) {
      if (isFinite(seriesX(s, i)) && isFinite(ys[i])) out.push(pt(i));
      else gap();
    }
  } else {
    const bw = (xMax - xMin) / Math.max(1, buckets) || 1;
    let bucket = NaN, iFirst = -1, iMin = -1, iMax = -1, iLast = -1;
    const flush = () => {
      if (iFirst < 0) return;
      const idx = [iFirst, iMin, iMax, iLast].sort((a, b) => a - b);
      for (let k = 0; k < 4; k++) if (k === 0 || idx[k] !== idx[k - 1]) out.push(pt(idx[k]));
      iFirst = -1;
    };
    let before = -1;  // last finite point left of the window, not yet emitted
    let pendingGap = false;  // NaN rows since the last finite point
    for (let i = 0; i < s.n; i++) {
      const x = seriesX(s, i), y = ys[i];
      if (!isFinite(x) || !isFinite(y)) { pendingGap = true; before = -1; continue; }
      if (x < xMin) { before = i; pendingGap = false; continue; }
      if (before >= 0) { out.push(pt(before)); before = -1; }
      if (x > xMax) {
        flush();
        if (pendingGap) gap();
        out.push(pt(i));
        break;
      }
      const b = Math.floor((x - xMin) / bw);
      if (iFirst < 0 || b !== bucket) {
        flush();
        if (pendingGap) gap();
        bucket = b;
        iFirst = iMin = iMax = i;
      } else {
        if (y < ys[iMin]) iMin = i;
        if (y > ys[iMax]) iMax = i;
      }
      pendingGap = false;
      iLast = i;
    }
    flush();
  }
  if (out.length > 0 && out[out.length - 1].rowIdx < 0) out.pop();
  return out;
}

const xRangeCache = new WeakMap<Series, { min: number; max: number } | null>();

function seriesXRange(s: Series): { min: number; max: number } | null {
  if (xRangeCache.has(s)) return xRangeCache.get(s)!;
  let min = Infinity, max = -Infinity;
  for (let i = 0; i < s.n; i++) {
    const x = seriesX(s, i);
    if (!isFinite(x) || !isFinite(s.ys[i])) continue;
    if (x < min) min = x;
    if (x > max) max = x;
  }
  const r = min === Infinity ? null : { min, max };
  xRangeCache.set(s, r);
  return r;
}

// Full (un-zoomed) x extent of everything plotted.
function computeXRange(): { min: number; max: number } | null {
  let min = Infinity, max = -Infinity;
  for (const s of buildSeries()) {
    const r = seriesXRange(s);
    if (!r) continue;
    if (r.min < min) min = r.min;
    if (r.max > max) max = r.max;
  }
  return min === Infinity ? null : { min, max };
}

// One bucket per canvas pixel.
function decimationBuckets(): number {
  const canvas = document.getElementById('chart-canvas') as HTMLCanvasElement | null;
  return Math.max(200, Math.round(canvas?.clientWidth || 1000));
}

function buildDatasets(xMin: number, xMax: number, buckets: number): any[] {
  return buildSeries().map(s => ({
    label: s.label,
    data: decimate(s, xMin, xMax, buckets),
    tension: 0.1,
    fill: false,
    spanGaps: false,
    borderWidth: lineWidth,
    ...(s.dash ? { borderDash: s.dash } : {}),
    borderColor: s.color,
    backgroundColor: s.color,
    pointRadius: MARKER_RADIUS[markerStyle] ?? 0,
    showLine: true,
    _col: s.col, ...(s.rightCol !== undefined ? { _rightCol: s.rightCol } : {}), _side: s.side, _color: s.color,
  }));
}

const viewportPlugin = {
  id: 'viewportBox',
  afterDraw(chart: any) {
    const n = lastSrc.rowCount;
    if (n === 0 || !chart.scales.x) return;
    const xScale = chart.scales.x;
    const si = Math.max(0, viewportStartRow);
    const ei = Math.min(n - 1, viewportEndRow);
    const startX = xScale.getPixelForValue(rowX(si) || 0);
    const endX = xScale.getPixelForValue(rowX(ei) || 0);
    if (endX <= startX) return;
    const { top, bottom } = chart.chartArea;
    const ctx = chart.ctx;
    ctx.save();
    ctx.fillStyle = 'rgba(255,255,255,0.08)';
    ctx.fillRect(startX, top, endX - startX, bottom - top);
    ctx.strokeStyle = 'rgba(255,255,255,0.35)';
    ctx.lineWidth = 1;
    ctx.strokeRect(startX, top, endX - startX, bottom - top);
    ctx.restore();
  },
};

// Build a downsampled overview of every dataset spanning the full data range.
function downsampleMinimap(datasets: any[]): Minimap {
  let xmin = Infinity, xmax = -Infinity, ymin = Infinity, ymax = -Infinity;
  for (const ds of datasets) {
    for (const pt of ds.data as DataPoint[]) {
      if (pt.x < xmin) xmin = pt.x;
      if (pt.x > xmax) xmax = pt.x;
      if (pt.y < ymin) ymin = pt.y;
      if (pt.y > ymax) ymax = pt.y;
    }
  }

  const MM_SAMPLES = 240;
  const series: MinimapSeries[] = datasets.map(ds => {
    const data = ds.data as DataPoint[];
    let pts: { x: number; y: number }[];
    if (data.length <= MM_SAMPLES) {
      pts = data.map(p => ({ x: p.x, y: p.y }));
    } else {
      const stride = Math.ceil(data.length / MM_SAMPLES);
      pts = [];
      for (let i = 0; i < data.length; i += stride) pts.push({ x: data[i].x, y: data[i].y });
      const last = data[data.length - 1];
      if (pts[pts.length - 1]?.x !== last.x) pts.push({ x: last.x, y: last.y });
    }
    return { color: ds.borderColor, dash: (ds.borderDash as number[]) ?? [], pts };
  });

  return { xRange: { min: xmin, max: xmax }, yRange: { min: ymin, max: ymax }, series };
}

// Cached by series so panning/zooming (which keep the same data) reuse it.
function getMainMinimap(xRange: { min: number; max: number } | null): Minimap {
  const series = buildSeries();
  if (minimapCache && minimapKey[0] === series) return minimapCache;
  minimapKey = [series];
  minimapCache = downsampleMinimap(xRange ? buildDatasets(xRange.min, xRange.max, 120) : []);
  return minimapCache;
}

function getFftMinimap(datasets: any[]): Minimap {
  if (fftMinimapCache && fftMinimapKey[0] === lastFftDatasets) return fftMinimapCache;
  fftMinimapKey = [lastFftDatasets];
  fftMinimapCache = downsampleMinimap(datasets);
  return fftMinimapCache;
}

// Draw a full-range overview in the chart's top-right corner with the current
// zoom window highlighted, and return its pixel rect for hit-testing (or null).
function drawMinimapBox(chart: any, mm: Minimap, zMin: number, zMax: number): MinimapRect | null {
  if (mm.series.length === 0 || !isFinite(mm.xRange.min) || !isFinite(mm.yRange.min)) return null;
  const { chartArea, ctx } = chart;
  const margin = 8;
  const pad = 3;
  const w = Math.min(110, Math.max(60, (chartArea.right - chartArea.left) * 0.14));
  const h = 28;
  const x0 = chartArea.right - margin - w;
  const y0 = chartArea.top + margin;

  const spanX = (mm.xRange.max - mm.xRange.min) || 1;
  const spanY = (mm.yRange.max - mm.yRange.min) || 1;
  const mapX = (x: number) => x0 + pad + (x - mm.xRange.min) / spanX * (w - 2 * pad);
  const mapY = (y: number) => y0 + pad + (1 - (y - mm.yRange.min) / spanY) * (h - 2 * pad);

  ctx.save();
  ctx.fillStyle = 'rgba(20,20,20,0.78)';
  ctx.strokeStyle = 'rgba(255,255,255,0.3)';
  ctx.lineWidth = 1;
  ctx.fillRect(x0, y0, w, h);
  ctx.strokeRect(x0, y0, w, h);

  ctx.beginPath();
  ctx.rect(x0, y0, w, h);
  ctx.clip();

  for (const s of mm.series) {
    if (s.pts.length < 2) continue;
    ctx.beginPath();
    ctx.strokeStyle = s.color;
    ctx.lineWidth = 1;
    ctx.setLineDash(s.dash.length ? [2, 2] : []);
    let pen = false;
    for (let i = 0; i < s.pts.length; i++) {
      if (!isFinite(s.pts[i].x) || !isFinite(s.pts[i].y)) { pen = false; continue; }
      const px = mapX(s.pts[i].x);
      const py = mapY(s.pts[i].y);
      if (pen) ctx.lineTo(px, py); else ctx.moveTo(px, py);
      pen = true;
    }
    ctx.stroke();
  }
  ctx.setLineDash([]);

  const clamp = (x: number) => Math.max(mm.xRange.min, Math.min(mm.xRange.max, x));
  const wx1 = mapX(clamp(zMin));
  const wx2 = mapX(clamp(zMax));
  ctx.fillStyle = 'rgba(100,150,255,0.25)';
  ctx.fillRect(wx1, y0 + pad, Math.max(1, wx2 - wx1), h - 2 * pad);
  ctx.strokeStyle = 'rgba(120,170,255,0.95)';
  ctx.lineWidth = 1;
  ctx.strokeRect(wx1, y0 + pad, Math.max(1, wx2 - wx1), h - 2 * pad);
  ctx.restore();

  return { x0, y0, w, h, pad, xMin: mm.xRange.min, xMax: mm.xRange.max };
}

// Top-right minimap shown only while zoomed, so the user keeps spatial context.
const minimapPlugin = {
  id: 'minimap',
  afterDraw(chart: any) {
    minimapRect = (zoomXMin !== null && zoomXMax !== null && currentMinimap)
      ? drawMinimapBox(chart, currentMinimap, zoomXMin, zoomXMax)
      : null;
  },
};

const fftMinimapPlugin = {
  id: 'fftMinimap',
  afterDraw(chart: any) {
    fftMinimapRect = (fftZoomXMin !== null && fftZoomXMax !== null && currentFftMinimap)
      ? drawMinimapBox(chart, currentFftMinimap, fftZoomXMin, fftZoomXMax)
      : null;
  },
};

const crosshairPlugin = {
  id: 'crosshairLine',
  afterDraw(chart: any) {
    if (!chart.scales.x) return;
    const { top, bottom, left, right } = chart.chartArea;
    const ctx = chart.ctx;
    if (crosshairDataX !== null) {
      const pixelX = chart.scales.x.getPixelForValue(crosshairDataX);
      if (pixelX >= left && pixelX <= right) {
        ctx.save();
        ctx.beginPath();
        ctx.moveTo(pixelX, top);
        ctx.lineTo(pixelX, bottom);
        ctx.strokeStyle = 'rgba(255,255,255,0.9)';
        ctx.lineWidth = 1;
        ctx.stroke();
        ctx.restore();
      }
    }
    if (crosshair2DataX !== null) {
      const pixelX = chart.scales.x.getPixelForValue(crosshair2DataX);
      if (pixelX >= left && pixelX <= right) {
        ctx.save();
        ctx.beginPath();
        ctx.moveTo(pixelX, top);
        ctx.lineTo(pixelX, bottom);
        ctx.strokeStyle = 'rgba(255,200,50,0.9)';
        ctx.lineWidth = 1;
        ctx.stroke();
        ctx.restore();
      }
    }
  },
};

const dragSelectPlugin = {
  id: 'dragSelect',
  afterDraw(chart: any) {
    if (!isDragging) return;
    const { chartArea, ctx } = chart;
    const x1 = Math.max(chartArea.left, Math.min(dragStartPixel, dragCurrentPixel));
    const x2 = Math.min(chartArea.right, Math.max(dragStartPixel, dragCurrentPixel));
    if (x2 <= x1) return;
    ctx.save();
    ctx.fillStyle = 'rgba(100,150,255,0.2)';
    ctx.fillRect(x1, chartArea.top, x2 - x1, chartArea.bottom - chartArea.top);
    ctx.strokeStyle = 'rgba(100,150,255,0.8)';
    ctx.lineWidth = 1;
    ctx.strokeRect(x1, chartArea.top, x2 - x1, chartArea.bottom - chartArea.top);
    ctx.restore();
  },
};

const fftDragSelectPlugin = {
  id: 'fftDragSelect',
  afterDraw(chart: any) {
    if (!fftIsDragging) return;
    const { chartArea, ctx } = chart;
    const x1 = Math.max(chartArea.left, Math.min(fftDragStartPixel, fftDragCurrentPixel));
    const x2 = Math.min(chartArea.right, Math.max(fftDragStartPixel, fftDragCurrentPixel));
    if (x2 <= x1) return;
    ctx.save();
    ctx.fillStyle = 'rgba(100,150,255,0.2)';
    ctx.fillRect(x1, chartArea.top, x2 - x1, chartArea.bottom - chartArea.top);
    ctx.strokeStyle = 'rgba(100,150,255,0.8)';
    ctx.lineWidth = 1;
    ctx.strokeRect(x1, chartArea.top, x2 - x1, chartArea.bottom - chartArea.top);
    ctx.restore();
  },
};

function getDataCols(): number[] {
  if (!lastCols.includes(lastXAxisCol)) return lastCols;
  // An x-axis-only selection means nothing to plot (Esc cleared it, or in
  // compare mode only the other side has columns) — don't synthesize a plot of
  // the x-axis column against itself.
  return lastCols.filter(c => c !== lastXAxisCol);
}

function formatNum(val: number): string {
  if (!isFinite(val)) return 'N/A';
  if (val === 0) return '0';
  const abs = Math.abs(val);
  if (abs >= 1e6 || (abs > 0 && abs < 1e-3)) return val.toExponential(4);
  return parseFloat(val.toPrecision(6)).toString();
}

function getRightDataCols(): number[] {
  if (!lastRightData) return [];
  const rd = lastRightData;
  if (!rd.selectedCols.includes(rd.xAxisCol)) return rd.selectedCols;
  return rd.selectedCols.filter(c => c !== rd.xAxisCol);
}

function updateYValues(): void {
  const overlay = document.getElementById('graph-yvalues')!;
  const SEP = '&nbsp;&nbsp;&nbsp;&#124;&#124;&nbsp;&nbsp;&nbsp;';
  const extra = extraYValuesCallback ? extraYValuesCallback() : '';
  overlay.classList.remove('hidden');
  if (crosshairOrigRowIdx === null && crosshair2OrigRowIdx === null) {
    overlay.innerHTML = extra;
    updateHideCrosshairButton();
    return;
  }
  const useColAsX = colUsedAsX();
  const dataCols = getDataCols();
  const rd = lastRightData;
  const rightCols = getRightDataCols();
  const sections: string[] = [];
  const L = lastSrc;
  const hasR = (r: number) => !!rd && r < rd.src.rowCount;
  const numL = (r: number, c: number) => L.column(c)[r];
  const numR = (r: number, c: number | undefined) => c !== undefined && rd ? rd.src.column(c)[r] : NaN;
  const diffOf = (lf: number, rf: number) =>
    diffMode === 'R-L' ? rf - lf : diffMode === '|L-R|' ? Math.abs(lf - rf) : lf - rf;
  const diffPrefix = diffMode === '|L-R|' ? '|Δ|' : 'Δ';

  const rowSection = (row: number): string => {
    const xLabel = useColAsX
      ? `${lastHeaders[lastXAxisCol]}=${L.cell(row, lastXAxisCol)}`
      : `Row ${row + 1}`;
    const parts = dataCols.map((c, i) => {
      if (diffMode !== 'original' && hasR(row)) {
        const diff = diffOf(numL(row, c), numR(row, rightCols[i]));
        return `<b>${diffPrefix}${lastHeaders[c]}</b>:&nbsp;${isFinite(diff) ? formatNum(diff) : '–'}`;
      }
      const lv = L.cell(row, c);
      if (!hasR(row)) return `<b>${lastHeaders[c]}</b>:&nbsp;${lv}`;
      const rc = rightCols[i];
      const rv = rc !== undefined ? rd!.src.cell(row, rc) : '–';
      return `<b>${lastHeaders[c]}</b>:&nbsp;${lv}&nbsp;↔&nbsp;${rv}`;
    });
    return `<span>${xLabel}</span>&nbsp;&nbsp;${parts.join('&nbsp;&nbsp;|&nbsp;&nbsp;')}`;
  };

  if (crosshairOrigRowIdx !== null) sections.push(rowSection(crosshairOrigRowIdx));
  if (crosshair2OrigRowIdx !== null) sections.push(rowSection(crosshair2OrigRowIdx));

  if (crosshairOrigRowIdx !== null && crosshair2OrigRowIdx !== null) {
    const r1 = crosshairOrigRowIdx, r2 = crosshair2OrigRowIdx;
    const bothR = hasR(r1) && hasR(r2);
    let dxLabel: string;
    if (useColAsX) {
      const dx = numL(r2, lastXAxisCol) - numL(r1, lastXAxisCol);
      dxLabel = `Δ${lastHeaders[lastXAxisCol]}=${formatNum(dx)}`;
    } else {
      dxLabel = `ΔRow=${r2 - r1}`;
    }
    const dParts = dataCols.map((c, i) => {
      const diffL = numL(r2, c) - numL(r1, c);
      const rc = rightCols[i];
      if (diffMode !== 'original' && bothR) {
        const d1 = diffOf(numL(r1, c), numR(r1, rc));
        const d2 = diffOf(numL(r2, c), numR(r2, rc));
        return `<b>ΔΔ${diffPrefix}${lastHeaders[c]}</b>:&nbsp;${isFinite(d2 - d1) ? formatNum(d2 - d1) : '–'}`;
      }
      if (!bothR) return `<b>Δ${lastHeaders[c]}</b>:&nbsp;${formatNum(diffL)}`;
      const diffR = numR(r2, rc) - numR(r1, rc);
      return `<b>Δ${lastHeaders[c]}</b>:&nbsp;${formatNum(diffL)}&nbsp;↔&nbsp;${formatNum(diffR)}`;
    });
    sections.push(`<span>${dxLabel}</span>&nbsp;&nbsp;${dParts.join('&nbsp;&nbsp;|&nbsp;&nbsp;')}`);
  }

  if (extra) sections.push(extra);
  overlay.innerHTML = sections.join(SEP);
  overlay.classList.remove('hidden');
  updateHideCrosshairButton();
}


function getCanvasPixelX(e: MouseEvent): number {
  const canvas = document.getElementById('chart-canvas') as HTMLCanvasElement;
  return e.clientX - canvas.getBoundingClientRect().left;
}

function getCanvasPixelY(e: MouseEvent): number {
  const canvas = document.getElementById('chart-canvas') as HTMLCanvasElement;
  return e.clientY - canvas.getBoundingClientRect().top;
}

function isOverMinimap(px: number, py: number): boolean {
  const r = minimapRect;
  return !!r && px >= r.x0 && px <= r.x0 + r.w && py >= r.y0 && py <= r.y0 + r.h;
}

// Given a click x-pixel within a minimap rect, recenter a zoom window of the
// given span on that position, clamped to the minimap's data range.
function minimapPanRange(r: MinimapRect, span: number, px: number): { min: number; max: number } {
  const inner = r.w - 2 * r.pad;
  const t = Math.max(0, Math.min(1, (px - (r.x0 + r.pad)) / inner));
  const clickedX = r.xMin + t * (r.xMax - r.xMin);
  let min = clickedX - span / 2;
  let max = clickedX + span / 2;
  if (min < r.xMin) { max += r.xMin - min; min = r.xMin; }
  if (max > r.xMax) { min -= max - r.xMax; max = r.xMax; }
  return { min, max };
}

function panToMinimapX(px: number): void {
  if (!minimapRect || zoomXMin === null || zoomXMax === null) return;
  const { min, max } = minimapPanRange(minimapRect, zoomXMax - zoomXMin, px);
  zoomXMin = min;
  zoomXMax = max;
  redraw();
}

function handleMouseDown(e: MouseEvent): void {
  const isCtrlCmd = e.ctrlKey || e.metaKey;
  if (e.button === 0 && !isCtrlCmd && isOverMinimap(getCanvasPixelX(e), getCanvasPixelY(e))) {
    isMinimapDrag = true;
    panToMinimapX(getCanvasPixelX(e));
    e.preventDefault();
    return;
  }
  if (e.button === 2 || (e.button === 0 && isCtrlCmd)) {
    isPanDown = true;
    panLastPixel = getCanvasPixelX(e);
    panStartClientX = e.clientX;
    panIsDragging = false;
    e.preventDefault();
    return;
  }
  if (e.button !== 0) return;
  isMouseDown = true;
  isDragging = false;
  mouseDownClientX = e.clientX;
  dragStartPixel = getCanvasPixelX(e);
  dragCurrentPixel = dragStartPixel;
  e.preventDefault();
}

function handleMouseMove(e: MouseEvent): void {
  if (isMinimapDrag) {
    panToMinimapX(getCanvasPixelX(e));
    return;
  }
  if (!isMouseDown && !isPanDown) {
    const canvas = document.getElementById('chart-canvas') as HTMLCanvasElement;
    canvas.style.cursor = isOverMinimap(getCanvasPixelX(e), getCanvasPixelY(e)) ? 'pointer' : '';
  }
  if (isPanDown && chartInstance) {
    const currentPixel = getCanvasPixelX(e);
    if (!panIsDragging && Math.abs(e.clientX - panStartClientX) > DRAG_THRESHOLD) {
      panIsDragging = true;
    }
    if (panIsDragging) {
      const delta = currentPixel - panLastPixel;
      if (delta !== 0) {
        const scale = chartInstance.scales.x;
        const currentMin = zoomXMin ?? scale.min;
        const currentMax = zoomXMax ?? scale.max;
        const chartWidth = chartInstance.chartArea.right - chartInstance.chartArea.left;
        const dataDelta = -delta * (currentMax - currentMin) / chartWidth;
        zoomXMin = currentMin + dataDelta;
        zoomXMax = currentMax + dataDelta;
        redraw();
      }
    }
    panLastPixel = currentPixel;
    return;
  }
  if (!isMouseDown) return;
  if (Math.abs(e.clientX - mouseDownClientX) > DRAG_THRESHOLD) {
    isDragging = true;
    dragCurrentPixel = getCanvasPixelX(e);
    if (chartInstance) chartInstance.update('none');
  }
}

function handleMouseUp(e: MouseEvent): void {
  if (isMinimapDrag) {
    isMinimapDrag = false;
    return;
  }
  const isCtrlCmd = e.ctrlKey || e.metaKey;
  if (e.button === 2 || (e.button === 0 && isCtrlCmd)) {
    if (e.button === 2 && isPanDown && !panIsDragging) {
      handleCrosshair2Click(e);
    }
    isPanDown = false;
    panIsDragging = false;
    return;
  }
  if (e.button !== 0) return;
  isPanDown = false;
  panIsDragging = false;
  if (!isMouseDown) return;
  isMouseDown = false;
  if (isDragging) {
    isDragging = false;
    applyZoom();
  } else {
    if (crosshairClickTimer !== null) clearTimeout(crosshairClickTimer);
    pendingClickEvent = e;
    crosshairClickTimer = setTimeout(() => {
      crosshairClickTimer = null;
      if (pendingClickEvent) { handleCrosshairClick(pendingClickEvent); pendingClickEvent = null; }
    }, 150);
  }
}

function handleWheel(e: WheelEvent): void {
  if (!chartInstance) return;
  e.preventDefault();
  const scale = chartInstance.scales.x;
  const currentMin = zoomXMin ?? scale.min;
  const currentMax = zoomXMax ?? scale.max;
  const mouseDataX = scale.getValueForPixel(getCanvasPixelX(e));
  const factor = e.deltaY > 0 ? 1.15 : 1 / 1.15;
  zoomXMin = mouseDataX - (mouseDataX - currentMin) * factor;
  zoomXMax = mouseDataX + (currentMax - mouseDataX) * factor;
  redraw();
}


function applyZoom(): void {
  if (!chartInstance) return;
  const scale = chartInstance.scales.x;
  const x1 = scale.getValueForPixel(dragStartPixel);
  const x2 = scale.getValueForPixel(dragCurrentPixel);
  const newMin = Math.min(x1, x2);
  const newMax = Math.max(x1, x2);
  if (newMax - newMin < 1e-10) return;
  zoomXMin = newMin;
  zoomXMax = newMax;
  redraw();
}

// Nearest row (by x) among everything plotted. Searches the full columns, not
// the decimated points on the chart, so the crosshair lands on an exact row;
// rows with a NaN x or y aren't plotted and are skipped. (Chart.js' 'index'
// hit-testing can't be used: NaN gaps split a column into several datasets
// whose array indexes mean different rows.)
function findNearestPoint(e: MouseEvent): DataPoint | null {
  if (!chartInstance) return null;
  const px = getCanvasPixelX(e);
  const py = getCanvasPixelY(e);
  const area = chartInstance.chartArea;
  // Ignore clicks on the legend / axis margins, as Chart.js hit-testing did.
  if (px < area.left || px > area.right || py < area.top || py > area.bottom) return null;
  const dataX = chartInstance.scales.x.getValueForPixel(px);
  if (dataX === undefined || !isFinite(dataX)) return null;
  let best: DataPoint | null = null;
  let bestDist = Infinity;
  for (const s of buildSeries()) {
    for (let i = 0; i < s.n; i++) {
      const x = seriesX(s, i);
      const d = Math.abs(x - dataX);
      if (d < bestDist && isFinite(s.ys[i])) { bestDist = d; best = { x, y: s.ys[i], rowIdx: i }; }
    }
  }
  return best;
}

function handleCrosshairClick(e: MouseEvent): void {
  if (!chartInstance) return;
  const pt = findNearestPoint(e);
  if (!pt) return;
  crosshairDataX = pt.x;
  crosshairOrigRowIdx = pt.rowIdx;
  chartInstance.update('none');
  updateYValues();
  if (rowHighlightCallback) rowHighlightCallback(pt.rowIdx);
}

function handleCrosshair2Click(e: MouseEvent): void {
  if (!chartInstance) return;
  const pt = findNearestPoint(e);
  if (!pt) return;
  crosshair2DataX = pt.x;
  crosshair2OrigRowIdx = pt.rowIdx;
  chartInstance.update('none');
  updateYValues();
}

function initCanvasListener(): void {
  if (canvasListenerAdded) return;
  canvasListenerAdded = true;
  const canvas = document.getElementById('chart-canvas')!;
  canvas.addEventListener('mousedown', handleMouseDown);
  canvas.addEventListener('mousemove', handleMouseMove);
  canvas.addEventListener('mouseup', handleMouseUp);
  canvas.addEventListener('dblclick', () => { if (crosshairClickTimer !== null) { clearTimeout(crosshairClickTimer); crosshairClickTimer = null; pendingClickEvent = null; } goHome(); });
  canvas.addEventListener('wheel', handleWheel, { passive: false });
  canvas.addEventListener('contextmenu', e => e.preventDefault());
}

const fftCrosshairPlugin = {
  id: 'fftCrosshairLine',
  afterDraw(chart: any) {
    if (fftCrosshairDataX === null || !chart.scales.x) return;
    const pixelX = chart.scales.x.getPixelForValue(fftCrosshairDataX);
    const { top, bottom, left, right } = chart.chartArea;
    if (pixelX < left || pixelX > right) return;
    const ctx = chart.ctx;
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(pixelX, top);
    ctx.lineTo(pixelX, bottom);
    ctx.strokeStyle = 'rgba(255,255,255,0.9)';
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.restore();
  },
};

function updateHideCrosshairButton(): void {
  const hasCrosshair = crosshairOrigRowIdx !== null || crosshair2OrigRowIdx !== null || fftCrosshairDataX !== null;
  document.getElementById('btn-hide-crosshair')?.classList.toggle('hidden', !hasCrosshair);
}

function updateFftYValues(): void {
  const overlay = document.getElementById('fft-yvalues');
  if (!overlay) return;
  if (fftCrosshairDataX === null || lastFftDatasets.length === 0) {
    overlay.classList.add('hidden');
    updateHideCrosshairButton();
    return;
  }
  const parts = lastFftDatasets.map(ds => {
    const pts = ds.data as { x: number; y: number }[];
    if (pts.length === 0) return '';
    const nearest = pts.reduce((a, b) =>
      Math.abs(b.x - fftCrosshairDataX!) < Math.abs(a.x - fftCrosshairDataX!) ? b : a
    );
    return `<b>${ds.label}</b>: ${nearest.y.toFixed(1)} dB`;
  }).filter(s => s !== '');
  overlay.innerHTML = `<span>Freq: ${fftCrosshairDataX.toFixed(4)} Hz</span>&nbsp;&nbsp;${parts.join('&nbsp;&nbsp;|&nbsp;&nbsp;')}`;
  overlay.classList.remove('hidden');
  updateHideCrosshairButton();
}

function handleFftCrosshairClick(e: MouseEvent): void {
  if (!fftChartInstance) return;
  const elements = fftChartInstance.getElementsAtEventForMode(e, 'index', { intersect: false }, false);
  if (!elements.length) return;
  const el = elements[0];
  const pt = fftChartInstance.data.datasets[el.datasetIndex].data[el.index] as { x: number; y: number };
  if (!pt) return;
  fftCrosshairDataX = pt.x;
  fftChartInstance.update('none');
  updateFftYValues();
}

function getFftCanvasPixelX(e: MouseEvent): number {
  const canvas = document.getElementById('fft-canvas') as HTMLCanvasElement;
  return e.clientX - canvas.getBoundingClientRect().left;
}

function getFftCanvasPixelY(e: MouseEvent): number {
  const canvas = document.getElementById('fft-canvas') as HTMLCanvasElement;
  return e.clientY - canvas.getBoundingClientRect().top;
}

function isOverFftMinimap(px: number, py: number): boolean {
  const r = fftMinimapRect;
  return !!r && px >= r.x0 && px <= r.x0 + r.w && py >= r.y0 && py <= r.y0 + r.h;
}

function panFftToMinimapX(px: number): void {
  if (!fftMinimapRect || fftZoomXMin === null || fftZoomXMax === null) return;
  const { min, max } = minimapPanRange(fftMinimapRect, fftZoomXMax - fftZoomXMin, px);
  fftZoomXMin = min;
  fftZoomXMax = max;
  redrawFFT();
}

function handleFftMouseDown(e: MouseEvent): void {
  if (e.button === 0 && isOverFftMinimap(getFftCanvasPixelX(e), getFftCanvasPixelY(e))) {
    isFftMinimapDrag = true;
    panFftToMinimapX(getFftCanvasPixelX(e));
    e.preventDefault();
    return;
  }
  if (e.button === 2) {
    fftIsPanDown = true;
    fftPanLastPixel = getFftCanvasPixelX(e);
    e.preventDefault(); return;
  }
  if (e.button !== 0) return;
  fftIsMouseDown = true;
  fftIsDragging = false;
  fftMouseDownClientX = e.clientX;
  fftDragStartPixel = getFftCanvasPixelX(e);
  fftDragCurrentPixel = fftDragStartPixel;
  e.preventDefault();
}

function handleFftMouseMove(e: MouseEvent): void {
  if (isFftMinimapDrag) {
    panFftToMinimapX(getFftCanvasPixelX(e));
    return;
  }
  if (!fftIsMouseDown && !fftIsPanDown) {
    const canvas = document.getElementById('fft-canvas') as HTMLCanvasElement;
    if (canvas) canvas.style.cursor = isOverFftMinimap(getFftCanvasPixelX(e), getFftCanvasPixelY(e)) ? 'pointer' : '';
  }
  if (fftIsPanDown && fftChartInstance) {
    const currentPixel = getFftCanvasPixelX(e);
    const delta = currentPixel - fftPanLastPixel;
    if (delta !== 0) {
      const scale = fftChartInstance.scales.x;
      const currentMin = fftZoomXMin ?? scale.min;
      const currentMax = fftZoomXMax ?? scale.max;
      const chartWidth = fftChartInstance.chartArea.right - fftChartInstance.chartArea.left;
      const dataDelta = -delta * (currentMax - currentMin) / chartWidth;
      fftZoomXMin = currentMin + dataDelta;
      fftZoomXMax = currentMax + dataDelta;
      fftPanLastPixel = currentPixel;
      redrawFFT();
    }
    return;
  }
  if (!fftIsMouseDown) return;
  if (Math.abs(e.clientX - fftMouseDownClientX) > DRAG_THRESHOLD) {
    fftIsDragging = true;
    fftDragCurrentPixel = getFftCanvasPixelX(e);
    if (fftChartInstance) fftChartInstance.update('none');
  }
}

function handleFftMouseUp(e: MouseEvent): void {
  if (isFftMinimapDrag) { isFftMinimapDrag = false; return; }
  if (e.button === 2) { fftIsPanDown = false; return; }
  if (!fftIsMouseDown || e.button !== 0) return;
  fftIsMouseDown = false;
  if (fftIsDragging) {
    fftIsDragging = false;
    applyFftZoom();
  } else {
    handleFftCrosshairClick(e);
  }
}

function handleFftWheel(e: WheelEvent): void {
  if (!fftChartInstance) return;
  e.preventDefault();
  const scale = fftChartInstance.scales.x;
  const currentMin = fftZoomXMin ?? scale.min;
  const currentMax = fftZoomXMax ?? scale.max;
  const mouseDataX = scale.getValueForPixel(getFftCanvasPixelX(e));
  const factor = e.deltaY > 0 ? 1.15 : 1 / 1.15;
  fftZoomXMin = mouseDataX - (mouseDataX - currentMin) * factor;
  fftZoomXMax = mouseDataX + (currentMax - mouseDataX) * factor;
  redrawFFT();
}

function handleFftDblClick(): void {
  fftZoomXMin = null;
  fftZoomXMax = null;
  redrawFFT();
}

function applyFftZoom(): void {
  if (!fftChartInstance) return;
  const scale = fftChartInstance.scales.x;
  const x1 = scale.getValueForPixel(fftDragStartPixel);
  const x2 = scale.getValueForPixel(fftDragCurrentPixel);
  const newMin = Math.min(x1, x2);
  const newMax = Math.max(x1, x2);
  if (newMax - newMin < 1e-10) return;
  fftZoomXMin = newMin;
  fftZoomXMax = newMax;
  redrawFFT();
}

function initFftCanvasListener(): void {
  if (fftCanvasListenerAdded) return;
  fftCanvasListenerAdded = true;
  const canvas = document.getElementById('fft-canvas')!;
  canvas.addEventListener('mousedown', handleFftMouseDown);
  canvas.addEventListener('mousemove', handleFftMouseMove);
  canvas.addEventListener('mouseup', handleFftMouseUp);
  canvas.addEventListener('dblclick', handleFftDblClick);
  canvas.addEventListener('wheel', handleFftWheel, { passive: false });
  canvas.addEventListener('contextmenu', e => e.preventDefault());
}

function redrawFFT(): void {
  if (fftChartInstance) { fftChartInstance.destroy(); fftChartInstance = null; }
  const fftCanvas = document.getElementById('fft-canvas') as HTMLCanvasElement;
  if (!fftCanvas || lastFftDatasets.length === 0) return;
  const datasets = lastFftDatasets.map(ds => ({
    ...ds,
    borderWidth: lineWidth,
    pointRadius: MARKER_RADIUS[markerStyle] ?? 0,
  }));
  currentFftMinimap = fftZoomXMin === null ? null : getFftMinimap(datasets);
  fftChartInstance = new Chart(fftCanvas.getContext('2d')!, {
    type: 'scatter',
    data: { datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      plugins: {
        legend: { display: lastFftDatasets.length > 1, labels: { filter: (item: any) => item.text !== '' } },
        tooltip: { enabled: false },
      },
      scales: {
        x: {
          type: 'linear',
          title: { display: true, text: 'Frequency [Hz]' },
          grid: { color: 'rgba(128,128,128,0.3)' },
          ...(fftZoomXMin !== null ? { min: fftZoomXMin, max: fftZoomXMax! } : {}),
        },
        y: {
          title: { display: true, text: 'Amplitude [dB]' },
          grid: { color: 'rgba(128,128,128,0.3)' },
        },
      },
    },
    plugins: [fftDragSelectPlugin, fftCrosshairPlugin, fftMinimapPlugin],
  });
  updateFftYValues();
}

// ---- PNG export ----

export type GraphExportOptions = {
  width: number; height: number;   // logical (CSS) px
  pixelRatio: number;              // output px per CSS px
  legend: 'top' | 'right' | 'left' | 'bottom';
  minimap: boolean;
};

export function getGraphCanvasSize(): { width: number; height: number } | null {
  return chartInstance ? { width: chartInstance.width, height: chartInstance.height } : null;
}

// Renders the current graph (same series and visible x/y range) onto an
// offscreen canvas in a light, print-friendly style and returns a PNG data URL.
// Interactive overlays (crosshair, table viewport box, drag selection) are left out.
export function exportGraphPng(opts: GraphExportOptions): string | null {
  if (!chartInstance) return null;
  const xs = chartInstance.scales.x, ys = chartInstance.scales.y;
  const TEXT = '#222';
  const GRID = 'rgba(0,0,0,0.12)';

  const whiteBackgroundPlugin = {
    id: 'exportWhiteBackground',
    beforeDraw(chart: any) {
      const ctx = chart.ctx;
      ctx.save();
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, chart.width, chart.height);
      ctx.restore();
    },
  };
  // Same box as the on-screen minimap, but without touching its hit-test rect.
  const exportMinimapPlugin = {
    id: 'exportMinimap',
    afterDraw(chart: any) {
      if (zoomXMin !== null && zoomXMax !== null && currentMinimap) {
        drawMinimapBox(chart, currentMinimap, zoomXMin, zoomXMax);
      }
    },
  };

  const canvas = document.createElement('canvas');
  canvas.width = opts.width;
  canvas.height = opts.height;
  // Chart.js measures through the DOM, so the canvas has to be attached.
  canvas.style.cssText = `position:fixed;left:-100000px;top:0;width:${opts.width}px;height:${opts.height}px;`;
  document.body.appendChild(canvas);
  let chart: any = null;
  try {
    chart = new Chart(canvas.getContext('2d')!, {
      type: 'scatter',
      data: { datasets: buildDatasets(xs.min, xs.max, opts.width) },
      options: {
        responsive: false,
        animation: false,
        devicePixelRatio: opts.pixelRatio,
        color: TEXT,
        plugins: {
          legend: {
            display: getDataCols().length > 1 || lastRightData !== undefined,
            position: opts.legend,
            labels: { filter: (item: any) => item.text !== '', color: TEXT },
          },
          tooltip: { enabled: false },
        },
        scales: {
          x: {
            type: 'linear', min: xs.min, max: xs.max,
            title: { display: true, text: chartInstance.options.scales.x.title.text, color: TEXT },
            grid: { color: GRID },
            ticks: { includeBounds: false, color: TEXT },
          },
          y: {
            min: ys.min, max: ys.max,
            title: { display: true, text: chartInstance.options.scales.y.title.text, color: TEXT },
            grid: { color: GRID },
            ticks: { includeBounds: false, color: TEXT },
          },
        },
      },
      plugins: [whiteBackgroundPlugin, zeroLinePlugin, ...(opts.minimap ? [exportMinimapPlugin] : [])],
    });
    return canvas.toDataURL('image/png');
  } finally {
    chart?.destroy();
    canvas.remove();
  }
}

// The x range currently on screen (zoom / pan included), or null when no graph
// is drawn. isRowIndex: the graph plots against row number (1-based), not the
// x-axis column, so min/max are row numbers.
export function getVisibleXWindow(): { min: number; max: number; isRowIndex: boolean } | null {
  const xs = chartInstance?.scales?.x;
  if (!xs || !isFinite(xs.min) || !isFinite(xs.max)) return null;
  return { min: xs.min, max: xs.max, isRowIndex: !colUsedAsX() };
}

export function resetZoom(): void {
  zoomXMin = null;
  zoomXMax = null;
}

export function resetCrosshairs(): void {
  crosshairDataX = null;
  crosshairOrigRowIdx = null;
  crosshair2DataX = null;
  crosshair2OrigRowIdx = null;
}

export function hideCrosshairs(): void {
  crosshairDataX = null;
  crosshairOrigRowIdx = null;
  crosshair2DataX = null;
  crosshair2OrigRowIdx = null;
  if (chartInstance) chartInstance.update('none');
  fftCrosshairDataX = null;
  if (fftChartInstance) fftChartInstance.update('none');
  updateFftYValues();
  updateYValues();
}

export function renderGraph(
  headers: string[], src: GraphSource, selectedCols: number[], xAxisCol: number = 0,
  rightData?: RightGraphData,
  xAxisIsOriginal: boolean = true
): void {
  if (xAxisCol !== lastXAxisCol) {
    zoomXMin = null;
    zoomXMax = null;
  }

  lastHeaders = headers;
  lastSrc = src;
  lastCols = selectedCols;
  lastXAxisCol = xAxisCol;
  lastXAxisIsOriginal = xAxisIsOriginal;
  lastRightData = rightData;
  seriesCache = null;

  document.getElementById('graph-container')!.classList.remove('hidden');
  redraw();
  initCanvasListener();
}

function computeYRange(datasets: any[]): { min: number; max: number } | null {
  let min = Infinity, max = -Infinity;
  for (const ds of datasets) {
    for (const pt of ds.data as DataPoint[]) {
      if (zoomXMin === null || (pt.x >= zoomXMin! && pt.x <= zoomXMax!)) {
        if (pt.y < min) min = pt.y;
        if (pt.y > max) max = pt.y;
      }
    }
  }
  if (min === Infinity) return null;
  const pad = (max - min) * 0.05 || 1;
  return { min: min - pad, max: max + pad };
}

const zeroLinePlugin = {
  id: 'zeroLines',
  afterDraw(chart: any) {
    const { chartArea, ctx, scales } = chart;
    if (!scales.y) return;
    const { left, right, top, bottom } = chartArea;
    ctx.save();
    ctx.strokeStyle = 'rgba(180,180,180,0.55)';
    ctx.lineWidth = 1;
    if (scales.y.min <= 0 && scales.y.max >= 0) {
      const pixelY = scales.y.getPixelForValue(0);
      ctx.beginPath();
      ctx.moveTo(left, pixelY);
      ctx.lineTo(right, pixelY);
      ctx.stroke();
    }
    if (scales.x && scales.x.min <= 0 && scales.x.max >= 0) {
      const pixelX = scales.x.getPixelForValue(0);
      ctx.beginPath();
      ctx.moveTo(pixelX, top);
      ctx.lineTo(pixelX, bottom);
      ctx.stroke();
    }
    ctx.restore();
  },
};

function redraw(): void {
  const useColAsX = colUsedAsX();
  const xLabel = useColAsX ? lastHeaders[lastXAxisCol] : 'Row';
  const yLabel = diffMode === 'L-R' ? 'L − R' : diffMode === 'R-L' ? 'R − L' : diffMode === '|L-R|' ? '|L − R|' : 'Value';
  const dataCols = getDataCols();
  const xRange = computeXRange();
  const win = zoomXMin !== null ? { min: zoomXMin, max: zoomXMax! } : xRange;
  const datasets = win ? buildDatasets(win.min, win.max, decimationBuckets()) : [];
  const yRange = computeYRange(datasets);
  currentMinimap = zoomXMin === null ? null : getMainMinimap(xRange);
  const legendDisplay = dataCols.length > 1 || lastRightData !== undefined;

  // Dataset indexes and point pixels both belong to the previous render.
  hoverPathCache.clear();

  if (chartInstance) {
    // Pan / zoom / restyle: swap data and ranges into the existing chart
    // instead of tearing it down and rebuilding it.
    chartInstance.data.datasets = datasets;
    const o = chartInstance.options;
    o.plugins.legend.display = legendDisplay;
    o.scales.x.title.text = xLabel;
    o.scales.x.min = win?.min;
    o.scales.x.max = win?.max;
    o.scales.y.title.text = yLabel;
    o.scales.y.min = yRange?.min;
    o.scales.y.max = yRange?.max;
    chartInstance.update('none');
  } else {
    const canvas = document.getElementById('chart-canvas') as HTMLCanvasElement;
    chartInstance = new Chart(canvas.getContext('2d')!, {
      type: 'scatter',
      data: { datasets },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: false,
        // Chart.js re-lays out on its own when the panel is resized; the overlay
        // canvas has to be resized and redrawn with it.
        onResize: () => scheduleHoverDraw(),
        plugins: {
          legend: {
            display: legendDisplay,
            labels: { filter: (item: any) => item.text !== '' },
          },
          tooltip: { enabled: false },
        },
        scales: {
          x: {
            type: 'linear',
            title: { display: true, text: xLabel },
            grid: { color: 'rgba(128,128,128,0.3)' },
            ticks: { includeBounds: false },
            min: win?.min,
            max: win?.max,
          },
          y: {
            title: { display: true, text: yLabel },
            grid: { color: 'rgba(128,128,128,0.3)' },
            ticks: { includeBounds: false },
            min: yRange?.min,
            max: yRange?.max,
          },
        },
      },
      plugins: [viewportPlugin, zeroLinePlugin, crosshairPlugin, dragSelectPlugin, minimapPlugin],
    });
  }

  updateYValues();
  // The highlight lives on its own canvas, so it has to follow the new geometry.
  scheduleHoverDraw();
  // Keep the FFT pane in sync with the time graph's visible region.
  scheduleFftRefresh();
}

export function goHome(): void {
  zoomXMin = null;
  zoomXMax = null;
  redraw();
}

export function updateViewport(startRow: number, endRow: number): void {
  viewportStartRow = startRow;
  viewportEndRow = endRow;
  if (!chartInstance) return;

  if (zoomXMin !== null && zoomXMax !== null) {
    const n = lastSrc.rowCount;
    const si = Math.max(0, startRow);
    const ei = Math.min(n - 1, endRow);
    const boxMin = rowX(si) || 0;
    const boxMax = rowX(ei) || 0;
    const zoomSpan = zoomXMax - zoomXMin;
    let panned = false;
    if (boxMax - boxMin > zoomSpan) {
      const boxCenter = (boxMin + boxMax) / 2;
      zoomXMin = boxCenter - zoomSpan / 2;
      zoomXMax = boxCenter + zoomSpan / 2;
      panned = true;
    } else if (boxMin < zoomXMin) {
      zoomXMax = zoomXMax - (zoomXMin - boxMin);
      zoomXMin = boxMin;
      panned = true;
    } else if (boxMax > zoomXMax) {
      zoomXMin = zoomXMin + (boxMax - zoomXMax);
      zoomXMax = boxMax;
      panned = true;
    }
    if (panned) { redraw(); return; }
  }

  chartInstance.update('none');
}

export function setLineWidth(width: number): void {
  lineWidth = width;
  if (lastCols.length > 0) redraw();
  if (lastFftDatasets.length > 0) redrawFFT();
}

export function setMarkerStyle(style: string): void {
  markerStyle = style;
  if (lastCols.length > 0) redraw();
  if (lastFftDatasets.length > 0) redrawFFT();
}

export function closeFFTPane(): void {
  if (fftChartInstance) { fftChartInstance.destroy(); fftChartInstance = null; }
  fftZoomXMin = null;
  fftZoomXMax = null;
  fftCrosshairDataX = null;
  lastFftDatasets = [];
  const wrapper = document.getElementById('fft-canvas-wrapper');
  if (wrapper) { wrapper.classList.add('hidden'); wrapper.style.height = ''; }
  document.getElementById('fft-divider')?.classList.add('hidden');
  document.getElementById('fft-yvalues')?.classList.add('hidden');
}

// rowIdx: the rows to transform (null = all of them).
function renderFFTPane(
  headers: string[], src: GraphSource, rowIdx: number[] | null, fftColList: number[], xAxisCol: number
): void {
  if (fftColList.length === 0) { closeFFTPane(); return; }
  const count = rowIdx ? rowIdx.length : src.rowCount;
  const pick = (col: Float64Array): number[] => {
    const out = new Array<number>(count);
    for (let k = 0; k < count; k++) out[k] = col[rowIdx ? rowIdx[k] : k];
    return out;
  };

  // Determine sample rate from x-axis column values
  let sampleRate = 1;
  if (count >= 2 && xAxisCol >= 0) {
    const xVals = pick(src.column(xAxisCol)).filter(v => isFinite(v));
    if (xVals.length >= 2) {
      const dt = (xVals[xVals.length - 1] - xVals[0]) / (xVals.length - 1);
      if (dt > 0) sampleRate = 1 / dt;
    }
  }

  const datasets: any[] = [];
  const MAX_PTS = 2000;
  fftColList.forEach((colIdx, ci) => {
    const signal = pick(src.column(colIdx));
    const { freqs, amplitudesDb } = computeFFT(signal, sampleRate);
    if (freqs.length === 0) return;

    let pts = freqs.map((f, i) => ({ x: f, y: amplitudesDb[i] }));
    if (pts.length > MAX_PTS) {
      const step = Math.ceil(pts.length / MAX_PTS);
      pts = pts.filter((_, i) => i % step === 0);
    }

    const color = PALETTE[ci % PALETTE.length];
    datasets.push({
      label: headers[colIdx],
      data: pts,
      tension: 0,
      fill: false,
      borderWidth: lineWidth,
      borderColor: color,
      backgroundColor: color,
      pointRadius: MARKER_RADIUS[markerStyle] ?? 0,
      showLine: true,
    });
  });

  if (datasets.length === 0) { closeFFTPane(); return; }

  const fftWrapper = document.getElementById('fft-canvas-wrapper')!;
  const fftDivider = document.getElementById('fft-divider')!;
  const wasHidden = fftWrapper.classList.contains('hidden');
  fftWrapper.classList.remove('hidden');
  fftDivider.classList.remove('hidden');
  if (wasHidden) {
    fftWrapper.style.height = '50%';
    fftCrosshairDataX = null;
    document.getElementById('fft-yvalues')?.classList.add('hidden');
  }

  lastFftDatasets = datasets;
  redrawFFT();
  initFftCanvasListener();
}

export function renderFFTPaneFromGraph(): void {
  if (fftRefreshTimer !== null) { clearTimeout(fftRefreshTimer); fftRefreshTimer = null; }
  const dataCols = getDataCols();
  if (dataCols.length === 0) return;

  // FFT operates only on the data currently visible in the time graph, i.e. the
  // rows whose x-value falls inside the active zoom window. With no zoom the
  // whole signal is visible and used.
  let rows: number[] | null = null;
  if (zoomXMin !== null && zoomXMax !== null) {
    rows = [];
    for (let i = 0; i < lastSrc.rowCount; i++) {
      const x = rowX(i);
      if (isFinite(x) && x >= zoomXMin && x <= zoomXMax) rows.push(i);
    }
  }

  // When the x-axis column isn't used as x (not selected or transformed), the
  // signal is index-sampled, so derive the FFT sample rate from the index too
  // (xAxisCol = -1 -> no usable x values -> sample rate defaults to 1).
  renderFFTPane(lastHeaders, lastSrc, rows, dataCols, colUsedAsX() ? lastXAxisCol : -1);
}

export function isFFTPaneVisible(): boolean {
  const w = document.getElementById('fft-canvas-wrapper');
  return !!w && !w.classList.contains('hidden');
}

export function closeGraph(): void {
  diffMode = 'original';
  seriesCache = null;
  crosshairDataX = null;
  crosshairOrigRowIdx = null;
  crosshair2DataX = null;
  crosshair2OrigRowIdx = null;
  updateYValues();
  if (chartInstance) { chartInstance.destroy(); chartInstance = null; }
  hoveredLeftCol = null;
  hoveredRightCol = null;
  hoverPathCache.clear();
  hoverOverlay?.remove();
  hoverOverlay = null;
  closeFFTPane();
  document.getElementById('graph-container')!.classList.add('hidden');
}
