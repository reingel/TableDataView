import { exportGraphPng, getGraphCanvasSize, GraphExportOptions } from './graphRenderer';

// Output sizes offered besides the current view. 8 x 6 in follows MATLAB figure
// conventions: laid out at 96 CSS px/in and rendered at 150 dpi (1200 x 900 px),
// so fonts scale with the figure just like `print -r150`.
const PRINT_RATIO = 150 / 96;
const SIZE_PRESETS: Record<string, { width: number; height: number; pixelRatio: number }> = {
  'in8x6': { width: 8 * 96, height: 6 * 96, pixelRatio: PRINT_RATIO },
};

// Wires the graph pane's Save button and its options popover. On confirm the
// PNG is handed to the extension, which asks for the file name and writes it.
export function initGraphSave(post: (msg: object) => void): void {
  const btn = document.getElementById('btn-save-graph')!;
  const pop = document.getElementById('graph-save-popover')!;
  const sizeSel = document.getElementById('sel-save-size') as HTMLSelectElement;
  const legendSel = document.getElementById('sel-save-legend') as HTMLSelectElement;
  const minimapChk = document.getElementById('chk-save-minimap') as HTMLInputElement;
  const close = () => pop.classList.add('hidden');

  btn.addEventListener('click', e => {
    e.stopPropagation();
    if (!pop.classList.contains('hidden')) { close(); return; }
    const cur = getGraphCanvasSize();
    sizeSel.options[0].textContent = cur
      ? `Current view (${Math.round(cur.width)} × ${Math.round(cur.height)})`
      : 'Current view';
    pop.classList.remove('hidden');
  });
  pop.addEventListener('click', e => e.stopPropagation());
  document.addEventListener('click', close);
  document.addEventListener('keydown', e => { if (e.key === 'Escape') close(); });
  document.getElementById('btn-save-graph-cancel')!.addEventListener('click', close);

  document.getElementById('btn-save-graph-ok')!.addEventListener('click', () => {
    close();
    let size = SIZE_PRESETS[sizeSel.value];
    if (!size) {
      const cur = getGraphCanvasSize();
      if (!cur) return;
      size = { width: Math.round(cur.width), height: Math.round(cur.height), pixelRatio: window.devicePixelRatio || 1 };
    }
    const opts: GraphExportOptions = {
      ...size,
      legend: legendSel.value as GraphExportOptions['legend'],
      minimap: minimapChk.checked,
    };
    const dataUrl = exportGraphPng(opts);
    if (dataUrl) post({ type: 'saveGraphImage', dataUrl });
  });
}
