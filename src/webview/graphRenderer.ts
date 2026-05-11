import Chart from 'chart.js/auto';

const MAX_CHART_POINTS = 2000;
const DRAG_THRESHOLD = 5;

let chartInstance: any = null;
let lineWidth: number = 1;
let crosshairIndex: number | null = null;
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

export function setRowHighlightCallback(cb: (rowIdx: number) => void): void {
  rowHighlightCallback = cb;
}

function decimateRows(rows: string[][]): { display: string[][], map: number[] } {
  if (rows.length <= MAX_CHART_POINTS) {
    return { display: rows, map: rows.map((_, i) => i) };
  }
  const display: string[][] = [];
  const map: number[] = [];
  const step = (rows.length - 1) / (MAX_CHART_POINTS - 1);
  for (let i = 0; i < MAX_CHART_POINTS; i++) {
    const idx = Math.min(rows.length - 1, Math.round(i * step));
    display.push(rows[idx]);
    map.push(idx);
  }
  return { display, map };
}

const viewportPlugin = {
  id: 'viewportBox',
  afterDraw(chart: any) {
    if (displayRows.length === 0) return;
    const meta = chart.getDatasetMeta(0);
    if (!meta || !meta.data.length) return;
    const totalRows = lastRows.length;
    const dispLen = displayRows.length;
    const toDispIdx = (r: number) => Math.round(r / Math.max(1, totalRows - 1) * Math.max(1, dispLen - 1));
    const startIdx = Math.max(0, toDispIdx(viewportStartRow));
    const endIdx = Math.min(dispLen - 1, toDispIdx(viewportEndRow));
    const startX = meta.data[startIdx]?.x;
    const endX = meta.data[endIdx]?.x;
    if (startX === undefined || endX === undefined || endX <= startX) return;
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
    if (crosshairIndex === null) return;
    const meta = chart.getDatasetMeta(0);
    if (!meta || !meta.data[crosshairIndex]) return;
    const x = meta.data[crosshairIndex].x;
    const { top, bottom } = chart.chartArea;
    const ctx = chart.ctx;
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(x, top);
    ctx.lineTo(x, bottom);
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
  const useColAsX = lastCols.includes(lastXAxisCol) && lastCols.length > 1;
  return useColAsX ? lastCols.filter(c => c !== lastXAxisCol) : lastCols;
}

function updateYValues(): void {
  const overlay = document.getElementById('graph-yvalues')!;
  if (crosshairIndex === null) {
    overlay.classList.add('hidden');
    return;
  }
  const originalIdx = rowIndexMap[crosshairIndex] ?? crosshairIndex;
  const row = lastRows[originalIdx];
  const useFirstColAsX = lastCols.includes(0) && lastCols.length > 1;
  const xLabel = useFirstColAsX
    ? `${lastHeaders[0]}=${row[0]}`
    : `Row ${originalIdx + 1}`;
  const parts = getDataCols().map(c => `<b>${lastHeaders[c]}</b>: ${row[c]}`);
  overlay.innerHTML = `<span>${xLabel}</span>&nbsp;&nbsp;${parts.join('&nbsp;&nbsp;|&nbsp;&nbsp;')}`;
  overlay.classList.remove('hidden');
}

function getCanvasPixelX(e: MouseEvent): number {
  const canvas = document.getElementById('chart-canvas') as HTMLCanvasElement;
  return e.clientX - canvas.getBoundingClientRect().left;
}

function handleMouseDown(e: MouseEvent): void {
  if (e.button !== 0) return;
  isMouseDown = true;
  isDragging = false;
  mouseDownClientX = e.clientX;
  dragStartPixel = getCanvasPixelX(e);
  dragCurrentPixel = dragStartPixel;
  e.preventDefault();
}

function handleMouseMove(e: MouseEvent): void {
  if (!isMouseDown) return;
  if (Math.abs(e.clientX - mouseDownClientX) > DRAG_THRESHOLD) {
    isDragging = true;
    dragCurrentPixel = getCanvasPixelX(e);
    if (chartInstance) chartInstance.update('none');
  }
}

function handleMouseUp(e: MouseEvent): void {
  if (!isMouseDown || e.button !== 0) return;
  isMouseDown = false;
  if (isDragging) {
    isDragging = false;
    applyZoom();
  } else {
    handleCrosshairClick(e);
  }
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
  crosshairIndex = elements[0].index;
  chartInstance.update('none');
  updateYValues();
  if (rowHighlightCallback) {
    rowHighlightCallback(rowIndexMap[crosshairIndex] ?? crosshairIndex);
  }
}

function initCanvasListener(): void {
  if (canvasListenerAdded) return;
  canvasListenerAdded = true;
  const canvas = document.getElementById('chart-canvas')!;
  canvas.addEventListener('mousedown', handleMouseDown);
  canvas.addEventListener('mousemove', handleMouseMove);
  canvas.addEventListener('mouseup', handleMouseUp);
  canvas.addEventListener('dblclick', handleDblClick);
}

export function renderGraph(headers: string[], rows: string[][], selectedCols: number[], xAxisCol: number = 0): void {
  lastHeaders = headers;
  lastRows = rows;
  lastCols = selectedCols;
  lastXAxisCol = xAxisCol;
  crosshairIndex = null;
  zoomXMin = null;
  zoomXMax = null;

  const dec = decimateRows(rows);
  displayRows = dec.display;
  rowIndexMap = dec.map;

  document.getElementById('graph-container')!.classList.remove('hidden');
  redraw();
  initCanvasListener();
}

function computeYRange(datasets: any[]): { min: number; max: number } | null {
  if (zoomXMin === null || zoomXMax === null) return null;
  let min = Infinity, max = -Infinity;
  for (const ds of datasets) {
    for (const pt of ds.data) {
      if (pt === null) continue;
      if (pt.x >= zoomXMin! && pt.x <= zoomXMax!) {
        if (pt.y < min) min = pt.y;
        if (pt.y > max) max = pt.y;
      }
    }
  }
  if (min === Infinity) return null;
  const pad = (max - min) * 0.05 || 1;
  return { min: min - pad, max: max + pad };
}

function redraw(): void {
  const useColAsX = lastCols.includes(lastXAxisCol) && lastCols.length > 1;
  const xLabel = useColAsX ? lastHeaders[lastXAxisCol] : 'Row';
  const dataCols = getDataCols();

  const datasets = dataCols.map(colIdx => ({
    label: lastHeaders[colIdx],
    data: displayRows.map((row, i) => {
      const xVal = useColAsX ? parseFloat(row[lastXAxisCol]) : rowIndexMap[i] + 1;
      const yVal = parseFloat(row[colIdx]);
      if (isNaN(yVal) || isNaN(xVal)) return null;
      return { x: xVal, y: yVal };
    }),
    tension: 0.1,
    fill: false,
    borderWidth: lineWidth,
    pointRadius: 0,
    showLine: true,
  }));

  const yRange = computeYRange(datasets);

  if (chartInstance) {
    chartInstance.destroy();
    chartInstance = null;
  }

  const canvas = document.getElementById('chart-canvas') as HTMLCanvasElement;
  chartInstance = new Chart(canvas.getContext('2d')!, {
    type: 'scatter',
    data: { datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      plugins: {
        legend: { display: datasets.length > 1 },
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
          ...(yRange ? { min: yRange.min, max: yRange.max } : {}),
        },
      },
    },
    plugins: [viewportPlugin, crosshairPlugin, dragSelectPlugin],
  });

  if (crosshairIndex !== null) updateYValues();
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

export function closeGraph(): void {
  crosshairIndex = null;
  updateYValues();
  if (chartInstance) {
    chartInstance.destroy();
    chartInstance = null;
  }
  document.getElementById('graph-container')!.classList.add('hidden');
}
