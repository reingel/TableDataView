import Chart from 'chart.js/auto';

const DRAG_THRESHOLD = 5;
const PALETTE = ['#4bc0c0', '#ff6384', '#36a2eb', '#ff9f40', '#9966ff', '#ffcd56', '#c9cbcf'];
const MARKER_RADIUS: Record<string, number> = { none: 0, dot: 2, circle: 5 };

let chartInstance: any = null;
let lineWidth: number = 1;
let markerStyle: string = 'dot';
let crosshairDataX: number | null = null;
let crosshairOrigRowIdx: number | null = null;
let lastHeaders: string[] = [];
let lastRows: string[][] = [];
let lastCols: number[] = [];
let displayRows: string[][] = [];
let rowIndexMap: number[] = [];
let rowHighlightCallback: ((rowIdx: number) => void) | null = null;
let canvasListenerAdded = false;
let lastXAxisCol: number = 0;
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

export function setRowHighlightCallback(cb: (rowIdx: number) => void): void {
  rowHighlightCallback = cb;
}

type DataPoint = { x: number; y: number; rowIdx: number };

function buildDatasets(): any[] {
  const useColAsX = lastCols.includes(lastXAxisCol);
  const dataCols = getDataCols();
  const result: any[] = [];

  dataCols.forEach((colIdx, colorIdx) => {
    const color = PALETTE[colorIdx % PALETTE.length];
    const segments: DataPoint[][] = [];
    let cur: DataPoint[] = [];

    displayRows.forEach((row, i) => {
      const xVal = useColAsX ? parseFloat(row[lastXAxisCol]) : rowIndexMap[i];
      const yVal = parseFloat(row[colIdx]);
      if (isFinite(xVal) && isFinite(yVal)) {
        cur.push({ x: xVal, y: yVal, rowIdx: rowIndexMap[i] });
      } else if (cur.length > 0) {
        segments.push(cur);
        cur = [];
      }
    });
    if (cur.length > 0) segments.push(cur);
    if (segments.length === 0) return;

    segments.forEach((seg, si) => {
      result.push({
        label: si === 0 ? lastHeaders[colIdx] : '',
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
    if (crosshairDataX === null || !chart.scales.x) return;
    const pixelX = chart.scales.x.getPixelForValue(crosshairDataX);
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

function getDataCols(): number[] {
  if (!lastCols.includes(lastXAxisCol)) return lastCols;
  const filtered = lastCols.filter(c => c !== lastXAxisCol);
  return filtered.length > 0 ? filtered : [lastXAxisCol];
}

function updateYValues(): void {
  const overlay = document.getElementById('graph-yvalues')!;
  if (crosshairOrigRowIdx === null) { overlay.classList.add('hidden'); return; }
  const row = lastRows[crosshairOrigRowIdx];
  const useColAsX = lastCols.includes(lastXAxisCol);
  const xLabel = useColAsX
    ? `${lastHeaders[lastXAxisCol]}=${row[lastXAxisCol]}`
    : `Row ${crosshairOrigRowIdx + 1}`;
  const parts = getDataCols().map(c => `<b>${lastHeaders[c]}</b>: ${row[c]}`);
  overlay.innerHTML = `<span>${xLabel}</span>&nbsp;&nbsp;${parts.join('&nbsp;&nbsp;|&nbsp;&nbsp;')}`;
  overlay.classList.remove('hidden');
}

function getCanvasPixelX(e: MouseEvent): number {
  const canvas = document.getElementById('chart-canvas') as HTMLCanvasElement;
  return e.clientX - canvas.getBoundingClientRect().left;
}

function handleMouseDown(e: MouseEvent): void {
  if (e.button === 2) {
    isPanDown = true;
    panLastPixel = getCanvasPixelX(e);
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
    const delta = currentPixel - panLastPixel;
    if (delta !== 0) {
      const scale = chartInstance.scales.x;
      const currentMin = zoomXMin ?? scale.min;
      const currentMax = zoomXMax ?? scale.max;
      const chartWidth = chartInstance.chartArea.right - chartInstance.chartArea.left;
      const dataDelta = -delta * (currentMax - currentMin) / chartWidth;
      zoomXMin = currentMin + dataDelta;
      zoomXMax = currentMax + dataDelta;
      panLastPixel = currentPixel;
      redraw();
    }
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
  if (e.button === 2) { isPanDown = false; return; }
  if (!isMouseDown || e.button !== 0) return;
  isMouseDown = false;
  if (isDragging) {
    isDragging = false;
    applyZoom();
  } else {
    handleCrosshairClick(e);
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

function handleDblClick(): void {
  zoomXMin = null;
  zoomXMax = null;
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

function initCanvasListener(): void {
  if (canvasListenerAdded) return;
  canvasListenerAdded = true;
  const canvas = document.getElementById('chart-canvas')!;
  canvas.addEventListener('mousedown', handleMouseDown);
  canvas.addEventListener('mousemove', handleMouseMove);
  canvas.addEventListener('mouseup', handleMouseUp);
  canvas.addEventListener('dblclick', handleDblClick);
  canvas.addEventListener('wheel', handleWheel, { passive: false });
  canvas.addEventListener('contextmenu', e => e.preventDefault());
}

export function resetZoom(): void {
  zoomXMin = null;
  zoomXMax = null;
}

export function renderGraph(headers: string[], rows: string[][], selectedCols: number[], xAxisCol: number = 0): void {
  if (xAxisCol !== lastXAxisCol) {
    zoomXMin = null;
    zoomXMax = null;
  }

  lastHeaders = headers;
  lastRows = rows;
  lastCols = selectedCols;
  lastXAxisCol = xAxisCol;
  crosshairDataX = null;
  crosshairOrigRowIdx = null;

  displayRows = rows;
  rowIndexMap = rows.map((_, i) => i);

  document.getElementById('graph-container')!.classList.remove('hidden');
  redraw();
  initCanvasListener();
}

function computeYRange(datasets: any[]): { min: number; max: number } | null {
  if (zoomXMin === null || zoomXMax === null) return null;
  let min = Infinity, max = -Infinity;
  for (const ds of datasets) {
    for (const pt of ds.data as DataPoint[]) {
      if (pt.x >= zoomXMin! && pt.x <= zoomXMax!) {
        if (pt.y < min) min = pt.y;
        if (pt.y > max) max = pt.y;
      }
    }
  }
  if (min === Infinity) return null;
  const pad = (max - min) * 0.05 || 1;
  const yMin = (min >= 0 && min - pad < 0) ? 0 : min - pad;
  return { min: yMin, max: max + pad };
}

function redraw(): void {
  const useColAsX = lastCols.includes(lastXAxisCol);
  const xLabel = useColAsX ? lastHeaders[lastXAxisCol] : 'Row';
  const dataCols = getDataCols();
  const datasets = buildDatasets();
  const yRange = computeYRange(datasets);

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
          display: dataCols.length > 1,
          labels: { filter: (item: any) => item.text !== '' },
        },
        tooltip: { enabled: false },
      },
      scales: {
        x: {
          type: 'linear',
          title: { display: true, text: xLabel },
          grid: { color: 'rgba(128,128,128,0.3)' },
          ...(zoomXMin !== null ? { min: zoomXMin, max: zoomXMax! } : {}),
        },
        y: {
          title: { display: true, text: 'Value' },
          grid: { color: 'rgba(128,128,128,0.3)' },
          ...(yRange ? { min: yRange.min, max: yRange.max } : { suggestedMin: 0 }),
        },
      },
    },
    plugins: [viewportPlugin, crosshairPlugin, dragSelectPlugin],
  });

  updateYValues();
}

export function updateViewport(startRow: number, endRow: number): void {
  viewportStartRow = startRow;
  viewportEndRow = endRow;
  if (chartInstance) chartInstance.update('none');
}

export function setLineWidth(width: number): void {
  lineWidth = width;
  if (lastCols.length > 0) redraw();
}

export function setMarkerStyle(style: string): void {
  markerStyle = style;
  if (lastCols.length > 0) redraw();
}

export function closeGraph(): void {
  crosshairDataX = null;
  crosshairOrigRowIdx = null;
  updateYValues();
  if (chartInstance) { chartInstance.destroy(); chartInstance = null; }
  document.getElementById('graph-container')!.classList.add('hidden');
}
