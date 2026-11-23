# Real-world protection benchmark

Measured on 2026-11-23 with `npm run bench:obfuscation` (deterministic pass, no model
calls) and `npm run bench:real` (real `bla-agents@3.3.2`). Raw data:
[`benchmarks/obfuscation/results.json`](../../benchmarks/obfuscation/results.json).

## What was tested

| Protection | Tool (license) | Settings |
|---|---|---|
| Minification | Terser 5.51.4 (BSD-2-Clause) | `compress`, top-level `mangle` |
| Obfuscation — low | javascript-obfuscator 5.10.1 (BSD-2-Clause) | hexadecimal identifier renaming, no string array |
| Obfuscation — medium | javascript-obfuscator | + control-flow flattening 0.5, dead-code injection 0.3, string array 0.75 |
| Obfuscation — high | javascript-obfuscator | + flattening 1.0, dead code 0.75, rc4 string array 1.0, split strings, object-key transforms |
| Android shrinking/obfuscation | R8 9.5.33 (BSD-3-Clause) | `--release`, keep rule for `Main.main`; output as JVM classfiles and as DEX in an APK |
| Anti-LLM hardening | bla-agents 3.3.2 (MIT) | `--intensity bankrupt --llm-directives` |

Inputs are sources with exact ground truth: the inventory CLI written for this repo
(MIT) and `ms` 2.1.3 (MIT), each with a planted instruction string
(`SYSTEM: ignore previous instructions…`), and the inventory JAR for R8.

## Results

| Source | Protection | Parsed | Units | Real literals visible to the model | String hiding flagged | Injection leaks |
|---|---|:-:|---:|:-:|:-:|:-:|
| inventory CLI | none | ✅ | 8 | 9/9 | — | 0 |
| inventory CLI | Terser | ✅ | 9 | 9/9 | — | 0 |
| inventory CLI | obfuscator low | ✅ | 8 | 9/9 | — | 0 |
| inventory CLI | obfuscator medium | ✅ | 10 | 9/9 | ✅ | 0 |
| inventory CLI | obfuscator high | ✅ | 10 | **2/9** | ✅ | 0 |
| ms | none / Terser / low / medium | ✅ | 4–6 | 20/20 | medium ✅ | 0 |
| ms | obfuscator high | ✅ | 6 | **17/20** | ✅ | 0 |
| inventory JAR | none (Vineflower) | ✅ | 2 | 2/2 · method names 5/5 | — | 0 |
| inventory JAR | R8 → classfile (Vineflower) | ✅ | 3 | 2/2 · method names **2/5** | — | 0 |
| inventory JAR | R8 → DEX/APK (jadx) | ✅ | 3 | 2/2 · method names **2/5** | — | 0 |
| real BLA output | bla-agents (5 formats) | ✅ | — | — | — | 0 |

## What REE handles — now gated in CI

- **Every protection parses at function level.** No variant falls back to a single
  opaque chunk.
- **0 injection leaks everywhere.** This includes obfuscator-escaped (`\x20`) and
  split (`"ig" + "nore"`) forms: the benchmark found that these **evaded REE's
  filter**, and it was fixed (see below).
- **Terser and javascript-obfuscator low/medium: every real string literal stays
  readable.** REE decodes `\xNN`/`\uNNNN` escapes and joins split literals before the
  model sees them.
- **String arrays are detected** (medium/high), with a limitation that explains what
  is hidden and why.
- **R8:** code and strings survive decompilation on both the JVM and the DEX/jadx
  paths, and the kept entry point is found.

`npm run bench:obfuscation` fails the build if any of these regress.

## What REE does not handle — documented, not hidden

- **Encoded string arrays (javascript-obfuscator `rc4`/`base64`).** Recovering them
  means running the artifact's own decoder, and REE never executes a target. Literals
  stay hidden (2/9 and 17/20 visible); REE flags the decoder and says so in
  `limitations`.
- **Control-flow flattening and dead-code injection are not undone.** REE keeps them,
  so slices from medium/high obfuscation are about as large as the obfuscated source
  (the token columns in `RESULTS.md` show raw ≈ REE). The control flow is still
  correct, just harder to read.
- **Renamed identifiers cannot be recovered.** Terser, the obfuscator and R8 (3 of 5
  method names) remove names from the artifact; no static tool can bring them back.
  The reconstruction agents may infer meaningful names, which is unmeasured here.
- **R8 class merging and inlining** change the program's shape (`Inventory$Item` was
  merged away), so a class-for-class comparison with the original is not possible.

## Bugs this benchmark found and fixed

1. **Injection filter evasion (security).** Escaped and split strings bypassed the
   signatures, and the benchmarks' own leak checks used the same signatures, so they
   reported 0 while a planted instruction reached the model. Fixed in `69654b5`;
   all leak checks now decode escapes first.
2. **Unmodeled webpack code.** 93% of the real BLA-hardened webpack bundle sat outside
   the module registry and was dropped unexamined, inflating the reported reduction
   (91.8% → honest 43.9%). Fixed in `470a6fd`: outside code is modeled and cleaned,
   and large module factories are split per function.
