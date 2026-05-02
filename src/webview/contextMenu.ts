let menuEl: HTMLElement;
let onShowGraph: (() => void) | null = null;

export function init(showGraphCallback: () => void): void {
  onShowGraph = showGraphCallback;
  menuEl = document.getElementById('context-menu')!;

  document.getElementById('ctx-show-graph')!.addEventListener('click', () => {
    hide();
    onShowGraph?.();
  });

  document.addEventListener('click', () => hide());
  document.addEventListener('keydown', e => { if (e.key === 'Escape') hide(); });
}

export function show(x: number, y: number, hasSelection: boolean): void {
  const showGraphItem = document.getElementById('ctx-show-graph')!;
  showGraphItem.style.opacity = hasSelection ? '1' : '0.4';
  showGraphItem.style.pointerEvents = hasSelection ? 'auto' : 'none';

  menuEl.style.left = `${x}px`;
  menuEl.style.top = `${y}px`;
  menuEl.classList.remove('hidden');
}

function hide(): void {
  menuEl.classList.add('hidden');
}
