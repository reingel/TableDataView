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

export type ExtensionToWebviewMessage =
  | { type: 'loadData'; payload: ParsedFile }
  | { type: 'loadCompareData'; left: ParsedFile; right: ParsedFile }
  | { type: 'error'; message: string };

export type WebviewToExtensionMessage =
  | { type: 'ready' }
  | { type: 'reload' }
  | { type: 'showGraph'; columns: number[] };
