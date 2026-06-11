export interface ParsedFile {
  fileName: string;
  filePath: string;
  headers: string[];
  rows: string[][];
  hasHeader: boolean;
  delimiter: string;
  truncated: boolean;
  totalRows: number;
}

// Everything in ParsedFile except the (potentially huge) rows array.
export type ParsedMeta = Omit<ParsedFile, 'rows'>;

// 'single' = single table view; 'left'/'right' = compare view panes.
export type LoadChannel = 'single' | 'left' | 'right';

// Large files are streamed to the webview as start -> chunk* -> end. A single
// postMessage carrying the whole dataset can exceed V8's max string length
// (~512 MiB) when VS Code serializes the message, which throws and drops the
// message so nothing renders. Chunking keeps each message small.
export type ExtensionToWebviewMessage =
  | { type: 'loadStart'; channel: LoadChannel; seq: number; meta: ParsedMeta }
  | { type: 'loadChunk'; channel: LoadChannel; seq: number; rows: string[][] }
  | { type: 'loadEnd'; channel: LoadChannel; seq: number }
  | { type: 'error'; message: string };

export type WebviewToExtensionMessage =
  | { type: 'ready' }
  | { type: 'reload' }
  | { type: 'showGraph'; columns: number[] };
