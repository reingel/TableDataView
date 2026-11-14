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
  | { type: 'error'; message: string };

export type WebviewToExtensionMessage =
  | { type: 'ready' }
  | { type: 'reload' }
  | { type: 'showGraph'; columns: number[] }
  | { type: 'notify'; level: 'info' | 'warning'; message: string }
  | { type: 'saveGraphImage'; dataUrl: string };
