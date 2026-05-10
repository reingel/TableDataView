import { ExtensionToWebviewMessage, ParsedFile } from '../types';
import { render as renderTable, setCrosshairRow, scrollToRow, getData, getRowHeight } from './tableRenderer';
import { getSelected } from './columnSelector';
import { init as initContextMenu, show as showContextMenu } from './contextMenu';
import { renderGraph, toggleChartType, closeGraph, setLineWidth, setRowHighlightCallback } from './graphRenderer';

declare function acquireVsCodeApi(): {
  postMessage: (msg: object) => void;
};

const vscode = acquireVsCodeApi();
let currentData: ParsedFile | null = null;

function updateToolbar(): void {
  const selected = getSelected();
  (document.getElementById('btn-show-graph') as HTMLButtonElement).disabled = selected.length === 0;
  const graphContainer = document.getElementById('graph-container')!;
  if (!graphContainer.classList.contains('hidden') && currentData && selected.length > 0) {
    renderGraph(currentData.headers, currentData.rows, selected);
  }
}

function handleShowGraph(): void {
  if (!currentData) return;
  const selected = getSelected();
  if (selected.length === 0) return;
  renderGraph(currentData.headers, currentData.rows, selected);
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
  initContextMenu(handleShowGraph);

  setRowHighlightCallback(highlightTableRow);

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
  document.getElementById('btn-close-graph')!.addEventListener('click', () => {
    closeGraph();
    setCrosshairRow(null, []);
  });
  document.getElementById('btn-toggle-chart-type')!.addEventListener('click', toggleChartType);
  document.getElementById('sel-line-width')!.addEventListener('change', e => {
    setLineWidth(parseFloat((e.target as HTMLSelectElement).value));
  });

  document.getElementById('table-container')!.addEventListener('contextmenu', e => {
    e.preventDefault();
    showContextMenu(e.clientX, e.clientY, getSelected().length > 0);
  });

  vscode.postMessage({ type: 'ready' });
});
