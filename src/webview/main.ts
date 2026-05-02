import { ExtensionToWebviewMessage, ParsedFile } from '../types';
import { render as renderTable } from './tableRenderer';
import { getSelected, applyAlignment } from './columnSelector';
import { init as initContextMenu, show as showContextMenu } from './contextMenu';
import { renderGraph, toggleChartType, closeGraph } from './graphRenderer';

declare function acquireVsCodeApi(): {
  postMessage: (msg: object) => void;
};

const vscode = acquireVsCodeApi();
let currentData: ParsedFile | null = null;

function updateToolbar(): void {
  const selected = getSelected();
  const hasSelection = selected.length > 0;
  (document.getElementById('btn-show-graph') as HTMLButtonElement).disabled = !hasSelection;
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

document.addEventListener('DOMContentLoaded', () => {
  initContextMenu(handleShowGraph);

  document.getElementById('btn-align-left')!.addEventListener('click', () => applyAlignment('left'));
  document.getElementById('btn-align-center')!.addEventListener('click', () => applyAlignment('center'));
  document.getElementById('btn-align-right')!.addEventListener('click', () => applyAlignment('right'));
  document.getElementById('btn-show-graph')!.addEventListener('click', handleShowGraph);
  document.getElementById('btn-close-graph')!.addEventListener('click', closeGraph);
  document.getElementById('btn-toggle-chart-type')!.addEventListener('click', toggleChartType);

  document.getElementById('table-container')!.addEventListener('contextmenu', e => {
    e.preventDefault();
    showContextMenu(e.clientX, e.clientY, getSelected().length > 0);
  });

  vscode.postMessage({ type: 'ready' });
});
