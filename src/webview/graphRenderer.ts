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
let lastRows: string[][] = [];
let lastCols: number[] = [];
let displayRows: string[][] = [];
let rowIndexMap: number[] = [];
let rowHighlightCallback: ((rowIdx: number) => void) | null = null;
let canvasListenerAdded = false;
let lastXAxisCol: number = 0;
// When the x-axis column's values have been transformed (numerical diff, moving
// average, ...), using them as the x coordinate produces a distorted graph, so
// we fall back to the row index instead. This tracks whether the x-axis column
// still holds its original values.
let lastXAxisIsOriginal: boolean = true;
let lastRightData: { headers: string[]; rows: string[][]; selectedCols: number[]; xAxisCol: number; xAxisIsOriginal?: boolean } | undefined;

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

let extraYValuesCallback: (() => string) | null = null;
export function setGraphDiffMode(mode: DiffMode): void {
  diffMode = mode;
  redraw();
}

export function setExtraYValuesCallback(fn: (() => string) | null): void {
  extraYValuesCallback = fn;
}

export function setCrosshairToRow(rowIdx: number): void {
  if (!chartInstance || lastRows.length === 0) return;
  const useColAsX = colUsedAsX();
  const dispIdx = rowIndexMap.indexOf(rowIdx);
  const idx = dispIdx >= 0 ? dispIdx : rowIdx;
  const xVal = useColAsX
    ? parseFloat(displayRows[idx]?.[lastXAxisCol])
    : ((rowIndexMap[idx] ?? rowIdx) + 1);
  if (!isFinite(xVal)) return;
  crosshairDataX = xVal;
  crosshairOrigRowIdx = rowIdx;
  chartInstance.update('none');
  updateYValues();
}

type DataPoint = { x: number; y: number; rowIdx: number };

function buildSegments(rows: string[][], xAxisCol: number, colIdx: number, useColAsX: boolean, indexMap: number[]): DataPoint[][] {
  const segments: DataPoint[][] = [];
  let cur: DataPoint[] = [];
  rows.forEach((row, i) => {
    const xVal = useColAsX ? parseFloat(row[xAxisCol]) : indexMap[i] + 1;
    const yVal = parseFloat(row[colIdx]);
    if (isFinite(xVal) && isFinite(yVal)) {
      cur.push({ x: xVal, y: yVal, rowIdx: indexMap[i] });
    } else if (cur.length > 0) {
      segments.push(cur);
      cur = [];
    }
  });
  if (cur.length > 0) segments.push(cur);
  return segments;
}

