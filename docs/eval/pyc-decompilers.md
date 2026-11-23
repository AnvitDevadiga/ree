# Python `.pyc` decompiler evaluation

Generated 2026-11-23 with `npm run bench:pyc`. Raw data: [`benchmarks/pyc/results.json`](../../benchmarks/pyc/results.json).

## Why this exists

REE's `.pyc` support was structure-only. Before wrapping a decompiler we measured
the open-source options on the same inputs, instead of picking one by reputation.

## Method

For each Python version available locally (3.8, 3.10, 3.12, 3.13, 3.14 — installed
with `uv`), two modules were compiled to `.pyc`:

- **colorsys** — that version's own standard-library module (PSF-2.0): pure
  arithmetic, six functions.
- **ree_sample** — a module written for this repo (MIT) that exercises classes,
  default arguments, a generator expression, a lambda sort key, a list
  comprehension, `try`/`except`, `while`, f-strings and `json`.

Each decompiler's output was scored on four checks:

| Check | Meaning |
|---|---|
| Output | the decompiler produced Python source |
| Compiles | that source compiles under the same Python version |
| Functions | ground-truth function names present as `def` |
| Behavior | the decompiled module returns the same results as the original on fixed probe calls (6 for colorsys, 9 for ree_sample) |

Behavior checks run only these two known open-source modules, in an isolated
`python -I` subprocess with a timeout. REE itself never executes an analyzed target.

## Candidates

| Tool | Version | License | Evaluated |
|---|---|---|---|
| uncompyle6 | 3.9.3 | GPL-3.0 | ✅ (installed with `uv tool install --python 3.8`) |
| decompyle3 | 3.9.3 | GPL-3.0 | ✅ (same) |
| pycdc (Decompyle++) | git `b428976` (2026-04-06) | GPL-3.0 | ✅ (built from source with cmake) |
| pylingual (PyPI) | 0.0.1 | — | skipped: the PyPI package is a placeholder, not the published tool |

All three are GPL-3.0. REE only runs them as separate programs and
never bundles or links them, so REE remains MIT.

## Results

| Python | Module | Decompiler | Output | Compiles | Functions | Behavior |
|---|---|---|:-:|:-:|:-:|:-:|
| 3.8 | colorsys | pycdc | ✅ | ✅ | 6/6 | 1/6 |
| 3.8 | colorsys | decompyle3 | ✅ | ❌ | 6/6 | - |
| 3.8 | colorsys | uncompyle6 | ✅ | ✅ | 6/6 | 6/6 |
| 3.8 | ree_sample | pycdc | ✅ | ❌ | 8/8 | - |
| 3.8 | ree_sample | decompyle3 | ✅ | ❌ | 8/8 | - |
| 3.8 | ree_sample | uncompyle6 | ✅ | ❌ | 8/8 | - |
| 3.10 | colorsys | pycdc | ✅ | ✅ | 6/6 | 1/6 |
| 3.10 | colorsys | decompyle3 | ❌ | – | - | - |
| 3.10 | colorsys | uncompyle6 | ❌ | – | - | - |
| 3.10 | ree_sample | pycdc | ✅ | ❌ | 7/8 | - |
| 3.10 | ree_sample | decompyle3 | ❌ | – | - | - |
| 3.10 | ree_sample | uncompyle6 | ❌ | – | - | - |
| 3.12 | colorsys | pycdc | ✅ | ✅ | 6/6 | 1/6 |
| 3.12 | colorsys | decompyle3 | ❌ | – | - | - |
| 3.12 | colorsys | uncompyle6 | ❌ | – | - | - |
| 3.12 | ree_sample | pycdc | ✅ | ❌ | 8/8 | - |
| 3.12 | ree_sample | decompyle3 | ❌ | – | - | - |
| 3.12 | ree_sample | uncompyle6 | ❌ | – | - | - |
| 3.13 | colorsys | pycdc | ❌ | – | - | - |
| 3.13 | colorsys | decompyle3 | ❌ | – | - | - |
| 3.13 | colorsys | uncompyle6 | ❌ | – | - | - |
| 3.13 | ree_sample | pycdc | ❌ | – | - | - |
| 3.13 | ree_sample | decompyle3 | ❌ | – | - | - |
| 3.13 | ree_sample | uncompyle6 | ❌ | – | - | - |
| 3.14 | colorsys | pycdc | ❌ | – | - | - |
| 3.14 | colorsys | decompyle3 | ❌ | – | - | - |
| 3.14 | colorsys | uncompyle6 | ❌ | – | - | - |
| 3.14 | ree_sample | pycdc | ❌ | – | - | - |
| 3.14 | ree_sample | decompyle3 | ❌ | – | - | - |
| 3.14 | ree_sample | uncompyle6 | ❌ | – | - | - |

## Findings

1. **Only pycdc produces anything on Python 3.10–3.12, and it fails on 3.13+.**
   uncompyle6 and decompyle3 stop with "Unsupported Python version" from 3.10 on.
   pycdc covers 3.8–3.12 but on 3.13 stops at the first function
   (`Unsupported opcode: MAKE_FUNCTION`) and rejects 3.14 (`Bad MAGIC!`). **No
   evaluated tool decompiles 3.13 or 3.14** — the current Python releases.
2. **pycdc's output can compile and still be wrong.** On `colorsys` it compiles under
   3.8, 3.10 and 3.12 but matches only 1 of 6 probes: it prints float literals with
   about six significant digits (`1.0/3.0` becomes `0.333333`), so every numeric
   result drifts. On the richer sample it also turned a default argument `n=2`
   into `n = (2,)` and left sections marked `# WARNING: Decompyle incomplete`.
3. **On 3.8, uncompyle6 is the most faithful.** It is the only tool that is fully
   correct on `colorsys` (6/6). On the richer sample its output does not compile:
   a generator lost its iterable (`sum((q for q in ))`) and a slice became
   `[None[:n]]`.
4. **decompyle3 leaks its own parser grammar** (`expr ::= LOAD_STR (1)`) into the
   source on 3.8.
5. **Function names are recovered even when bodies are wrong** — which REE's
   structure-only mode already provides without any tool.

## What REE does with this

- **Bytecode ≤ 3.8:** uncompyle6 first (most faithful above), pycdc as fallback.
- **3.9–3.12:** pycdc, the only option — and the limitations report states that it
  truncates float literals and can mangle default arguments.
- **3.13+:** no tool works; REE keeps structure-only analysis and says so.
- Output containing known failure markers (`Unsupported Python version`,
  `Bad MAGIC`, parse errors, grammar rules, failed-section markers) is **rejected**,
  and output that recovers **no function or class** from a module that has them is
  treated as a failure — broken text is never presented as source.
- Accepted output is untrusted: it goes through REE's cleaning engine.

## Next

Re-run `npm run bench:pyc` as decompilers add 3.13+/3.14 support; the harness finds pycdc on PATH or in `benchmarks/fixtures/.cache/tools/pycdc-build/`.
