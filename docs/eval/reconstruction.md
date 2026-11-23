# Reconstruction benchmark

> **Model used: `openai/gpt-oss-120b` on Groq** (via REE's OpenAI-compatible
> provider), not a Claude model. Results from a different model will differ.

Generated with `npm run bench:reconstruct` on 2026-11-22 and 2026-11-23. Raw data
for every run is in `benchmarks/reconstruct/results.*.json`.

## Method

Four small open-source projects were built into REE's formats, run through REE's full
pipeline (parse → clean → slice → triage → synthesis → verification), and compared
with the real source:

| Fixture | License | Build | Ground truth |
|---|---|---|---|
| `ms` 2.1.3 | MIT | esbuild bundle, not minified | 4 functions; 3 behavioral probe sets |
| `escape-html` 1.0.3 + `dlv` 1.1.3 | MIT | esbuild bundle, **minified** (names mangled) | 2 functions; 2 probe sets |
| `kleur` 4.1.5 | MIT | bundled as `main.js` inside an `.asar` | 3 functions; no probes |
| CPython `colorsys` | PSF-2.0 | `.pyc` | 7 functions; no probes |

- **Function recall:** ground-truth names defined in the reconstruction.
- **Behavior:** probe calls run against every function the reconstruction defines,
  in `node:vm` with no `require` and a 1 s timeout. A probe set passes if some
  reconstructed function reproduces it. This runs only model-written reconstructions
  of these MIT libraries; REE itself never executes an analyzed target.
- The scorer was validated by an oracle test: the real sources pass every probe, and
  wrong or runaway reconstructions fail.

Pricing: $0.15 / $0.60 per million input/output tokens (Groq console, verified).
Spend cap: $2.00. Groq free tier: 8,000 tokens/minute, 200,000 tokens/day.

## Results

### Before the slicing change (one slice per bundle) — 2 complete runs

| Fixture | Slices | Function recall | Behavior | Verifier accepted |
|---|---:|---:|---:|---:|
| `ms` | 1 | 4/4 · 4/4 | **3/3 · 3/3** | 1/1 · 1/1 |
| `escape-html` + `dlv` (minified) | 1 | 2/2 · 2/2 | **2/2 · 2/2** | 1/1 · 1/1 |
| `kleur` (`.asar`) | 2 | 3/3 · 3/3 | not probed | 2/2 · 2/2 |
| `colorsys` (`.pyc`) | 8 | 7/7 · 7/7 ¹ | not probed | 8/8 · 8/8 |
| **Spend** | | | | **$0.0297 · $0.0299** |

### After per-function slicing — 1 complete run, 1 rate-limited

| Fixture | Slices | Function recall | Behavior | Verifier accepted | Spend |
|---|---:|---:|---:|---:|---:|
| `ms` | 8 | 4/4 | 3/3 | 8/8 | $0.0125 |
| `escape-html` + `dlv` (minified) | 5 | **0/2** | **1/2** | 5/5 | $0.0145 |
| `kleur` (`.asar`) | 6 | 3/3 | not probed | 6/6 | $0.0148 |

The second "after" run hit Groq's daily token quota on its first call and is reported
as **n/a (rate-limited)**, not as a quality result ($0.0026).

### With slice packing (the fix) — **pending**

Two runs with packing are still to be measured; they were blocked by Groq's daily
quota. This table will be filled in when they run.

¹ Inflated: REE's structural `.pyc` summary already gives the model every function
name, so name recall on `.pyc` measures nothing about the model.

## What the runs showed

1. **On these small fixtures, gpt-oss-120b reconstructs well.** Both complete
   baseline runs passed every behavioral probe, and recovered real names
   (`escapeHtml`, `dlv`) from a minified bundle where they were `A` and `l`.
2. **Results vary between runs.** In an earlier baseline, the same minified bundle
   came back with `escapeHtml` broken — the model swapped the CommonJS factory's
   `(module, exports)` parameters, so the export never landed. Single runs are not
   reliable; this is why two runs per side were planned.
3. **The verifier is not a quality signal.** It accepted every reconstruction,
   including the broken `escapeHtml` and one with a `TODO` in place of a missing
   variable. Only the behavioral probes caught those.
4. **Per-function slicing hurt reconstruction on small bundles.** The minified
   `escapeHtml` slice could not see the module-level regex it uses (the model wrote
   `// TODO: Provide the definition of w`), name recovery dropped to 0/2, and it cost
   3–4× the tokens. Fine-grained slicing still matters for *cleaning* (it stopped real
   code being quarantined alongside decoys on real BLA output), so the fix keeps
   cleaning per-unit and **packs same-file units back together** (up to ~4,000
   tokens) before reconstruction. That fix is not yet measured.

## Bugs the benchmark found in REE (all fixed)

- **Verdicts in Markdown were ignored.** The model wrote `**VERDICT:** accept`; REE
  only accepted a bare `VERDICT:` line, so all 12 verdicts in the first run were
  recorded as "unverified".
- **Reconstructions shipped with a stray code fence.** Models put the `// notes:`
  trailer inside the fence; splitting there cut the closing fence off, so users got
  source beginning with a code-fence line.
- **One slice per bundle.** esbuild/rollup/UMD bundles hide every declaration in a
  wrapper, so the whole bundle became one opaque slice.
- **Rate limiting.** Bursting calls on an 8K TPM tier exhausted retries and failed
  whole fixtures; REE now paces from `x-ratelimit-*` headers, reports rate-limit
  failures separately from quality, and stops immediately on a daily quota.

Two scorer biases were also fixed (probing private helpers instead of the public API,
and missing functions exposed on a bundle's global object); these affected the
benchmark, not REE.

## Spend

| Run | Spend |
|---|---:|
| baseline (before scoring fixes) | $0.0282 |
| baseline, fixed scoring | $0.0322 |
| before-r1 | $0.0297 |
| before-r2 | $0.0299 |
| after-r1 | $0.0418 |
| after-r2 (rate-limited) | $0.0026 |
| debugging calls (verifier probe, single fixture, aborted runs) | ≈ $0.02 |
| **Total** | **≈ $0.18 of the $2.00 cap** |

## Limits of this benchmark

- Four small fixtures; behavioral probes exist for two. This shows the pipeline works
  end to end, not how it scales to a real application.
- One model only. No Claude or other model was measured.
- Function recall on unminified builds is easy (names are in the input).
