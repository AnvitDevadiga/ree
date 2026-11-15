/**
 * Deterministic, dependency-free token estimation.
 *
 * This is intentionally an *estimate*, not a real BPE tokenizer: its only job is
 * to let the budget guardrails compare artifacts and slices cheaply before any
 * network call. For exact counts against a model, callers can use the provider's
 * count-tokens endpoint; the heuristic here is conservative (biased slightly high)
 * so budgets are respected rather than overrun.
 */

/** Roughly 1 token per 3.7 characters of code, with a floor for whitespace runs. */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  // Count word-ish chunks and punctuation separately; code is punctuation-dense.
  const words = text.match(/[A-Za-z0-9_]+/g)?.length ?? 0;
  const punct = text.match(/[^A-Za-z0-9_\s]/g)?.length ?? 0;
  const whitespace = text.match(/\s+/g)?.length ?? 0;
  // Words ~1.3 tokens (identifiers split), punctuation ~0.6, whitespace runs ~0.3.
  return Math.ceil(words * 1.3 + punct * 0.6 + whitespace * 0.3);
}

export function sumTokens(parts: Array<string | number>): number {
  let total = 0;
  for (const p of parts) total += typeof p === "number" ? p : estimateTokens(p);
  return total;
}
