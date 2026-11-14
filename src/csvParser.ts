import * as path from 'path';
import { ParsedFile } from './types';
import { detectDelimiter, splitLine, detectHeader } from './csvSplit';

export { detectDelimiter, splitLine, detectHeader, normalizeCells } from './csvSplit';

export function parseFile(content: string, filePath: string): ParsedFile {
  const lines = content.split(/\r?\n/).filter(l => l.trim() !== '');
  if (lines.length === 0) {
    return {
      fileName: path.basename(filePath),
      filePath,
      headers: [],
      rows: [],
      hasHeader: false,
      delimiter: ',',
      truncated: false,
      totalRows: 0,
    };
  }

  const delimiter = detectDelimiter(lines);
  const rawRows = lines.map(l => splitLine(l, delimiter));
  const hasHeader = detectHeader(rawRows[0]);

  const headers = hasHeader
    ? rawRows[0].map((h, i) => h || `Col${i + 1}`)
    : rawRows[0].map((_, i) => `Col${i + 1}`);

  const dataRows = hasHeader ? rawRows.slice(1) : rawRows;
  const colCount = headers.length;

  const normalizedRows = dataRows.map(r => {
    const padded = [...r];
    while (padded.length < colCount) padded.push('');
    return padded.slice(0, colCount);
  });

  const totalRows = normalizedRows.length;

  return {
    fileName: path.basename(filePath),
    filePath,
    headers,
    rows: normalizedRows,
    hasHeader,
    delimiter,
    truncated: false,
    totalRows,
  };
}
