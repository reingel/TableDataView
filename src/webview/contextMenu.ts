let menuEl: HTMLElement;
let rightClickedCol: number = -1;

let onResetXAxis: (() => void) | null = null;
let onSetXAxis: ((col: number) => void) | null = null;
let onShowDiff: ((col: number) => void) | null = null;
let onShowOriginal: ((col: number) => void) | null = null;

export interface ContextMenuCallbacks {
  resetXAxis: () => void;
  setXAxis: (col: number) => void;
  showDiff: (col: number) => void;
  showOriginal: (col: number) => void;
}

export function init(callbacks: ContextMenuCallbacks): void {
  onResetXAxis = callbacks.resetXAxis;
  onSetXAxis = callbacks.setXAxis;
  onShowDiff = callbacks.showDiff;
  onShowOriginal = callbacks.showOriginal;

  menuEl = document.getElementById('context-menu')!;

  document.getElementById('ctx-reset-xaxis')!.addEventListener('click', () => { hide(); onResetXAxis?.(); });
  document.getElementById('ctx-set-xaxis')!.addEventListener('click', () => { hide(); onSetXAxis?.(rightClickedCol); });
  document.getElementById('ctx-show-diff')!.addEventListener('click', () => { hide(); onShowDiff?.(rightClickedCol); });
  document.getElementById('ctx-show-original')!.addEventListener('click', () => { hide(); onShowOriginal?.(rightClickedCol); });

  document.addEventListener('click', () => hide());
  document.addEventListener('keydown', e => { if (e.key === 'Escape') hide(); });
}

export function show(x: number, y: number, colIndex: number, opts: {
  isXAxis: boolean;
  isDiff: boolean;
  xAxisIsDefault: boolean;
}): void {
  rightClickedCol = colIndex;

  setItemVisible('ctx-reset-xaxis', opts.isXAxis && !opts.xAxisIsDefault);
  setItemVisible('ctx-set-xaxis', colIndex >= 0 && !opts.isXAxis);
  setItemVisible('ctx-show-diff', colIndex >= 0 && !opts.isDiff);
  setItemVisible('ctx-show-original', colIndex >= 0 && opts.isDiff);

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
