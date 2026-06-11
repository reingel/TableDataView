import * as path from 'path';
import { ParsedFile } from './types';

const SAMPLE_LINES = 20;

const DELIMITER_CANDIDATES = [
  { char: ',', weight: 1.0 },
  { char: '\t', weight: 1.0 },
  { char: ';', weight: 0.9 },
  { char: '|', weight: 0.8 },
  { char: ' ', weight: 0.5 },
];

export function detectDelimiter(lines: string[]): string {
  const sample = lines.slice(0, SAMPLE_LINES);
  let bestChar = ',';
  let bestScore = -1;

  for (const { char, weight } of DELIMITER_CANDIDATES) {
    const counts = sample.map(line => {
      if (char === ' ') {
        return line.trim().split(/\s+/).length;
      }
      return line.split(char).length;
    });

    const nonOne = counts.filter(c => c > 1);
    if (nonOne.length === 0) continue;

    const mode = nonOne.reduce((acc, c) => {
      acc[c] = (acc[c] || 0) + 1;
      return acc;
    }, {} as Record<number, number>);

    const [modeCount, modeFreq] = Object.entries(mode).sort((a, b) => b[1] - a[1])[0];
    const consistency = modeFreq / sample.length;
    const score = Number(modeCount) * consistency * weight;

    if (score > bestScore) {
      bestScore = score;
      bestChar = char;
    }
  }

  return bestChar;
}

export function splitLine(line: string, delimiter: string): string[] {
  if (delimiter === ' ') {
    return line.trim().split(/\s+/);
  }
  if (delimiter !== ',') {
    return line.split(delimiter).map(c => c.trim());
  }

  // RFC 4180 quoted field parsing for comma delimiter
  const cells: string[] = [];
  let cell = '';
  let inQuote = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (!inQuote) {
        inQuote = true;
      } else if (line[i + 1] === '"') {
        cell += '"';
        i++;
      } else {
        inQuote = false;
      }
    } else if (ch === ',' && !inQuote) {
      cells.push(cell.trim());
      cell = '';
    } else {
      cell += ch;
    }
  }
  cells.push(cell.trim());
  return cells;
}

function isNumeric(value: string): boolean {
  return value.trim() !== '' && !isNaN(parseFloat(value.trim()));
}

export function detectHeader(firstRow: string[]): boolean {
  const nonNumericCount = firstRow.filter(c => !isNumeric(c)).length;
  return nonNumericCount / firstRow.length >= 0.6;
}

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
