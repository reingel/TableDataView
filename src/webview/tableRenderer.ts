import { ParsedFile } from '../types';
import { init as initSelector, handleColumnClick } from './columnSelector';
import { applyAll, reset as resetAlignment } from './alignmentController';

let currentData: ParsedFile | null = null;

export function getData(): ParsedFile | null {
  return currentData;
}

export function render(data: ParsedFile, onSelectionChange: () => void): void {
  currentData = data;
  resetAlignment();
  initSelector(data.headers.length, onSelectionChange);

  const headerRow = document.getElementById('header-row')!;
  const dataBody = document.getElementById('data-body')!;

  headerRow.innerHTML = '';
  dataBody.innerHTML = '';

  // Row number header cell
  const thRowNum = document.createElement('th');
  thRowNum.textContent = '#';
  thRowNum.className = 'row-num-cell align-right';
  headerRow.appendChild(thRowNum);

  data.headers.forEach((header, colIdx) => {
    const th = document.createElement('th');
    th.textContent = header;
    th.dataset.colIndex = String(colIdx);
    th.className = 'align-left';
    th.addEventListener('click', e => handleColumnClick(colIdx, e as MouseEvent));
    headerRow.appendChild(th);
  });

  data.rows.forEach((row, rowIdx) => {
    const tr = document.createElement('tr');

    const tdRowNum = document.createElement('td');
    tdRowNum.textContent = String(rowIdx + 1);
    tdRowNum.className = 'row-num-cell align-right';
    tr.appendChild(tdRowNum);

    row.forEach((cell, colIdx) => {
      const td = document.createElement('td');
      td.textContent = cell;
      td.dataset.colIndex = String(colIdx);
      td.className = 'align-left';
      td.addEventListener('click', e => handleColumnClick(colIdx, e as MouseEvent));
      tr.appendChild(td);
    });

    dataBody.appendChild(tr);
  });

  applyAll(data.headers.length);
}
