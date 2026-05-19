import { ExtensionToWebviewMessage, ParsedFile } from '../types';
import { render as renderTable, setCrosshairRow, scrollToRow, getData, getRowHeight, isDiff, hasDiff, setDiff, clearDiff, clearAllDiff, hasMovAvg, setMovAvg, clearMovAvg, clearAllMovAvg, getMovAvgWindowSize, getDiffValue, getMovAvgValue, getDiffColsSnapshot, getMovAvgColsSnapshot, setRowClickCallback } from './tableRenderer';
import { getSelected, getXAxisCol, setXAxisCol, resetXAxis, restoreSelection } from './columnSelector';
import { init as initContextMenu, show as showContextMenu } from './contextMenu';
import { renderGraph, resetZoom, resetCrosshairs, hideCrosshairs, closeGraph, setLineWidth, setMarkerStyle, setRowHighlightCallback, setCrosshairToRow, updateViewport, renderFFTPaneFromGraph, isFFTPaneVisible, closeFFTPane } from './graphRenderer';

declare function acquireVsCodeApi(): {
  postMessage: (msg: object) => void;
};

const vscode = acquireVsCodeApi();
let currentData: ParsedFile | null = null;

type ReloadState = {
  scrollTop: number; scrollLeft: number;
  headers: string[];
  selectedCols: number[]; xAxisCol: number;
  diffCols: number[]; movAvgCols: Array<[number, number]>;
};
let pendingReload: ReloadState | null = null;

function saveReloadState(): void {
  if (!currentData) return;
  const c = document.getElementById('table-container')!;
  pendingReload = {
    scrollTop: c.scrollTop, scrollLeft: c.scrollLeft,
    headers: currentData.headers.slice(),
    selectedCols: getSelected(), xAxisCol: getXAxisCol(),
    diffCols: getDiffColsSnapshot(), movAvgCols: getMovAvgColsSnapshot(),
  };
}

function restoreReloadState(headers: string[]): void {
  const s = pendingReload;
  pendingReload = null;
  if (!s || s.headers.join('\0') !== headers.join('\0')) return;
  for (const col of s.diffCols) setDiff(col);
  for (const [col, ws] of s.movAvgCols) setMovAvg(col, ws);
  restoreSelection(s.selectedCols, s.xAxisCol);
  requestAnimationFrame(() => {
    const c = document.getElementById('table-container')!;
    c.scrollTop = s.scrollTop;
    c.scrollLeft = s.scrollLeft;
  });
}

function updateToolbar(): void {
  const selected = getSelected();
  (document.getElementById('btn-show-graph') as HTMLButtonElement).disabled = selected.length === 0;
  const hasCustomState = getXAxisCol() !== 0 || hasDiff() || hasMovAvg();
  document.getElementById('btn-reset-all')!.classList.toggle('hidden', !hasCustomState);
  const graphContainer = document.getElementById('graph-container')!;
  if (!graphContainer.classList.contains('hidden') && currentData && selected.length > 0) {
    renderGraph(currentData.headers, getEffectiveRows(), selected, getXAxisCol());
    if (isFFTPaneVisible()) renderFFTPaneFromGraph();
  }
}

function navigateToRow(rowIdx: number): void {
  setCrosshairRow(rowIdx, getSelected());
  scrollToRow(rowIdx);
  const gc = document.getElementById('graph-container')!;
  if (!gc.classList.contains('hidden')) setCrosshairToRow(rowIdx);
}

function getEffectiveValue(rowIdx: number, colIdx: number): string {
  if (!currentData) return '';
  if (isDiff(colIdx)) return getDiffValue(rowIdx, colIdx);
  const ws = getMovAvgWindowSize(colIdx);
  if (ws !== undefined) return getMovAvgValue(rowIdx, colIdx, ws);
  return currentData.rows[rowIdx][colIdx];
}

function getEffectiveRows(): string[][] {
  if (!currentData) return [];
  if (currentData.rows.length === 0) return [];
  return currentData.rows.map((row, i) =>
    row.map((val, j) => {
      if (isDiff(j)) return getDiffValue(i, j);
      const ws = getMovAvgWindowSize(j);
      if (ws !== undefined) return getMovAvgValue(i, j, ws);
      return val;
    })
  );
}

function handleShowGraph(): void {
  if (!currentData) return;
  const selected = getSelected();
  if (selected.length === 0) return;
  resetZoom();
  resetCrosshairs();
  renderGraph(currentData.headers, getEffectiveRows(), selected, getXAxisCol());
  syncViewport();
}

