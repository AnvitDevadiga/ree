/**
 * Shannon entropy helpers used by the context-bomb detector.
 *
 * BLA-style defenses inflate analyzer cost in two opposite ways:
 *  - very high entropy: packed/encrypted/garbage blobs meant to look like code;
 *  - very low entropy with huge length: repeated filler ("tarpit") designed to
 *    burn context windows.
 * Both are detectable without an LLM.
 */

/** Shannon entropy in bits per byte, range [0, 8]. */
export function shannonEntropy(data: Uint8Array | string): number {
  const bytes =
    typeof data === "string" ? new TextEncoder().encode(data) : data;
  if (bytes.length === 0) return 0;
  const counts = new Array<number>(256).fill(0);
  for (const b of bytes) counts[b]!++;
  let h = 0;
  const n = bytes.length;
  for (const c of counts) {
    if (c === 0) continue;
    const p = c / n;
    h -= p * Math.log2(p);
  }
  return h;
}

/**
 * Compression-ratio proxy via longest-repeated-substring sampling.
 * Returns an approximate "repetitiveness" score in [0, 1]; higher means more
 * repetitive (tarpit-like). Deterministic and linear-ish for our size caps.
 */
export function repetitionScore(text: string, sample = 65536): number {
  const s = text.length > sample ? text.slice(0, sample) : text;
  if (s.length < 32) return 0;
  const seen = new Map<string, number>();
  const window = 16;
  let repeats = 0;
  let total = 0;
  for (let i = 0; i + window <= s.length; i += window) {
    const chunk = s.slice(i, i + window);
    const prev = seen.get(chunk) ?? 0;
    if (prev > 0) repeats++;
    seen.set(chunk, prev + 1);
    total++;
  }
  return total === 0 ? 0 : repeats / total;
}
