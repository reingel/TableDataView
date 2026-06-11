import * as vscode from 'vscode';
import * as path from 'path';
import { LoadChannel, ParsedMeta } from './types';
import { detectDelimiter, splitLine, detectHeader } from './csvParser';

// Target cells per chunk. ~2M cells ≈ ~18 MiB serialized, comfortably under any
// webview message size limit. Chunk size is computed from the column count so a
// WIDE file (many columns) does not produce an oversized chunk: a fixed
// rows-per-chunk would, on a file with thousands of columns, serialize a single
// message larger than V8's max string length (~512 MiB), which throws during
// VS Code's serialization and drops the message — leaving the table empty.
const CELLS_PER_CHUNK = 2_000_000;

// Yield control back to the event loop so the extension host can answer
// VS Code's health pings (otherwise a large synchronous parse marks the host
// "unresponsive" and the panel never finishes loading).
function yieldToEventLoop(): Promise<void> {
  return new Promise(resolve => setImmediate(resolve));
}

// Parse a (possibly very large, >100 MB) file incrementally and stream it to the
// webview as loadStart -> chunk* -> end. Unlike parseFile()+streamParsedFile(),
// this never holds more than one chunk of parsed rows on the extension side and
// yields to the event loop between chunks, so the host stays responsive.
export async function streamParseAndSend(
  panel: vscode.WebviewPanel,
  content: string,
  filePath: string,
  channel: LoadChannel,
  seq: number
): Promise<void> {
  const fileName = path.basename(filePath);

  // Split into lines and drop blanks in a single pass (filter would allocate a
  // second full-size array, which is wasteful for huge files).
  const rawLines = content.split(/\r?\n/);
  const lines: string[] = [];
  for (let i = 0; i < rawLines.length; i++) {
    if (rawLines[i].trim() !== '') lines.push(rawLines[i]);
  }

  if (lines.length === 0) {
    const meta: ParsedMeta = {
      fileName, filePath, headers: [], hasHeader: false,
      delimiter: ',', truncated: false, totalRows: 0,
    };
    panel.webview.postMessage({ type: 'loadStart', channel, seq, meta });
    panel.webview.postMessage({ type: 'loadEnd', channel, seq });
    return;
  }

  const delimiter = detectDelimiter(lines);
  const firstRow = splitLine(lines[0], delimiter);
  const hasHeader = detectHeader(firstRow);
  const headers = hasHeader
    ? firstRow.map((h, i) => h || `Col${i + 1}`)
    : firstRow.map((_, i) => `Col${i + 1}`);
  const colCount = headers.length;
  const dataStart = hasHeader ? 1 : 0;

  const meta: ParsedMeta = {
    fileName, filePath, headers, hasHeader, delimiter,
    truncated: false, totalRows: lines.length - dataStart,
  };
  panel.webview.postMessage({ type: 'loadStart', channel, seq, meta });

  const chunkRows = Math.max(1, Math.floor(CELLS_PER_CHUNK / Math.max(1, colCount)));
  let batch: string[][] = [];
  for (let i = dataStart; i < lines.length; i++) {
    const cells = splitLine(lines[i], delimiter);
    while (cells.length < colCount) cells.push('');
    if (cells.length > colCount) cells.length = colCount;
    batch.push(cells);
    if (batch.length >= chunkRows) {
      panel.webview.postMessage({ type: 'loadChunk', channel, seq, rows: batch });
      batch = [];
      await yieldToEventLoop();
    }
  }
  if (batch.length > 0) {
    panel.webview.postMessage({ type: 'loadChunk', channel, seq, rows: batch });
  }
  panel.webview.postMessage({ type: 'loadEnd', channel, seq });
}
