import Chart from 'chart.js/auto';
import { computeFFT } from './fft';

const DRAG_THRESHOLD = 5;
const PALETTE = ['#4bc0c0', '#ff6384', '#36a2eb', '#ff9f40', '#9966ff', '#ffcd56', '#c9cbcf'];
const MARKER_RADIUS: Record<string, number> = { none: 0, dot: 2, circle: 5 };

let chartInstance: any = null;
let fftChartInstance: any = null;
let lineWidth: number = 1;
let markerStyle: string = 'none';
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
let lastRightData: { headers: string[]; rows: string[][]; selectedCols: number[]; xAxisCol: number } | undefined;
let viewportStartRow: number = 0;
let viewportEndRow: number = 0;
let zoomXMin: number | null = null;
let zoomXMax: number | null = null;
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

let diffMode = false;

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

export function setRowHighlightCallback(cb: (rowIdx: number) => void): void {
  rowHighlightCallback = cb;
}

let extraYValuesCallback: (() => string) | null = null;
export function setGraphDiffMode(enabled: boolean): void {
  diffMode = enabled;
  redraw();
}

export function setExtraYValuesCallback(fn: (() => string) | null): void {
  extraYValuesCallback = fn;
}

export function setCrosshairToRow(rowIdx: number): void {
  if (!chartInstance || lastRows.length === 0) return;
  const useColAsX = lastCols.includes(lastXAxisCol);
  const dispIdx = rowIndexMap.indexOf(rowIdx);
  const idx = dispIdx >= 0 ? dispIdx : rowIdx;
  const xVal = useColAsX
    ? parseFloat(displayRows[idx]?.[lastXAxisCol])
    : (rowIndexMap[idx] ?? rowIdx);
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
    const xVal = useColAsX ? parseFloat(row[xAxisCol]) : indexMap[i];
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
  const useColAsX = lastCols.includes(lastXAxisCol);
  const dataCols = getDataCols();
  const result: any[] = [];

  if (diffMode && lastRightData) {
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
        const xVal = useColAsX ? parseFloat(displayRows[i][lastXAxisCol]) : rowIndexMap[i];
        const lv = parseFloat(displayRows[i][leftCol]);
        const rv = parseFloat(rd.rows[i][rc]);
        if (isFinite(xVal) && isFinite(lv) && isFinite(rv)) {
          cur.push({ x: xVal, y: lv - rv, rowIdx: rowIndexMap[i] });
        } else if (cur.length > 0) { segments.push(cur); cur = []; }
      }
      if (cur.length > 0) segments.push(cur);
      segments.forEach((seg, si) => {
        result.push({
          label: si === 0 ? `Δ${lastHeaders[leftCol]}` : '',
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
    const useRightColAsX = rd.selectedCols.includes(rd.xAxisCol);
    const rightDataCols = rd.selectedCols.includes(rd.xAxisCol)
      ? rd.selectedCols.filter(c => c !== rd.xAxisCol).length > 0
        ? rd.selectedCols.filter(c => c !== rd.xAxisCol)
        : [rd.xAxisCol]
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
    const useColAsX = lastCols.includes(lastXAxisCol);
    const totalRows = lastRows.length;
    const dispLen = displayRows.length;
    const toIdx = (r: number) => Math.round(r / Math.max(1, totalRows - 1) * Math.max(1, dispLen - 1));
    const si = Math.max(0, toIdx(viewportStartRow));
    const ei = Math.min(dispLen - 1, toIdx(viewportEndRow));
    const toXData = (i: number) => useColAsX
      ? (parseFloat(displayRows[i]?.[lastXAxisCol]) || 0)
      : (rowIndexMap[i]);
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
  return filtered.length > 0 ? filtered : [lastXAxisCol];
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
  const filtered = rd.selectedCols.filter(c => c !== rd.xAxisCol);
  return filtered.length > 0 ? filtered : [rd.xAxisCol];
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
  const useColAsX = lastCols.includes(lastXAxisCol);
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
      if (diffMode && rd && row1R) {
        const rc = rightCols[i];
        const diff = rc !== undefined ? parseFloat(lv) - parseFloat(row1R[rc]) : NaN;
        return `<b>Δ${lastHeaders[c]}</b>:&nbsp;${isFinite(diff) ? formatNum(diff) : '–'}`;
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
      if (diffMode && rd && row2R) {
        const rc = rightCols[i];
        const diff = rc !== undefined ? parseFloat(lv) - parseFloat(row2R[rc]) : NaN;
        return `<b>Δ${lastHeaders[c]}</b>:&nbsp;${isFinite(diff) ? formatNum(diff) : '–'}`;
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
      if (diffMode && rd && row1R && row2R) {
        const rc = rightCols[i];
        const d1 = rc !== undefined ? parseFloat(row1L[c]) - parseFloat(row1R[rc]) : NaN;
        const d2 = rc !== undefined ? parseFloat(row2L[c]) - parseFloat(row2R[rc]) : NaN;
        return `<b>ΔΔ${lastHeaders[c]}</b>:&nbsp;${isFinite(d2 - d1) ? formatNum(d2 - d1) : '–'}`;
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

function handleMouseDown(e: MouseEvent): void {
  const isCtrlCmd = e.ctrlKey || e.metaKey;
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

function handleCrosshairClick(e: MouseEvent): void {
  if (!chartInstance) return;
  const elements = chartInstance.getElementsAtEventForMode(e, 'index', { intersect: false }, false);
  if (!elements.length) return;
  const el = elements[0];
  const pt = chartInstance.data.datasets[el.datasetIndex].data[el.index] as DataPoint;
  if (!pt) return;
  crosshairDataX = pt.x;
  crosshairOrigRowIdx = pt.rowIdx;
  chartInstance.update('none');
  updateYValues();
  if (rowHighlightCallback) rowHighlightCallback(pt.rowIdx);
}

function handleCrosshair2Click(e: MouseEvent): void {
  if (!chartInstance) return;
  const elements = chartInstance.getElementsAtEventForMode(e, 'index', { intersect: false }, false);
  if (!elements.length) return;
  const el = elements[0];
  const pt = chartInstance.data.datasets[el.datasetIndex].data[el.index] as DataPoint;
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

function handleFftMouseDown(e: MouseEvent): void {
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
    plugins: [fftDragSelectPlugin, fftCrosshairPlugin],
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
  rightData?: { headers: string[]; rows: string[][]; selectedCols: number[]; xAxisCol: number }
): void {
  if (xAxisCol !== lastXAxisCol) {
    zoomXMin = null;
    zoomXMax = null;
  }

  lastHeaders = headers;
  lastRows = rows;
  lastCols = selectedCols;
  lastXAxisCol = xAxisCol;
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
  const useColAsX = lastCols.includes(lastXAxisCol);
  const xLabel = useColAsX ? lastHeaders[lastXAxisCol] : 'Row';
  const dataCols = getDataCols();
  const datasets = buildDatasets();
  const yRange = computeYRange(datasets);
  const xRange = zoomXMin === null ? computeXRange(datasets) : null;

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
          title: { display: true, text: diffMode ? 'L − R' : 'Value' },
          grid: { color: 'rgba(128,128,128,0.3)' },
          ticks: { includeBounds: false },
          ...(yRange ? { min: yRange.min, max: yRange.max } : {}),
        },
      },
    },
    plugins: [viewportPlugin, zeroLinePlugin, crosshairPlugin, dragSelectPlugin],
  });

  updateYValues();
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
    const useColAsX = lastCols.includes(lastXAxisCol);
    const toXData = (i: number) => useColAsX
      ? (parseFloat(displayRows[i]?.[lastXAxisCol]) || 0)
      : (rowIndexMap[i]);

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
  const dataCols = getDataCols();
  if (dataCols.length === 0) return;
  renderFFTPane(lastHeaders, lastRows, dataCols, lastXAxisCol);
}

export function isFFTPaneVisible(): boolean {
  const w = document.getElementById('fft-canvas-wrapper');
  return !!w && !w.classList.contains('hidden');
}

export function closeGraph(): void {
  diffMode = false;
  crosshairDataX = null;
  crosshairOrigRowIdx = null;
  crosshair2DataX = null;
  crosshair2OrigRowIdx = null;
  updateYValues();
  if (chartInstance) { chartInstance.destroy(); chartInstance = null; }
  closeFFTPane();
  document.getElementById('graph-container')!.classList.add('hidden');
}
