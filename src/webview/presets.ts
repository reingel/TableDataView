import { FormatInfo, ScaleOffsetEntry, SelectionPreset } from '../types';
import { matchHeader, isUniqueHeader } from '../presetMatch';
import { getData, getScaleOffsetSnapshot, restoreScaleOffset } from './tableRenderer';
import { getSelected, getXAxisCol, restoreSelection } from './columnSelector';

// File formats in the table view: when the extension recognises the loaded
// file's format (by its headers), the format's Scale/Offset is applied right
// away and every Scale/Offset edit is saved back to it; named column
// selections of the format are offered in the toolbar's pull-down.

type Post = (msg: object) => void;

let post: Post = () => {};
let refresh: () => void = () => {};
let afterSelectionApplied: () => void = () => {};
let info: FormatInfo = { format: null, scaleOffset: [], presets: [] };
// The saved selection shown as current in the pull-down, and the columns it
// put on the table: it stays shown until the column selection changes.
let activeName: string | null = null;
let activeCols = '';
let saveTimer: ReturnType<typeof setTimeout> | null = null;

const SAVE_DELAY_MS = 300;

function notify(message: string, level: 'info' | 'warning' = 'info'): void {
  post({ type: 'notify', level, message });
}

function headers(): string[] {
  return getData()?.headers ?? [];
}

// "no matching column: a, b; header not unique: c" for whatever didn't resolve.
function unresolvedText(missing: string[], ambiguous: string[]): string {
  const parts: string[] = [];
  if (missing.length) parts.push(`no matching column: ${missing.join(', ')}`);
  if (ambiguous.length) parts.push(`header matches several columns: ${ambiguous.join(', ')}`);
  return parts.join('; ');
}

// refresh: redraw what depends on Scale/Offset (toolbar, graph).
// afterSelectionApplied: a saved selection was put on the table.
export function initPresets(opts: { post: Post; refresh: () => void; afterSelectionApplied: () => void }): void {
  post = opts.post;
  refresh = opts.refresh;
  afterSelectionApplied = opts.afterSelectionApplied;
  const sel = document.getElementById('sel-preset') as HTMLSelectElement;
  sel.addEventListener('change', () => {
    const v = sel.value;
    const name = activeName;
    if (v.startsWith('p:')) applySelection(info.presets[Number(v.slice(2))]);
    else if (v === 'save') saveSelection();
    else if (v === 'delete') post(name !== null ? { type: 'deletePreset', name } : { type: 'deletePreset' });
    else if (v === 'rename' && name !== null) post({ type: 'renamePreset', name });
    else if (v === 'up' && name !== null) post({ type: 'movePreset', name, delta: -1 });
    else if (v === 'down' && name !== null) post({ type: 'movePreset', name, delta: 1 });
    else if (v === 'renameFormat') post({ type: 'renameFormat' });
    // Actions aren't a state to show; go back to the current selection.
    renderMenu();
  });
  renderMenu();
}

// A new format list from the extension. applyScaleOffset: this is the first
// one for a freshly loaded file (not a reload that restored its own state),
// so the format's saved Scale/Offset goes onto the table.
// focus: a selection just saved / renamed / moved, which is what the table
// currently shows, so it becomes the pull-down's current item.
export function onFormatInfo(next: FormatInfo & { focus?: string }, applyScaleOffset: boolean): void {
  info = next;
  if (next.focus !== undefined && next.presets.some(p => p.name === next.focus)) {
    activeName = next.focus;
    activeCols = selectionKey();
  } else if (activeName !== null && !next.presets.some(p => p.name === activeName)) {
    activeName = null;
  }
  renderMenu();
  if (applyScaleOffset && next.format && next.scaleOffset.length > 0) applyFormatScaleOffset(next.format.name, next.scaleOffset);
}

function applyFormatScaleOffset(formatName: string, entries: ScaleOffsetEntry[]): void {
  const hs = headers();
  const snap = getScaleOffsetSnapshot();
  const scales = snap.scales.slice();
  const offsets = snap.offsets.slice();
  const missing: string[] = [];
  const ambiguous: string[] = [];
  for (const e of entries) {
    const col = matchHeader(e.header, hs);
    if (col === 'missing') missing.push(e.header);
    else if (col === 'ambiguous') ambiguous.push(e.header);
    else { scales[col] = e.scale; offsets[col] = e.offset; }
  }
  // The values only take effect with their rows shown.
  restoreScaleOffset({ scaleVisible: true, offsetVisible: true, scales, offsets });
  refresh();
  const text = unresolvedText(missing, ambiguous);
  if (text) notify(`Format "${formatName}" Scale/Offset not applied — ${text}`);
}

// Debounced: typing through several cells saves once.
export function scheduleScaleOffsetSave(): void {
  if (saveTimer !== null) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    saveScaleOffset();
  }, SAVE_DELAY_MS);
}

