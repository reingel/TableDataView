export interface ParsedFile {
  fileName: string;
  headers: string[];
  rows: string[][];
  hasHeader: boolean;
  delimiter: string;
  truncated: boolean;
  totalRows: number;
}

export type ExtensionToWebviewMessage =
  | { type: 'loadData'; payload: ParsedFile }
  | { type: 'error'; message: string };

export type WebviewToExtensionMessage =
  | { type: 'ready' }
  | { type: 'showGraph'; columns: number[] };
