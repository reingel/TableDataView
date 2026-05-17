function nextPow2(n: number): number {
  let p = 1;
  while (p < n) p <<= 1;
  return p;
}

function fftInPlace(re: Float64Array, im: Float64Array): void {
  const N = re.length;
  for (let i = 1, j = 0; i < N; i++) {
    let bit = N >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      let t = re[i]; re[i] = re[j]; re[j] = t;
      t = im[i]; im[i] = im[j]; im[j] = t;
    }
  }
  for (let len = 2; len <= N; len <<= 1) {
    const ang = -2 * Math.PI / len;
    const wRe = Math.cos(ang), wIm = Math.sin(ang);
    for (let i = 0; i < N; i += len) {
      let cRe = 1, cIm = 0;
      for (let j = 0; j < (len >> 1); j++) {
        const h = i + j + (len >> 1);
        const uRe = re[i + j], uIm = im[i + j];
        const vRe = re[h] * cRe - im[h] * cIm;
        const vIm = re[h] * cIm + im[h] * cRe;
        re[i + j] = uRe + vRe; im[i + j] = uIm + vIm;
        re[h] = uRe - vRe; im[h] = uIm - vIm;
        const nr = cRe * wRe - cIm * wIm;
        cIm = cRe * wIm + cIm * wRe;
        cRe = nr;
      }
    }
  }
}

export function computeFFT(
  signal: number[],
  sampleRate: number
): { freqs: number[]; amplitudesDb: number[] } {
  const len = signal.length;
  if (len < 4) return { freqs: [], amplitudesDb: [] };

  let sum = 0, cnt = 0;
  for (const v of signal) { if (isFinite(v)) { sum += v; cnt++; } }
  const mean = cnt > 0 ? sum / cnt : 0;

  const N = nextPow2(len);
  const re = new Float64Array(N);
  const im = new Float64Array(N);
  for (let i = 0; i < len; i++) re[i] = isFinite(signal[i]) ? signal[i] - mean : 0;

  fftInPlace(re, im);

  const half = Math.floor(N / 2);
  const freqs: number[] = [];
  const amplitudesDb: number[] = [];
  for (let k = 1; k <= half; k++) {
    freqs.push(k * sampleRate / N);
    const scale = k < half ? 2 : 1;
    const mag = Math.sqrt(re[k] * re[k] + im[k] * im[k]) * scale / N;
    amplitudesDb.push(mag > 1e-12 ? 20 * Math.log10(mag) : -120);
  }
  return { freqs, amplitudesDb };
}