function buildDatasets(): any[] {
  const useColAsX = colUsedAsX();
  const dataCols = getDataCols();
  const result: any[] = [];

  if (diffMode !== 'original' && lastRightData) {
    const rd = lastRightData;
    const rightDataCols = getRightDataCols();
    const nRows = Math.min(displayRows.length, rd.rows.length);

    dataCols.forEach((leftCol, colorIdx) => {
      const rc = rightDataCols[colorIdx];
      if (rc === undefined) return;
      const color = PALETTE[colorIdx % PALETTE.length];
      const segments: DataPoint[][] = [];
      let cur: DataPoint[] = [];
      for (let i = 0; i < nRows; i++) {
        const xVal = useColAsX ? parseFloat(displayRows[i][lastXAxisCol]) : rowIndexMap[i] + 1;
        const lv = parseFloat(displayRows[i][leftCol]);
        const rv = parseFloat(rd.rows[i][rc]);
        if (isFinite(xVal) && isFinite(lv) && isFinite(rv)) {
          const y = diffMode === 'R-L' ? rv - lv : diffMode === '|L-R|' ? Math.abs(lv - rv) : lv - rv;
          cur.push({ x: xVal, y, rowIdx: rowIndexMap[i] });
        } else if (cur.length > 0) { segments.push(cur); cur = []; }
      }
      if (cur.length > 0) segments.push(cur);
      const labelPrefix = diffMode === '|L-R|' ? '|Δ|' : 'Δ';
      segments.forEach((seg, si) => {
        result.push({
          label: si === 0 ? `${labelPrefix}${lastHeaders[leftCol]}` : '',
          data: seg, tension: 0.1, fill: false,
          borderWidth: lineWidth, borderColor: color, backgroundColor: color,
          pointRadius: MARKER_RADIUS[markerStyle] ?? 0, showLine: true,
        });
      });
    });
    return result;
  }

  const hasRight = lastRightData !== undefined;
  const labelPrefix = hasRight ? 'L: ' : '';

  dataCols.forEach((colIdx, colorIdx) => {
    const color = PALETTE[colorIdx % PALETTE.length];
    const segments = buildSegments(displayRows, lastXAxisCol, colIdx, useColAsX, rowIndexMap);
    if (segments.length === 0) return;

    segments.forEach((seg, si) => {
      result.push({
        label: si === 0 ? labelPrefix + lastHeaders[colIdx] : '',
        data: seg,
        tension: 0.1,
        fill: false,
        borderWidth: lineWidth,
        borderColor: color,
        backgroundColor: color,
        pointRadius: MARKER_RADIUS[markerStyle] ?? 0,
        showLine: true,
      });
    });
  });

  if (lastRightData) {
    const rd = lastRightData;
    const useRightColAsX = rd.selectedCols.includes(rd.xAxisCol) && (rd.xAxisIsOriginal ?? true);
    const rightDataCols = rd.selectedCols.includes(rd.xAxisCol)
      ? rd.selectedCols.filter(c => c !== rd.xAxisCol)
      : rd.selectedCols;
    const rightIndexMap = rd.rows.map((_, i) => i);

    rightDataCols.forEach((colIdx, colorIdx) => {
      const color = PALETTE[(colorIdx + Math.ceil(PALETTE.length / 2)) % PALETTE.length];
      const segments = buildSegments(rd.rows, rd.xAxisCol, colIdx, useRightColAsX, rightIndexMap);
      if (segments.length === 0) return;

      segments.forEach((seg, si) => {
        result.push({
          label: si === 0 ? 'R: ' + rd.headers[colIdx] : '',
          data: seg,
          tension: 0.1,
          fill: false,
          borderWidth: lineWidth,
          borderDash: [5, 3],
          borderColor: color,
          backgroundColor: color,
          pointRadius: MARKER_RADIUS[markerStyle] ?? 0,
          showLine: true,
        });
      });
    });
  }

  return result;
}

