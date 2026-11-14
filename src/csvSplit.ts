// Line splitting / delimiter and header detection, free of Node APIs so the
// webview can split the rows it displays from the raw lines it keeps.

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

// Pad / truncate a split line to the header's column count.
export function normalizeCells(cells: string[], colCount: number): string[] {
  while (cells.length < colCount) cells.push('');
  if (cells.length > colCount) cells.length = colCount;
  return cells;
}

// "0x1A", "-0b10": Number() reads these as integers, parseFloat as 0.
function hasRadixPrefix(cell: string): boolean {
  let i = cell.charCodeAt(0) === 43 || cell.charCodeAt(0) === 45 ? 1 : 0; // + -
  if (cell.charCodeAt(i) !== 48) return false; // 0
  const c = cell.charCodeAt(i + 1) | 0x20; // lower-case
  return c === 120 || c === 98 || c === 111; // x b o
}

// A cell's number (parseFloat semantics), and whether that number doesn't
// stand for the cell: non-empty, and its whole text isn't a finite decimal
// (dates, words, NaN/Infinity, hex). parseFloat alone can't tell: it reads
// "2024-01-02" as 2024. Such cells travel to the webview as text alongside the
// numeric columns; every other cell is its number. (When Number() accepts the
// whole text it equals parseFloat, so the common case skips parseFloat.)
export function cellNumber(cell: string): { value: number; isText: boolean } {
  if (cell === '') return EMPTY;
  const n = Number(cell);
  if (isFinite(n) && !hasRadixPrefix(cell)) { NUM.value = n; return NUM; }
  TEXT.value = parseFloat(cell);
  return TEXT;
}
// Reused result objects: this runs once per cell of the file.
const EMPTY = { value: NaN, isText: false };
const NUM = { value: 0, isText: false };
const TEXT = { value: 0, isText: true };
