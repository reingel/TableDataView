let menuEl: HTMLElement;
let rightClickedCol: number = -1;
let rightClickedRow: number = -1;

let onResetXAxis: (() => void) | null = null;
let onSetXAxis: ((col: number) => void) | null = null;
let onShowDiff: ((col: number) => void) | null = null;
let onShowOriginal: ((col: number) => void) | null = null;
let onShowMovAvg: ((col: number, windowSize: number) => void) | null = null;
let onFindNextChange: ((col: number, row: number) => void) | null = null;
let onGotoMax: ((col: number) => void) | null = null;
let onGotoMin: ((col: number) => void) | null = null;

export interface ContextMenuCallbacks {
  resetXAxis: () => void;
  setXAxis: (col: number) => void;
  showDiff: (col: number) => void;
  showOriginal: (col: number) => void;
  showMovAvg: (col: number, windowSize: number) => void;
  findNextChange: (col: number, row: number) => void;
  gotoMax: (col: number) => void;
  gotoMin: (col: number) => void;
}

export function init(callbacks: ContextMenuCallbacks): void {
  onResetXAxis = callbacks.resetXAxis;
  onSetXAxis = callbacks.setXAxis;
  onShowDiff = callbacks.showDiff;
  onShowOriginal = callbacks.showOriginal;
  onShowMovAvg = callbacks.showMovAvg;
  onFindNextChange = callbacks.findNextChange;
  onGotoMax = callbacks.gotoMax;
  onGotoMin = callbacks.gotoMin;

  menuEl = document.getElementById('context-menu')!;

  document.getElementById('ctx-reset-xaxis')!.addEventListener('click', () => { hide(); onResetXAxis?.(); });
  document.getElementById('ctx-set-xaxis')!.addEventListener('click', () => { hide(); onSetXAxis?.(rightClickedCol); });
  document.getElementById('ctx-show-diff')!.addEventListener('click', () => { hide(); onShowDiff?.(rightClickedCol); });
  document.getElementById('ctx-show-original')!.addEventListener('click', () => { hide(); onShowOriginal?.(rightClickedCol); });
  document.getElementById('ctx-show-movavg-10')!.addEventListener('click', () => { hide(); onShowMovAvg?.(rightClickedCol, 10); });
  document.getElementById('ctx-show-movavg-30')!.addEventListener('click', () => { hide(); onShowMovAvg?.(rightClickedCol, 30); });
  document.getElementById('ctx-show-movavg-100')!.addEventListener('click', () => { hide(); onShowMovAvg?.(rightClickedCol, 100); });
  document.getElementById('ctx-show-movavg-1000')!.addEventListener('click', () => { hide(); onShowMovAvg?.(rightClickedCol, 1000); });
  document.getElementById('ctx-find-next-change')!.addEventListener('click', () => { hide(); onFindNextChange?.(rightClickedCol, rightClickedRow); });
  document.getElementById('ctx-goto-max')!.addEventListener('click', () => { hide(); onGotoMax?.(rightClickedCol); });
  document.getElementById('ctx-goto-min')!.addEventListener('click', () => { hide(); onGotoMin?.(rightClickedCol); });

  document.addEventListener('click', () => hide());
  document.addEventListener('keydown', e => { if (e.key === 'Escape') hide(); });
}

export function show(x: number, y: number, colIndex: number, rowIndex: number, opts: {
  isXAxis: boolean;
  isDiff: boolean;
  movAvgWindowSize: number | undefined;
  xAxisIsDefault: boolean;
}): void {
  rightClickedCol = colIndex;
  rightClickedRow = rowIndex;

  const isTransformed = opts.isDiff || opts.movAvgWindowSize !== undefined;
  setItemVisible('ctx-reset-xaxis', opts.isXAxis && !opts.xAxisIsDefault);
  setItemVisible('ctx-set-xaxis', colIndex >= 0 && !opts.isXAxis);
  setItemVisible('ctx-show-diff', colIndex >= 0 && !isTransformed);
  setItemVisible('ctx-show-movavg-10', colIndex >= 0 && !opts.isDiff && opts.movAvgWindowSize !== 10);
  setItemVisible('ctx-show-movavg-30', colIndex >= 0 && !opts.isDiff && opts.movAvgWindowSize !== 30);
  setItemVisible('ctx-show-movavg-100', colIndex >= 0 && !opts.isDiff && opts.movAvgWindowSize !== 100);
  setItemVisible('ctx-show-movavg-1000', colIndex >= 0 && !opts.isDiff && opts.movAvgWindowSize !== 1000);
  setItemVisible('ctx-show-original', colIndex >= 0 && isTransformed);
  setItemVisible('ctx-find-next-change', colIndex >= 0 && rowIndex >= 0);
  setItemVisible('ctx-goto-max', colIndex >= 0);
  setItemVisible('ctx-goto-min', colIndex >= 0);
  setItemVisible('ctx-find-change-sep', colIndex >= 0);

  menuEl.style.left = `${x}px`;
  menuEl.style.top = `${y}px`;
  menuEl.classList.remove('hidden');
}

function setItemVisible(id: string, visible: boolean): void {
  document.getElementById(id)!.classList.toggle('hidden', !visible);
}

function hide(): void {
  menuEl.classList.add('hidden');
}