const viewportPlugin = {
  id: 'viewportBox',
  afterDraw(chart: any) {
    if (displayRows.length === 0 || !chart.scales.x) return;
    const xScale = chart.scales.x;
    const useColAsX = colUsedAsX();
    const totalRows = lastRows.length;
    const dispLen = displayRows.length;
    const toIdx = (r: number) => Math.round(r / Math.max(1, totalRows - 1) * Math.max(1, dispLen - 1));
    const si = Math.max(0, toIdx(viewportStartRow));
    const ei = Math.min(dispLen - 1, toIdx(viewportEndRow));
    const toXData = (i: number) => useColAsX
      ? (parseFloat(displayRows[i]?.[lastXAxisCol]) || 0)
      : (rowIndexMap[i] + 1);
    const startX = xScale.getPixelForValue(toXData(si));
    const endX = xScale.getPixelForValue(toXData(ei));
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

// Cached by reference so panning/zooming (which keep the same data) reuse it.
function getMainMinimap(datasets: any[]): Minimap {
  const key = [lastRows, lastCols, lastRightData, lastXAxisCol, diffMode];
  if (minimapCache && key.length === minimapKey.length && key.every((v, i) => v === minimapKey[i])) {
    return minimapCache;
  }
  minimapKey = key;
  minimapCache = downsampleMinimap(datasets);
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
    for (let i = 0; i < s.pts.length; i++) {
      const px = mapX(s.pts[i].x);
      const py = mapY(s.pts[i].y);
      if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
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
  const filtered = lastCols.filter(c => c !== lastXAxisCol);
  if (filtered.length > 0) return filtered;
  // In compare mode each side tracks selection independently, so an
  // x-axis-only left selection just means "nothing real selected on this
  // side" (e.g. a right-only column was picked) — don't synthesize a plot of
  // the x-axis column against itself. Single-file view has no other side to
  // fall back to, so keep plotting the lone selected column there.
  return lastRightData ? [] : [lastXAxisCol];
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

  if (crosshairOrigRowIdx !== null) {
    const row1L = lastRows[crosshairOrigRowIdx];
    const row1R = rd?.rows[crosshairOrigRowIdx];
    const xLabel1 = useColAsX
      ? `${lastHeaders[lastXAxisCol]}=${row1L[lastXAxisCol]}`
      : `Row ${crosshairOrigRowIdx + 1}`;
    const parts1 = dataCols.map((c, i) => {
      const lv = row1L[c];
      if (diffMode !== 'original' && rd && row1R) {
        const rc = rightCols[i];
        const lf = parseFloat(lv), rf = rc !== undefined ? parseFloat(row1R[rc]) : NaN;
        const diff = diffMode === 'R-L' ? rf - lf : diffMode === '|L-R|' ? Math.abs(lf - rf) : lf - rf;
        const prefix = diffMode === '|L-R|' ? '|Δ|' : 'Δ';
        return `<b>${prefix}${lastHeaders[c]}</b>:&nbsp;${isFinite(diff) ? formatNum(diff) : '–'}`;
      }
      if (!rd || !row1R) return `<b>${lastHeaders[c]}</b>:&nbsp;${lv}`;
      const rc = rightCols[i];
      const rv = rc !== undefined ? row1R[rc] : '–';
      return `<b>${lastHeaders[c]}</b>:&nbsp;${lv}&nbsp;↔&nbsp;${rv}`;
    });
    sections.push(`<span>${xLabel1}</span>&nbsp;&nbsp;${parts1.join('&nbsp;&nbsp;|&nbsp;&nbsp;')}`);
  }

  if (crosshair2OrigRowIdx !== null) {
    const row2L = lastRows[crosshair2OrigRowIdx];
    const row2R = rd?.rows[crosshair2OrigRowIdx];
    const xLabel2 = useColAsX
      ? `${lastHeaders[lastXAxisCol]}=${row2L[lastXAxisCol]}`
      : `Row ${crosshair2OrigRowIdx + 1}`;
    const parts2 = dataCols.map((c, i) => {
      const lv = row2L[c];
      if (diffMode !== 'original' && rd && row2R) {
        const rc = rightCols[i];
        const lf = parseFloat(lv), rf = rc !== undefined ? parseFloat(row2R[rc]) : NaN;
        const diff = diffMode === 'R-L' ? rf - lf : diffMode === '|L-R|' ? Math.abs(lf - rf) : lf - rf;
        const prefix = diffMode === '|L-R|' ? '|Δ|' : 'Δ';
        return `<b>${prefix}${lastHeaders[c]}</b>:&nbsp;${isFinite(diff) ? formatNum(diff) : '–'}`;
      }
      if (!rd || !row2R) return `<b>${lastHeaders[c]}</b>:&nbsp;${lv}`;
      const rc = rightCols[i];
      const rv = rc !== undefined ? row2R[rc] : '–';
      return `<b>${lastHeaders[c]}</b>:&nbsp;${lv}&nbsp;↔&nbsp;${rv}`;
    });
    sections.push(`<span>${xLabel2}</span>&nbsp;&nbsp;${parts2.join('&nbsp;&nbsp;|&nbsp;&nbsp;')}`);
  }

  if (crosshairOrigRowIdx !== null && crosshair2OrigRowIdx !== null) {
    const row1L = lastRows[crosshairOrigRowIdx];
    const row2L = lastRows[crosshair2OrigRowIdx];
    const row1R = rd?.rows[crosshairOrigRowIdx];
    const row2R = rd?.rows[crosshair2OrigRowIdx];
    let dxLabel: string;
    if (useColAsX) {
      const dx = parseFloat(row2L[lastXAxisCol]) - parseFloat(row1L[lastXAxisCol]);
      dxLabel = `Δ${lastHeaders[lastXAxisCol]}=${formatNum(dx)}`;
    } else {
      dxLabel = `ΔRow=${crosshair2OrigRowIdx - crosshairOrigRowIdx}`;
    }
    const dParts = dataCols.map((c, i) => {
      const diffL = parseFloat(row2L[c]) - parseFloat(row1L[c]);
      if (diffMode !== 'original' && rd && row1R && row2R) {
        const rc = rightCols[i];
        const lf1 = parseFloat(row1L[c]), rf1 = rc !== undefined ? parseFloat(row1R[rc]) : NaN;
        const lf2 = parseFloat(row2L[c]), rf2 = rc !== undefined ? parseFloat(row2R[rc]) : NaN;
        const d1 = diffMode === 'R-L' ? rf1 - lf1 : diffMode === '|L-R|' ? Math.abs(lf1 - rf1) : lf1 - rf1;
        const d2 = diffMode === 'R-L' ? rf2 - lf2 : diffMode === '|L-R|' ? Math.abs(lf2 - rf2) : lf2 - rf2;
        const prefix = diffMode === '|L-R|' ? '|Δ|' : 'Δ';
        return `<b>ΔΔ${prefix}${lastHeaders[c]}</b>:&nbsp;${isFinite(d2 - d1) ? formatNum(d2 - d1) : '–'}`;
      }
      if (!rd || !row1R || !row2R) return `<b>Δ${lastHeaders[c]}</b>:&nbsp;${formatNum(diffL)}`;
      const rc = rightCols[i];
      const diffR = rc !== undefined ? parseFloat(row2R[rc]) - parseFloat(row1R[rc]) : NaN;
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

// Chart.js' 'index' interaction mode assumes every dataset shares one point
// index space: it locates the nearest point, then hands back data[thatIndex] of
// each dataset. NaN breaks the assumption — buildSegments splits a column with
// NaN gaps into several segment datasets, so the same array index means a
// different row in each of them, and when the first dataset is shorter than the
// index there is no element at all and the click silently did nothing. Pick the
// nearest plotted point ourselves; every point carries its own row index.
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
  for (const ds of chartInstance.data.datasets) {
    for (const pt of ds.data as DataPoint[]) {
      const d = Math.abs(pt.x - dataX);
      if (d < bestDist) { bestDist = d; best = pt; }
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
  headers: string[], rows: string[][], selectedCols: number[], xAxisCol: number = 0,
  rightData?: { headers: string[]; rows: string[][]; selectedCols: number[]; xAxisCol: number; xAxisIsOriginal?: boolean },
  xAxisIsOriginal: boolean = true
): void {
  if (xAxisCol !== lastXAxisCol) {
    zoomXMin = null;
    zoomXMax = null;
  }

  lastHeaders = headers;
  lastRows = rows;
  lastCols = selectedCols;
  lastXAxisCol = xAxisCol;
  lastXAxisIsOriginal = xAxisIsOriginal;
  lastRightData = rightData;

  displayRows = rows;
  rowIndexMap = rows.map((_, i) => i);

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

function computeXRange(datasets: any[]): { min: number; max: number } | null {
  let min = Infinity, max = -Infinity;
  for (const ds of datasets) {
    for (const pt of ds.data as { x: number; y: number }[]) {
      if (pt.x < min) min = pt.x;
      if (pt.x > max) max = pt.x;
    }
  }
  if (min === Infinity) return null;
  return { min, max };
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
  const dataCols = getDataCols();
  const datasets = buildDatasets();
  const yRange = computeYRange(datasets);
  const xRange = zoomXMin === null ? computeXRange(datasets) : null;
  currentMinimap = zoomXMin === null ? null : getMainMinimap(datasets);

  if (chartInstance) { chartInstance.destroy(); chartInstance = null; }

  const canvas = document.getElementById('chart-canvas') as HTMLCanvasElement;
  chartInstance = new Chart(canvas.getContext('2d')!, {
    type: 'scatter',
    data: { datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      plugins: {
        legend: {
          display: dataCols.length > 1 || lastRightData !== undefined,
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
          ...(zoomXMin !== null ? { min: zoomXMin, max: zoomXMax! } : xRange ? { min: xRange.min, max: xRange.max } : {}),
        },
        y: {
          title: { display: true, text: diffMode === 'L-R' ? 'L − R' : diffMode === 'R-L' ? 'R − L' : diffMode === '|L-R|' ? '|L − R|' : 'Value' },
          grid: { color: 'rgba(128,128,128,0.3)' },
          ticks: { includeBounds: false },
          ...(yRange ? { min: yRange.min, max: yRange.max } : {}),
        },
      },
    },
    plugins: [viewportPlugin, zeroLinePlugin, crosshairPlugin, dragSelectPlugin, minimapPlugin],
  });

  updateYValues();
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
    const scale = chartInstance.scales.x;
    const totalRows = lastRows.length;
    const dispLen = displayRows.length;
    const toIdx = (r: number) => Math.round(r / Math.max(1, totalRows - 1) * Math.max(1, dispLen - 1));
    const useColAsX = colUsedAsX();
    const toXData = (i: number) => useColAsX
      ? (parseFloat(displayRows[i]?.[lastXAxisCol]) || 0)
      : (rowIndexMap[i] + 1);

    const si = Math.max(0, toIdx(startRow));
    const ei = Math.min(dispLen - 1, toIdx(endRow));
    const boxMin = toXData(si);
    const boxMax = toXData(ei);
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

export function renderFFTPane(
  headers: string[], rows: string[][], fftColList: number[], xAxisCol: number
): void {
  if (fftColList.length === 0) { closeFFTPane(); return; }

  // Determine sample rate from x-axis column values
  let sampleRate = 1;
  if (rows.length >= 2) {
    const xVals = rows.map(r => parseFloat(r[xAxisCol])).filter(v => isFinite(v));
    if (xVals.length >= 2) {
      const dt = (xVals[xVals.length - 1] - xVals[0]) / (xVals.length - 1);
      if (dt > 0) sampleRate = 1 / dt;
    }
  }

  const datasets: any[] = [];
  const MAX_PTS = 2000;
  fftColList.forEach((colIdx, ci) => {
    const signal = rows.map(r => parseFloat(r[colIdx]));
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
  let rows = displayRows;
  if (zoomXMin !== null && zoomXMax !== null) {
    const useColAsX = colUsedAsX();
    rows = displayRows.filter((row, i) => {
      const x = useColAsX ? parseFloat(row[lastXAxisCol]) : rowIndexMap[i] + 1;
      return isFinite(x) && x >= zoomXMin! && x <= zoomXMax!;
    });
  }

  // When the x-axis column isn't used as x (not selected or transformed), the
  // signal is index-sampled, so derive the FFT sample rate from the index too
  // (xAxisCol = -1 -> no usable x values -> sample rate defaults to 1).
  renderFFTPane(lastHeaders, rows, dataCols, colUsedAsX() ? lastXAxisCol : -1);
}

export function isFFTPaneVisible(): boolean {
  const w = document.getElementById('fft-canvas-wrapper');
  return !!w && !w.classList.contains('hidden');
}

export function closeGraph(): void {
  diffMode = 'original';
  crosshairDataX = null;
  crosshairOrigRowIdx = null;
  crosshair2DataX = null;
  crosshair2OrigRowIdx = null;
  updateYValues();
  if (chartInstance) { chartInstance.destroy(); chartInstance = null; }
  closeFFTPane();
  document.getElementById('graph-container')!.classList.add('hidden');
}
