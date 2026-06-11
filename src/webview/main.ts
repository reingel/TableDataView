import { ExtensionToWebviewMessage, ParsedFile, ParsedMeta } from '../types';
import { render as renderTable, setCrosshairRow, scrollToRow, getData, getRowHeight, isDiff, hasDiff, setDiff, clearDiff, clearAllDiff, hasMovAvg, setMovAvg, clearMovAvg, clearAllMovAvg, getMovAvgWindowSize, getDiffValue, getMovAvgValue, getDiffColsSnapshot, getMovAvgColsSnapshot, setRowClickCallback, isHex, hasHex, setHex, clearHex, clearAllHex, getHexColsSnapshot } from './tableRenderer';
import { getSelected, getXAxisCol, getDefaultXAxisCol, setXAxisCol, resetXAxis, restoreSelection } from './columnSelector';
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
  diffCols: number[]; movAvgCols: Array<[number, number]>; hexCols: number[];
};
let pendingReload: ReloadState | null = null;

function saveReloadState(): void {
  if (!currentData) return;
  const c = document.getElementById('table-container')!;
  pendingReload = {
    scrollTop: c.scrollTop, scrollLeft: c.scrollLeft,
    headers: currentData.headers.slice(),
    selectedCols: getSelected(), xAxisCol: getXAxisCol(),
    diffCols: getDiffColsSnapshot(), movAvgCols: getMovAvgColsSnapshot(), hexCols: getHexColsSnapshot(),
  };
}

