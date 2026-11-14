import { ParsedMeta, TextCells } from '../types';
import { splitLine, normalizeCells } from '../csvSplit';

// A loaded file in the webview. Holding every cell as its own string cost ~2 GB
// of heap on a 430k x 140 file (and GC pauses with it), so the data is kept as:
//  - the raw data lines, split back into cells only for rows being displayed;
//  - every cell's number, one Float64Array per column (parseFloat semantics);
//  - the cells whose number doesn't stand for them (see cellNumber), per column.
// Whole-column work uses the numbers (+ text cells); display uses row().

const ROW_CACHE_SIZE = 2048;

export class TableRows {
  readonly length: number;
  private readonly rowCache = new Map<number, string[]>();

  constructor(
    private readonly lines: string[],
    private readonly delimiter: string,
    private readonly colCount: number,
    private readonly numeric: Float64Array[],
    private readonly texts: Map<number, string>[],
  ) {
    this.length = lines.length;
  }

  // The cells of row i as the file has them, or undefined past the end.
  row(i: number): string[] | undefined {
    if (i < 0 || i >= this.length) return undefined;
    let cells = this.rowCache.get(i);
    if (!cells) {
      cells = normalizeCells(splitLine(this.lines[i], this.delimiter), this.colCount);
      if (this.rowCache.size >= ROW_CACHE_SIZE) {
        this.rowCache.delete(this.rowCache.keys().next().value as number);
      }
      this.rowCache.set(i, cells);
    }
    return cells;
  }

  cell(i: number, col: number): string {
    return this.row(i)?.[col] ?? '';
  }

  // parseFloat of every cell in the column.
  column(col: number): Float64Array {
    return this.numeric[col];
  }

  // The text of a non-numeric cell (see cellNumber), else undefined.
  text(i: number, col: number): string | undefined {
    return this.texts[col]?.get(i);
  }
}

export type TableFile = ParsedMeta & { rows: TableRows };

// VS Code posts typed arrays as binary, but accept a plain buffer too.
function toFloat64(v: unknown): Float64Array {
  if (v instanceof Float64Array) return v;
  if (v instanceof ArrayBuffer) return new Float64Array(v);
  if (ArrayBuffer.isView(v)) {
    const b = v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength);
    return new Float64Array(b);
  }
  return Float64Array.from(Object.values((v ?? {}) as Record<string, number>));
}

// Collects the streamed chunks (loadStart -> loadChunk* -> loadEnd).
export class TableBuilder {
  private readonly lines: string[] = [];
  private numeric: Float64Array[];
  private readonly texts: Map<number, string>[];

  constructor(readonly meta: ParsedMeta) {
    const n = meta.headers.length;
    this.numeric = Array.from({ length: n }, () => new Float64Array(meta.totalRows));
    this.texts = Array.from({ length: n }, () => new Map<number, string>());
  }

  get loaded(): number {
    return this.lines.length;
  }

  add(chunk: { lines: string[]; values: unknown; stride: number; texts: TextCells }): void {
    const base = this.lines.length;
    const k = chunk.lines.length;
    if (base + k > this.numeric[0]?.length) this.grow(base + k);
    const values = toFloat64(chunk.values);
    for (let c = 0; c < this.numeric.length; c++) {
      const off = c * chunk.stride;
      this.numeric[c].set(values.subarray(off, off + k), base);
    }
    const t = chunk.texts;
    for (let i = 0; i < t.rows.length; i++) this.texts[t.cols[i]]?.set(base + t.rows[i], t.vals[i]);
    for (let i = 0; i < k; i++) this.lines.push(chunk.lines[i]);
  }

  // Only if more rows arrive than loadStart announced.
  private grow(min: number): void {
    this.numeric = this.numeric.map(col => {
      const next = new Float64Array(Math.max(min, col.length * 2));
      next.set(col);
      return next;
    });
  }

  finish(): TableFile {
    const n = this.lines.length;
    const numeric = this.numeric.map(col => (col.length === n ? col : col.slice(0, n)));
    return {
      ...this.meta,
      rows: new TableRows(this.lines, this.meta.delimiter, this.meta.headers.length, numeric, this.texts),
    };
  }
}