window.addEventListener('message', (event: MessageEvent) => {
  const msg = event.data as ExtensionToWebviewMessage;

  if (msg.type === 'loadData') {
    currentData = msg.payload;

    document.getElementById('file-name')!.textContent = msg.payload.fileName;
    document.getElementById('delimiter-info')!.textContent =
      `delimiter: ${msg.payload.delimiter === '\t' ? 'tab' : msg.payload.delimiter === ' ' ? 'space' : `'${msg.payload.delimiter}'`}`;

    if (msg.payload.truncated) {
      document.getElementById('truncate-notice')!.textContent =
        `Showing first ${msg.payload.rows.length.toLocaleString()} of ${msg.payload.totalRows.toLocaleString()} rows`;
      document.getElementById('truncate-notice')!.classList.remove('hidden');
    }

    renderTable(msg.payload, updateToolbar);
    restoreReloadState(msg.payload.headers);
    updateToolbar();
  } else if (msg.type === 'error') {
    const container = document.getElementById('table-container')!;
    container.innerHTML = `<div class="error-message">${escapeHtml(msg.message)}</div>`;
  }
});

function escapeHtml(str: string): string {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function highlightTableRow(rowIdx: number): void {
  setCrosshairRow(rowIdx, getSelected());
  scrollToRow(rowIdx);
}

function syncViewport(): void {
  const graphContainer = document.getElementById('graph-container')!;
  if (graphContainer.classList.contains('hidden')) return;
  const container = document.getElementById('table-container')!;
  const rh = getRowHeight();
  const startRow = Math.floor(container.scrollTop / rh);
  const endRow = Math.ceil((container.scrollTop + container.clientHeight) / rh);
  updateViewport(startRow, endRow);
}

function getColSnapPositions(): number[] {
  const ths = Array.from(document.querySelectorAll<HTMLElement>('#header-row th'));
  const nonSticky = ths.filter(th => !th.classList.contains('row-num-cell') && !th.classList.contains('col-first'));
  if (nonSticky.length === 0) return [0];
  const stickyWidth = nonSticky[0].offsetLeft;
  return nonSticky.map(th => th.offsetLeft - stickyWidth);
}

document.addEventListener('keydown', (e: KeyboardEvent) => {
  const tag = (document.activeElement as HTMLElement)?.tagName;
  if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
  if (!['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.key)) return;
  e.preventDefault();

  const container = document.getElementById('table-container')!;
  const modifier = e.metaKey || e.ctrlKey;

  if (e.key === 'ArrowDown') {
    if (modifier) {
      container.scrollTop = container.scrollHeight;
    } else {
      const rh = getRowHeight();
      container.scrollTop = (Math.floor(container.scrollTop / rh) + 5) * rh;
    }
  } else if (e.key === 'ArrowUp') {
    if (modifier) {
      container.scrollTop = 0;
    } else {
      const rh = getRowHeight();
      container.scrollTop = Math.max(0, (Math.ceil(container.scrollTop / rh) - 5) * rh);
    }
  } else if (e.key === 'ArrowRight') {
    if (modifier) {
      container.scrollLeft = container.scrollWidth;
    } else {
      const positions = getColSnapPositions();
      const sl = container.scrollLeft;
      const next = positions.find(p => p > sl + 1);
      container.scrollLeft = next !== undefined ? next : container.scrollWidth;
    }
  } else if (e.key === 'ArrowLeft') {
    if (modifier) {
      container.scrollLeft = 0;
    } else {
      const positions = getColSnapPositions();
      const sl = container.scrollLeft;
      const prev = [...positions].reverse().find(p => p < sl - 1);
      container.scrollLeft = prev ?? 0;
    }
  }
});

document.addEventListener('DOMContentLoaded', () => {
  initContextMenu({
    resetXAxis: () => { resetXAxis(); updateToolbar(); },
    setXAxis: (col) => { setXAxisCol(col); updateToolbar(); },
    showDiff: (col) => { setDiff(col); updateToolbar(); },
    showOriginal: (col) => { clearDiff(col); clearMovAvg(col); updateToolbar(); },
    showMovAvg: (col, windowSize) => { setMovAvg(col, windowSize); updateToolbar(); },
    findNextChange: (col, startRow) => {
      if (!currentData || startRow < 0) return;
      const n = currentData.rows.length;
      const refVal = getEffectiveValue(startRow, col);
      for (let i = startRow + 1; i < n; i++) {
        if (getEffectiveValue(i, col) !== refVal) {
          navigateToRow(i);
          return;
        }
      }
    },
    gotoMax: (col) => {
      if (!currentData) return;
      let maxVal = -Infinity, maxRow = -1;
      for (let i = 0; i < currentData.rows.length; i++) {
        const v = parseFloat(getEffectiveValue(i, col));
        if (isFinite(v) && v > maxVal) { maxVal = v; maxRow = i; }
      }
      if (maxRow >= 0) navigateToRow(maxRow);
    },
    gotoMin: (col) => {
      if (!currentData) return;
      let minVal = Infinity, minRow = -1;
      for (let i = 0; i < currentData.rows.length; i++) {
        const v = parseFloat(getEffectiveValue(i, col));
        if (isFinite(v) && v < minVal) { minVal = v; minRow = i; }
      }
      if (minRow >= 0) navigateToRow(minRow);
    },
  });

  setRowHighlightCallback(highlightTableRow);
  setRowClickCallback((rowIdx) => {
    setCrosshairRow(rowIdx, getSelected());
    const graphContainer = document.getElementById('graph-container')!;
    if (!graphContainer.classList.contains('hidden')) setCrosshairToRow(rowIdx);
  });

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

  document.getElementById('fft-divider')!.addEventListener('mousedown', e => {
    const fftWrapper = document.getElementById('fft-canvas-wrapper')!;
    const startY = e.clientY;
    const startH = fftWrapper.offsetHeight;
    document.body.style.cursor = 'ns-resize';
    document.body.style.userSelect = 'none';
    const onMove = (ev: MouseEvent) => {
      const newH = Math.max(60, Math.min(window.innerHeight - 100, startH + startY - ev.clientY));
      fftWrapper.style.height = `${newH}px`;
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', () => {
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      document.removeEventListener('mousemove', onMove);
    }, { once: true });
    e.preventDefault();
  });

  document.getElementById('btn-top')!.addEventListener('click', () => scrollToRow(0));
  document.getElementById('btn-bottom')!.addEventListener('click', () => {
    const data = getData();
    if (data) scrollToRow(data.rows.length - 1);
  });
  document.getElementById('btn-left')!.addEventListener('click', () => {
    document.getElementById('table-container')!.scrollLeft = 0;
  });
  document.getElementById('btn-right')!.addEventListener('click', () => {
    const c = document.getElementById('table-container')!;
    c.scrollLeft = c.scrollWidth;
  });
  document.getElementById('btn-show-graph')!.addEventListener('click', handleShowGraph);
  document.getElementById('btn-reset-all')!.addEventListener('click', () => {
    resetXAxis();
    clearAllDiff();
    clearAllMovAvg();
    updateToolbar();
  });
  document.getElementById('btn-reload')!.addEventListener('click', () => {
    saveReloadState();
    vscode.postMessage({ type: 'reload' });
  });
  document.getElementById('btn-hide-crosshair')!.addEventListener('click', hideCrosshairs);
  document.getElementById('btn-close-graph')!.addEventListener('click', () => {
    closeGraph();
    setCrosshairRow(null, []);
    document.getElementById('btn-show-fft')!.textContent = 'Show FFT';
  });
  document.getElementById('btn-show-fft')!.addEventListener('click', () => {
    if (isFFTPaneVisible()) {
      closeFFTPane();
      document.getElementById('btn-show-fft')!.textContent = 'Show FFT';
    } else {
      renderFFTPaneFromGraph();
      document.getElementById('btn-show-fft')!.textContent = 'Hide FFT';
    }
  });
  document.getElementById('sel-line-width')!.addEventListener('change', e => {
    setLineWidth(parseFloat((e.target as HTMLSelectElement).value));
  });
  document.getElementById('sel-marker')!.addEventListener('change', e => {
    setMarkerStyle((e.target as HTMLSelectElement).value);
  });

  document.getElementById('table-container')!.addEventListener('scroll', syncViewport, { passive: true });

  document.getElementById('table-container')!.addEventListener('contextmenu', e => {
    e.preventDefault();
    const target = e.target as HTMLElement;
    const colIndexStr = target.closest<HTMLElement>('[data-col-index]')?.dataset.colIndex;
    const colIndex = colIndexStr !== undefined ? parseInt(colIndexStr) : -1;
    const rowIndexStr = target.closest<HTMLElement>('[data-row-index]')?.dataset.rowIndex;
    const rowIndex = rowIndexStr !== undefined ? parseInt(rowIndexStr) : -1;
    showContextMenu(e.clientX, e.clientY, colIndex, rowIndex, {
      isXAxis: colIndex >= 0 && colIndex === getXAxisCol(),
      isDiff: colIndex >= 0 && isDiff(colIndex),
      movAvgWindowSize: colIndex >= 0 ? getMovAvgWindowSize(colIndex) : undefined,
      xAxisIsDefault: getXAxisCol() === 0,
    });
  });

  vscode.postMessage({ type: 'ready' });
});
