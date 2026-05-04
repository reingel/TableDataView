import Chart from 'chart.js/auto';

const MAX_CHART_POINTS = 2000;

let chartInstance: any = null;
let chartType: 'line' | 'bar' = 'line';
let lineWidth: number = 1;
let crosshairIndex: number | null = null;
let lastHeaders: string[] = [];
let lastRows: string[][] = [];
let lastCols: number[] = [];
let displayRows: string[][] = [];
let rowIndexMap: number[] = [];
let rowHighlightCallback: ((rowIdx: number) => void) | null = null;
let canvasListenerAdded = false;

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
  const useFirstColAsX = lastCols.includes(0) && lastCols.length > 1;
  return useFirstColAsX ? lastCols.filter(c => c !== 0) : lastCols;
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

export function renderGraph(headers: string[], rows: string[][], selectedCols: number[]): void {
  lastHeaders = headers;
  lastRows = rows;
  lastCols = selectedCols;
  crosshairIndex = null;

  const dec = decimateRows(rows);
  displayRows = dec.display;
  rowIndexMap = dec.map;

  document.getElementById('graph-container')!.classList.remove('hidden');
  redraw();
  initCanvasListener();
}

function redraw(): void {
  const useFirstColAsX = lastCols.includes(0) && lastCols.length > 1;
  const labels = useFirstColAsX
    ? displayRows.map(row => row[0])
    : displayRows.map((_, i) => String(rowIndexMap[i] + 1));
  const xLabel = useFirstColAsX ? lastHeaders[0] : 'Row';
  const dataCols = getDataCols();

  const datasets = dataCols.map(colIdx => ({
    label: lastHeaders[colIdx],
    data: displayRows.map(row => {
      const v = parseFloat(row[colIdx]);
      return isNaN(v) ? null : v;
    }),
    tension: 0.1,
    fill: false,
    borderWidth: lineWidth,
    pointRadius: 0,
  }));

  if (chartInstance) {
    chartInstance.destroy();
    chartInstance = null;
  }

  const canvas = document.getElementById('chart-canvas') as HTMLCanvasElement;
  chartInstance = new Chart(canvas.getContext('2d')!, {
    type: chartType,
    data: { labels, datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      plugins: {
        legend: { display: datasets.length > 1 },
        tooltip: { enabled: false },
      },
      scales: {
        x: { title: { display: true, text: xLabel } },
        y: { title: { display: true, text: 'Value' } },
      },
    },
    plugins: [crosshairPlugin],
  });

  document.getElementById('btn-toggle-chart-type')!.textContent =
    chartType === 'line' ? 'Switch to Bar' : 'Switch to Line';

  if (crosshairIndex !== null) updateYValues();
}

export function setLineWidth(width: number): void {
  lineWidth = width;
  if (lastCols.length > 0) redraw();
}

export function toggleChartType(): void {
  chartType = chartType === 'line' ? 'bar' : 'line';
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
