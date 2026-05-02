import { ParsedFile } from '../types';
import { init as initSelector, handleColumnClick, applyHighlight, getSelected } from './columnSelector';

const BUFFER = 40;
let ROW_HEIGHT = 24;

let currentData: ParsedFile | null = null;
let crosshairRowIdx: number | null = null;
let crosshairColIdxs: number[] = [];
let renderPending = false;

export function getData(): ParsedFile | null {
  return currentData;
}

export function setCrosshairRow(rowIdx: number | null, colIdxs: number[]): void {
  crosshairRowIdx = rowIdx;
  crosshairColIdxs = colIdxs;
  applyRowHighlight();
}

export function scrollToRow(rowIdx: number): void {
  const container = document.getElementById('table-container')!;
  const clientHeight = container.clientHeight;
  const rowTop = rowIdx * ROW_HEIGHT;
  const scrollTop = container.scrollTop;
  if (rowTop < scrollTop || rowTop + ROW_HEIGHT > scrollTop + clientHeight) {
    container.scrollTop = Math.max(0, rowTop - clientHeight / 3);
  }
  scheduleRender();
}

export function render(data: ParsedFile, onSelectionChange: () => void): void {
  currentData = data;
  crosshairRowIdx = null;
  crosshairColIdxs = [];

  initSelector(data.headers.length, onSelectionChange);

  const headerRow = document.getElementById('header-row')!;
  headerRow.innerHTML = '';

  const thRowNum = document.createElement('th');
  thRowNum.textContent = '#';
  thRowNum.className = 'row-num-cell align-right';
  headerRow.appendChild(thRowNum);

  data.headers.forEach((header, colIdx) => {
    const th = document.createElement('th');
    th.textContent = header;
    th.dataset.colIndex = String(colIdx);
    th.className = colIdx === 0 ? 'align-left col-first' : 'align-left';
    th.addEventListener('click', e => handleColumnClick(colIdx, e as MouseEvent));
    headerRow.appendChild(th);
  });

  const container = document.getElementById('table-container')!;
  container.removeEventListener('scroll', onScroll);
  container.addEventListener('scroll', onScroll, { passive: true });
  container.scrollTop = 0;

  renderBody();

  requestAnimationFrame(() => {
    const firstRow = document.querySelector('#data-body tr[data-row-index]') as HTMLElement | null;
    if (firstRow) {
      const h = firstRow.getBoundingClientRect().height;
      if (h > 0) ROW_HEIGHT = h;
    }
    const rowNumCell = document.querySelector('th.row-num-cell') as HTMLElement | null;
    if (rowNumCell) {
      document.documentElement.style.setProperty('--row-num-width', `${rowNumCell.offsetWidth}px`);
    }
  });
}

function onScroll(): void {
  scheduleRender();
}

function scheduleRender(): void {
  if (!renderPending) {
    renderPending = true;
    requestAnimationFrame(() => {
      renderPending = false;
      renderBody();
    });
  }
}

function renderBody(): void {
  if (!currentData) return;
  const container = document.getElementById('table-container')!;
  const scrollTop = container.scrollTop;
  const clientHeight = container.clientHeight || 400;
  const totalRows = currentData.rows.length;
  const colCount = currentData.headers.length;

  const start = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - BUFFER);
  const end = Math.min(totalRows - 1, Math.ceil((scrollTop + clientHeight) / ROW_HEIGHT) + BUFFER);

  const tbody = document.getElementById('data-body')!;
  tbody.innerHTML = '';

  if (start > 0) {
    const tr = document.createElement('tr');
    const td = document.createElement('td');
    td.colSpan = colCount + 1;
    td.style.cssText = `height:${start * ROW_HEIGHT}px;padding:0;border:none;pointer-events:none;`;
    tr.appendChild(td);
    tbody.appendChild(tr);
  }

  const frag = document.createDocumentFragment();
  for (let i = start; i <= end; i++) {
    const row = currentData.rows[i];
    const tr = document.createElement('tr');
    tr.dataset.rowIndex = String(i);

    const tdNum = document.createElement('td');
    tdNum.textContent = String(i + 1);
    tdNum.className = 'row-num-cell align-right';
    tr.appendChild(tdNum);

    for (let j = 0; j < row.length; j++) {
      const td = document.createElement('td');
      td.textContent = row[j];
      td.dataset.colIndex = String(j);
      td.className = j === 0 ? 'align-left col-first' : 'align-left';
      td.addEventListener('click', e => handleColumnClick(j, e as MouseEvent));
      tr.appendChild(td);
    }
    frag.appendChild(tr);
  }
  tbody.appendChild(frag);

  if (end < totalRows - 1) {
    const tr = document.createElement('tr');
    const td = document.createElement('td');
    td.colSpan = colCount + 1;
    td.style.cssText = `height:${(totalRows - 1 - end) * ROW_HEIGHT}px;padding:0;border:none;pointer-events:none;`;
    tr.appendChild(td);
    tbody.appendChild(tr);
  }

  applyHighlight();
  applyRowHighlight();
}

function applyRowHighlight(): void {
  document.querySelectorAll('td.crosshair-row').forEach(el => el.classList.remove('crosshair-row'));
  if (crosshairRowIdx === null) return;
  const tr = document.querySelector(`#data-body tr[data-row-index="${crosshairRowIdx}"]`);
  if (!tr) return;
  crosshairColIdxs.forEach(colIdx => {
    const td = tr.querySelector<HTMLElement>(`[data-col-index="${colIdx}"]`);
    if (td) td.classList.add('crosshair-row');
  });
}