function restoreReloadState(headers: string[]): void {
  const s = pendingReload;
  pendingReload = null;
  if (!s || s.headers.join('\0') !== headers.join('\0')) return;
  for (const col of s.diffCols) setDiff(col);
  for (const [col, ws] of s.movAvgCols) setMovAvg(col, ws);
  for (const col of s.hexCols) setHex(col);
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
  const hasCustomState = getXAxisCol() !== getDefaultXAxisCol() || hasDiff() || hasMovAvg() || hasHex();
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

// The file is streamed as loadStart -> loadChunk* -> loadEnd. Accumulate rows
// until loadEnd, then render in one pass.
let loadAccum: { seq: number; meta: ParsedMeta; rows: string[][] } | null = null;

function setLoadingText(loaded: number, total: number): void {
  const el = document.getElementById('loading-text');
  if (!el) return;
  el.textContent = total > 0
    ? `로딩 중... ${loaded.toLocaleString()} / ${total.toLocaleString()} 행`
    : '로딩 중...';
}

function showLoading(total = 0): void {
  document.getElementById('loading-overlay')?.classList.remove('hidden');
  setLoadingText(0, total);
}

function hideLoading(): void {
  document.getElementById('loading-overlay')?.classList.add('hidden');
}

window.addEventListener('message', (event: MessageEvent) => {
  const msg = event.data as ExtensionToWebviewMessage;

  if (msg.type === 'loadStart' && msg.channel === 'single') {
    loadAccum = { seq: msg.seq, meta: msg.meta, rows: [] };
    showLoading(msg.meta.totalRows);
  } else if (msg.type === 'loadChunk' && msg.channel === 'single') {
    if (loadAccum && loadAccum.seq === msg.seq) {
      for (let i = 0; i < msg.rows.length; i++) loadAccum.rows.push(msg.rows[i]);
      setLoadingText(loadAccum.rows.length, loadAccum.meta.totalRows);
    }
  } else if (msg.type === 'loadEnd' && msg.channel === 'single') {
    if (loadAccum && loadAccum.seq === msg.seq) {
      const payload: ParsedFile = { ...loadAccum.meta, rows: loadAccum.rows };
      loadAccum = null;
      onLoadData(payload);
      hideLoading();
    }
  } else if (msg.type === 'error') {
    const container = document.getElementById('table-container')!;
    container.innerHTML = `<div class="error-message">${escapeHtml(msg.message)}</div>`;
    hideLoading();
  }
});

function onLoadData(payload: ParsedFile): void {
  currentData = payload;

  document.getElementById('file-name')!.textContent = payload.fileName;

  if (payload.truncated) {
    document.getElementById('truncate-notice')!.textContent =
      `Showing first ${payload.rows.length.toLocaleString()} of ${payload.totalRows.toLocaleString()} rows`;
    document.getElementById('truncate-notice')!.classList.remove('hidden');
  }

  renderTable(payload, updateToolbar);
  restoreReloadState(payload.headers);
  updateToolbar();
}

function escapeHtml(str: string): string {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function highlightTableRow(rowIdx: number): void {
  setCrosshairRow(rowIdx, getSelected());
  scrollToRow(rowIdx);
}

let lastStartRow = -1;
let lastEndRow = -1;
function syncViewport(): void {
  const graphContainer = document.getElementById('graph-container')!;
  if (graphContainer.classList.contains('hidden')) return;
  const container = document.getElementById('table-container')!;
  const rh = getRowHeight();
  const startRow = Math.floor(container.scrollTop / rh);
  const endRow = Math.ceil((container.scrollTop + container.clientHeight) / rh);
  // 가로 스크롤은 그래프 viewport와 무관하므로, 보이는 행 범위가 실제로 변했을
  // 때만 처리한다. (Windows에서 가로 스크롤 시 scrollTop 미세 변동으로 zoom이
  // 리셋되는 문제 방지. macOS와 동작 통일)
  if (startRow === lastStartRow && endRow === lastEndRow) return;
  lastStartRow = startRow;
  lastEndRow = endRow;
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

function initCellTooltip(container: HTMLElement): void {
  container.addEventListener('mouseover', e => {
    const td = (e.target as HTMLElement).closest<HTMLElement>('td[data-col-index], th[data-col-index]');
    if (!td) { hideCellTooltip(); return; }
    // Only when the value is actually clipped.
    if (td.scrollWidth <= td.clientWidth + 1) { hideCellTooltip(); return; }
    if (cellTipTimer !== null) clearTimeout(cellTipTimer);
    cellTipTimer = setTimeout(() => { cellTipTimer = null; showCellTooltip(td); }, 400);
  });
  container.addEventListener('mouseout', hideCellTooltip);
  container.addEventListener('scroll', hideCellTooltip, { passive: true });
}

// ---- Column search (type-to-find header) ----
// Typing an alphanumeric key opens an overlay with an input + a list of headers
// matching the typed prefix; Up/Down + Enter or a click scrolls to that column.
let colSearchActive = false;
let colSearchMatches: number[] = [];
let colSearchSel = 0;

function gotoColumn(colIdx: number): void {
  const container = document.getElementById('table-container')!;
  if (colIdx === 0) {
    container.scrollLeft = 0;
  } else {
    const th = document.querySelector<HTMLElement>(`#header-row th[data-col-index="${colIdx}"]`);
    if (!th) return;
    // Center the column horizontally within the visible area.
    container.scrollLeft = Math.max(0, th.offsetLeft + th.offsetWidth / 2 - container.clientWidth / 2);
  }
  // Flash the column header so the user can spot the target.
  document.querySelectorAll('.col-flash').forEach(el => el.classList.remove('col-flash'));
  document.querySelectorAll(`#header-row th[data-col-index="${colIdx}"], #col-index-row th[data-col-index="${colIdx}"]`)
    .forEach(el => {
      el.classList.remove('col-flash');
      void (el as HTMLElement).offsetWidth; // restart animation
      el.classList.add('col-flash');
    });
}

function renderColSearchList(): void {
  const ul = document.getElementById('col-search-list')!;
  ul.innerHTML = '';
  if (!currentData || colSearchMatches.length === 0) {
    const empty = document.createElement('li');
    empty.id = 'col-search-empty';
    empty.textContent = 'No matching column';
    ul.appendChild(empty);
    return;
  }
  colSearchMatches.forEach((colIdx, idx) => {
    const li = document.createElement('li');
    li.dataset.matchIdx = String(idx);
    if (idx === colSearchSel) li.classList.add('selected');
    const num = document.createElement('span');
    num.className = 'col-num';
    num.textContent = String(colIdx + 1);
    const name = document.createElement('span');
    name.textContent = currentData!.headers[colIdx];
    li.appendChild(num);
    li.appendChild(name);
    ul.appendChild(li);
  });
}

function updateColSearch(): void {
  const input = document.getElementById('col-search-input') as HTMLInputElement;
  const q = input.value.trim().toLowerCase();
  colSearchMatches = [];
  if (currentData) {
    currentData.headers.forEach((h, i) => {
      if (h.toLowerCase().includes(q)) colSearchMatches.push(i);
    });
  }
  colSearchSel = 0;
  renderColSearchList();
}

function moveColSearchSel(delta: number): void {
  if (colSearchMatches.length === 0) return;
  colSearchSel = Math.max(0, Math.min(colSearchMatches.length - 1, colSearchSel + delta));
  renderColSearchList();
  const sel = document.querySelector('#col-search-list li.selected');
  sel?.scrollIntoView({ block: 'nearest' });
}

function commitColSearch(): void {
  if (colSearchMatches.length === 0) return;
  const colIdx = colSearchMatches[colSearchSel];
  closeColSearch();
  gotoColumn(colIdx);
}

function openColSearch(initialChar: string): void {
  if (!currentData) return;
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
  // Keep input focus when clicking an item (mousedown would blur first).
  list.addEventListener('mousedown', e => e.preventDefault());
  list.addEventListener('click', e => {
    const li = (e.target as HTMLElement).closest<HTMLElement>('li[data-match-idx]');
    if (!li) return;
    colSearchSel = parseInt(li.dataset.matchIdx!);
    commitColSearch();
  });

  // Open on alphanumeric keypress when not already typing somewhere.
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

  // Close when clicking outside the overlay.
  document.addEventListener('mousedown', e => {
    if (!colSearchActive) return;
    if (!(e.target as HTMLElement).closest('#col-search')) closeColSearch();
  });
}

function addDragScroll(container: HTMLElement): void {
  container.addEventListener('mousedown', (e: MouseEvent) => {
    if (e.button !== 0) return;
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

document.addEventListener('DOMContentLoaded', () => {
  initContextMenu({
    resetXAxis: () => { resetXAxis(); updateToolbar(); },
    setXAxis: (col) => { setXAxisCol(col); updateToolbar(); },
    showDiff: (col) => { setDiff(col); updateToolbar(); },
    showOriginal: (col) => { clearDiff(col); clearMovAvg(col); clearHex(col); updateToolbar(); },
    showMovAvg: (col, windowSize) => { setMovAvg(col, windowSize); updateToolbar(); },
    showHex: (col) => { setHex(col); updateToolbar(); },
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
    clearAllHex();
    updateToolbar();
  });
  document.getElementById('btn-reload')!.addEventListener('click', () => {
    saveReloadState();
    showLoading();
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

  addDragScroll(document.getElementById('table-container')!);
  initCellTooltip(document.getElementById('table-container')!);
  initColSearch();

  document.getElementById('table-container')!.addEventListener('scroll', syncViewport, { passive: true });

  document.getElementById('table-container')!.addEventListener('contextmenu', e => {
    e.preventDefault();
    const target = e.target as HTMLElement;
    const colIndexStr = target.closest<HTMLElement>('[data-col-index]')?.dataset.colIndex;
    const colIndex = colIndexStr !== undefined ? parseInt(colIndexStr) : -1;
    const rowIndexStr = target.closest<HTMLElement>('[data-row-index]')?.dataset.rowIndex;
    const rowIndex = rowIndexStr !== undefined ? parseInt(rowIndexStr) : -1;
    let colStats: { max: number; min: number; mean: number } | null = null;
    if (colIndex >= 0 && currentData) {
      let maxV = -Infinity, minV = Infinity, sum = 0, count = 0;
      for (let i = 0; i < currentData.rows.length; i++) {
        const v = parseFloat(getEffectiveValue(i, colIndex));
        if (isFinite(v)) { maxV = Math.max(maxV, v); minV = Math.min(minV, v); sum += v; count++; }
      }
      if (count > 0) colStats = { max: maxV, min: minV, mean: sum / count };
    }
    showContextMenu(e.clientX, e.clientY, colIndex, rowIndex, {
      isXAxis: colIndex >= 0 && colIndex === getXAxisCol(),
      isDiff: colIndex >= 0 && isDiff(colIndex),
      movAvgWindowSize: colIndex >= 0 ? getMovAvgWindowSize(colIndex) : undefined,
      xAxisIsDefault: getXAxisCol() === getDefaultXAxisCol(),
      isHex: colIndex >= 0 && isHex(colIndex),
      stats: colStats,
    });
  });

  vscode.postMessage({ type: 'ready' });
});