function saveScaleOffset(): void {
  const hs = headers();
  if (hs.length === 0) return;
  const snap = getScaleOffsetSnapshot();
  const entries: ScaleOffsetEntry[] = [];
  const skipped: string[] = [];
  hs.forEach((h, c) => {
    const scale = snap.scales[c] ?? 1, offset = snap.offsets[c] ?? 0;
    if (isUniqueHeader(h, hs)) entries.push({ header: h, scale, offset });
    else if (scale !== 1 || offset !== 0) skipped.push(h);
  });
  post({ type: 'saveScaleOffset', entries });
  if (skipped.length) notify(`Scale/Offset not saved for duplicate column names: ${[...new Set(skipped)].join(', ')}`, 'warning');
}

function saveSelection(): void {
  const hs = headers();
  const x = getXAxisCol();
  const cols = getSelected().filter(c => c !== x).sort((a, b) => a - b);
  if (cols.length === 0) {
    notify('Select the columns to save first.');
    return;
  }
  const unique = cols.filter(c => isUniqueHeader(hs[c], hs));
  const dup = cols.filter(c => !isUniqueHeader(hs[c], hs)).map(c => hs[c]);
  if (unique.length === 0) {
    notify(`Nothing to save — duplicate column names: ${[...new Set(dup)].join(', ')}`, 'warning');
    return;
  }
  if (dup.length) notify(`Not saved in the selection (duplicate column names): ${[...new Set(dup)].join(', ')}`, 'warning');
  post({ type: 'saveSelection', columns: unique.map(c => ({ header: hs[c] })) });
}

function applySelection(preset: SelectionPreset | undefined): void {
  if (!preset) return;
  const hs = headers();
  const cols: number[] = [];
  const missing: string[] = [];
  const ambiguous: string[] = [];
  for (const { header } of preset.columns) {
    const col = matchHeader(header, hs);
    if (col === 'missing') missing.push(header);
    else if (col === 'ambiguous') ambiguous.push(header);
    else cols.push(col);
  }
  // Set before restoreSelection: its change notification checks against it.
  activeName = preset.name;
  const x = getXAxisCol();
  activeCols = cols.filter(c => c !== x).sort((a, b) => a - b).join(',');
  restoreSelection(cols, x);
  renderMenu();
  afterSelectionApplied();
  const text = unresolvedText(missing, ambiguous);
  if (text) notify(`"${preset.name}": ${text}`);
}

// The selected data columns (x-axis left out), comparable across calls.
function selectionKey(): string {
  const x = getXAxisCol();
  return getSelected().filter(c => c !== x).sort((a, b) => a - b).join(',');
}

// Called on every column selection change: once the table no longer shows the
// applied saved selection, the pull-down stops naming it.
export function onSelectionChanged(): void {
  if (activeName === null || selectionKey() === activeCols) return;
  activeName = null;
  renderMenu();
}

function matchedCount(preset: SelectionPreset, hs: string[]): number {
  return preset.columns.filter(c => typeof matchHeader(c.header, hs) === 'number').length;
}

function renderMenu(): void {
  const sel = document.getElementById('sel-preset') as HTMLSelectElement | null;
  if (!sel) return;
  const hs = headers();
  const opt = (value: string, label: string, disabled = false): HTMLOptionElement => {
    const o = document.createElement('option');
    o.value = value;
    o.textContent = label;
    o.disabled = disabled;
    return o;
  };
  sel.innerHTML = '';
  sel.appendChild(opt('', info.format ? `Format: ${info.format.name}` : 'Format: none'));
  info.presets.forEach((p, i) => sel.appendChild(opt(`p:${i}`, `${p.name}  (${matchedCount(p, hs)}/${p.columns.length})`)));
  const active = activeName === null ? -1 : info.presets.findIndex(p => p.name === activeName);
  sel.appendChild(opt('sep', '──────────', true));
  sel.appendChild(opt('save', 'Save current selection…'));
  if (active >= 0) {
    const n = activeName;
    sel.appendChild(opt('rename', `Rename "${n}"…`));
    sel.appendChild(opt('up', `Move "${n}" up`, active === 0));
    sel.appendChild(opt('down', `Move "${n}" down`, active === info.presets.length - 1));
    sel.appendChild(opt('delete', `Delete "${n}"…`));
  } else {
    // Rename / move act on the selection shown here, so pick one first.
    sel.appendChild(opt('rename', 'Rename selection… (choose one first)', true));
    sel.appendChild(opt('delete', 'Delete selection…', info.presets.length === 0));
  }
  sel.appendChild(opt('sep2', '──────────', true));
  sel.appendChild(opt('renameFormat', info.format ? `Rename format "${info.format.name}"…` : 'Rename format… (no format yet)', !info.format));
  sel.value = active >= 0 ? `p:${active}` : '';
  sel.title = info.format
    ? `Format "${info.format.name}" (${Math.round(info.format.ratio * 100)}% of columns match). Scale/Offset edits are saved to it.`
    : 'No saved format matches this file. Saving a selection or editing Scale/Offset creates one.';
}
