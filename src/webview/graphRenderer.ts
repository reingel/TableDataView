declare const Chart: any;

let chartInstance: any = null;
let chartType: 'line' | 'bar' = 'line';
let lastHeaders: string[] = [];
let lastRows: string[][] = [];
let lastCols: number[] = [];

export function renderGraph(headers: string[], rows: string[][], selectedCols: number[]): void {
  lastHeaders = headers;
  lastRows = rows;
  lastCols = selectedCols;

  const container = document.getElementById('graph-container')!;
  container.classList.remove('hidden');

  redraw();
}

function redraw(): void {
  console.log('[GraphRenderer] lastCols:', lastCols);
  const firstColSelected = lastCols.includes(0);
  const useFirstColAsX = firstColSelected && lastCols.length > 1;
  console.log('[GraphRenderer] firstColSelected:', firstColSelected, 'useFirstColAsX:', useFirstColAsX);

  const labels = useFirstColAsX
    ? lastRows.map(row => row[0])
    : lastRows.map((_, i) => String(i + 1));
  const xLabel = useFirstColAsX ? lastHeaders[0] : 'Row';
  const dataCols = useFirstColAsX ? lastCols.filter(c => c !== 0) : lastCols;

  const datasets = dataCols.map(colIdx => ({
    label: lastHeaders[colIdx],
    data: lastRows.map(row => {
      const v = parseFloat(row[colIdx]);
      return isNaN(v) ? null : v;
    }),
    tension: 0.1,
    fill: false,
  }));

  if (chartInstance) {
    chartInstance.destroy();
    chartInstance = null;
  }

  const canvas = document.getElementById('chart-canvas') as HTMLCanvasElement;
  const ctx = canvas.getContext('2d')!;
  chartInstance = new Chart(ctx, {
    type: chartType,
    data: { labels, datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: datasets.length > 1 },
      },
      scales: {
        x: { title: { display: true, text: xLabel } },
        y: { title: { display: true, text: 'Value' } },
      },
    },
  });

  const toggleBtn = document.getElementById('btn-toggle-chart-type')!;
  toggleBtn.textContent = chartType === 'line' ? 'Switch to Bar' : 'Switch to Line';
}

export function toggleChartType(): void {
  chartType = chartType === 'line' ? 'bar' : 'line';
  if (lastCols.length > 0) redraw();
}

export function closeGraph(): void {
  if (chartInstance) {
    chartInstance.destroy();
    chartInstance = null;
  }
  document.getElementById('graph-container')!.classList.add('hidden');
}
