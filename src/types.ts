export interface ParsedMeta {
  fileName: string;
  filePath: string;
  headers: string[];
  hasHeader: boolean;
  delimiter: string;
  truncated: boolean;
  totalRows: number;
}

// A whole file parsed into cells (extension side).
export type ParsedFile = ParsedMeta & { rows: string[][] };

// The non-numeric cells of a chunk (see cellNumber) as parallel arrays:
// chunk-relative row, column, text.
export type TextCells = { rows: number[]; cols: number[]; vals: string[] };

// 'single' = single table view; 'left'/'right' = compare view panes.
export type LoadChannel = 'single' | 'left' | 'right';

// Large files are streamed to the webview as start -> chunk* -> end. A single
// postMessage carrying the whole dataset can exceed V8's max string length
// (~512 MiB) when VS Code serializes the message, which throws and drops the
// message so nothing renders. Chunking keeps each message small.
//
// A chunk carries the raw data lines (the webview splits only the rows it
// displays), every cell's number column-major in one Float64Array (posted as
// binary, so no per-cell strings are created), and the cells that aren't
// numbers. values[c * stride + r] is row r, column c.
export type ExtensionToWebviewMessage =
  | { type: 'loadStart'; channel: LoadChannel; seq: number; meta: ParsedMeta }
  | { type: 'loadChunk'; channel: LoadChannel; seq: number; lines: string[]; values: Float64Array; stride: number; texts: TextCells }
  | { type: 'loadEnd'; channel: LoadChannel; seq: number }
  | { type: 'error'; message: string }
  // focus: a selection to show as current in the pull-down (just saved / renamed / moved).
  | ({ type: 'formatInfo'; focus?: string } & FormatInfo);

// ---- File formats (presets) ----
// A format file holds, for one header signature, the Scale/Offset applied when
// a file of that format is opened and named column selections. Columns are
// referred to by header (see presetMatch), never by index.
export type ScaleOffsetEntry = { header: string; scale: number; offset: number };
// yLabel: graph y-axis title while this selection is shown.
export type SelectionPreset = { name: string; savedAt: number; columns: Array<{ header: string }>; yLabel?: string };
export type FormatFile = {
  version: 1;
  format: { name: string; headers: string[] };
  scaleOffset: ScaleOffsetEntry[];
  presets: SelectionPreset[];
  // Graph x-axis titles, keyed by the default title they replace (the x-axis
  // column's header, or "Row").
  xLabels?: Record<string, string>;
};
export type FormatInfo = {
  format: { name: string; ratio: number } | null;
  scaleOffset: ScaleOffsetEntry[];
  presets: SelectionPreset[];
  xLabels: Record<string, string>;
};

export type WebviewToExtensionMessage =
  | { type: 'ready' }
  | { type: 'reload' }
  | { type: 'showGraph'; columns: number[] }
  | { type: 'notify'; level: 'info' | 'warning'; message: string }
  | { type: 'saveGraphImage'; dataUrl: string }
  | { type: 'formatInfoRequest' }
  // Scale/Offset of every column whose header is unique in the file.
  | { type: 'saveScaleOffset'; entries: ScaleOffsetEntry[] }
  | { type: 'saveSelection'; columns: Array<{ header: string }>; yLabel?: string }
  // label '' = back to the default title.
  | { type: 'saveXLabel'; key: string; label: string }
  | { type: 'saveYLabel'; name: string; label: string }
  // name omitted: pick one in a quick pick.
  | { type: 'deletePreset'; name?: string }
  | { type: 'renamePreset'; name: string }
  | { type: 'movePreset'; name: string; delta: -1 | 1 }
  | { type: 'renameFormat' }
  | { type: 'openFormatFile' };
