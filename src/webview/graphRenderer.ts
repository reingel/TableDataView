import Chart from 'chart.js/auto';

const MAX_CHART_POINTS = 2000;

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

function handleCanvasClick(e: MouseEvent): void {
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
  document.getElementById('chart-canvas')!.addEventListener('click', handleCanvasClick);
}

export function renderGraph(headers: string[], rows: string[][], selectedCols: number[], xAxisCol: number = 0): void {
  lastHeaders = headers;
  lastRows = rows;
  lastCols = selectedCols;
  lastXAxisCol = xAxisCol;
  crosshairIndex = null;

  const dec = decimateRows(rows);
  displayRows = dec.display;
  rowIndexMap = dec.map;

  document.getElementById('graph-container')!.classList.remove('hidden');
  redraw();
  initCanvasListener();
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
        x: { type: 'linear', title: { display: true, text: xLabel }, grid: { color: 'rgba(128,128,128,0.3)' } },
        y: { title: { display: true, text: 'Value' }, grid: { color: 'rgba(128,128,128,0.3)' } },
      },
    },
    plugins: [viewportPlugin, crosshairPlugin],
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
