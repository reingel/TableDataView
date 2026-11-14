import { TableFile } from './tableData';

// Transformed numeric columns for the graph and other whole-column work: the
// diff / moving average / scale+offset variant of a column is computed once
// and kept until the column's transform changes. (The raw numbers come
// straight from the loaded TableRows.)

export type ColumnTransform = {
  diff: boolean;
  movAvg?: number;  // window size; ignored when diff is set
  scale: number;
  offset: number;
};

export class ColumnStore {
  private readonly eff = new Map<number, { key: string; arr: Float64Array }>();

  constructor(private readonly data: TableFile) {}

  get rowCount(): number {
    return this.data.rows.length;
  }

  rawColumn(col: number): Float64Array {
    return this.data.rows.column(col);
  }

  // Column values as the table shows them (before hex formatting).
  effectiveColumn(col: number, t: ColumnTransform): Float64Array {
    const key = `${t.diff ? 'd' : t.movAvg ?? ''}|${t.scale}|${t.offset}`;
    if (key === '|1|0') return this.rawColumn(col);
    const hit = this.eff.get(col);
    if (hit && hit.key === key) return hit.arr;

    const src = this.rawColumn(col);
    let arr = t.diff ? diffOf(src) : t.movAvg !== undefined ? movAvgOf(src, t.movAvg) : Float64Array.from(src);
    if (t.scale !== 1 || t.offset !== 0) {
      if (arr === src) arr = Float64Array.from(src);
      for (let i = 0; i < arr.length; i++) arr[i] = arr[i] * t.scale + t.offset;
    }
    this.eff.set(col, { key, arr });
    return arr;
  }
}

// Same rule as getDiffValue: row k shows x[k+1] - x[k], the last row repeats
// the one before it, and a NaN on either side leaves the original value.
function diffOf(x: Float64Array): Float64Array {
  const n = x.length;
  const out = Float64Array.from(x);
  if (n < 2) return out;
  for (let r = 0; r < n; r++) {
    const i = r < n - 1 ? r : n - 2;
    const d = x[i + 1] - x[i];
    if (!isNaN(d)) out[r] = d;
  }
  return out;
}

// Same rule and summation order as getMovAvgValue (mean of the non-NaN values
// among the last w rows, else the original value), so each value is bit-for-bit
// what the table shows and equality checks (Find next change) agree with it.
// A running sum would be O(n) but drifts by rounding error.
function movAvgOf(x: Float64Array, w: number): Float64Array {
  const n = x.length;
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let sum = 0, count = 0;
    for (let k = Math.max(0, i - w + 1); k <= i; k++) {
      const v = x[k];
      if (!isNaN(v)) { sum += v; count++; }
    }
    out[i] = count > 0 ? sum / count : x[i];
  }
  return out;
}

const stores = new WeakMap<TableFile, ColumnStore>();

// One store per loaded file; a reload brings a new TableFile and so a fresh store.
export function getColumnStore(data: TableFile): ColumnStore {
  let s = stores.get(data);
  if (!s) {
    s = new ColumnStore(data);
    stores.set(data, s);
  }
  return s;
}
