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
| pycdc (Decompyle++) | git HEAD | GPL-3.0 | ❌ **not yet** — building it from source was not permitted in this session |
| pylingual (PyPI) | 0.0.1 | — | skipped: the PyPI package is a placeholder, not the published tool |

All three real candidates are GPL-3.0. REE only runs them as separate programs and
never bundles or links them, so REE remains MIT.

## Results

| Python | Module | Decompiler | Output | Compiles | Functions | Behavior |
|---|---|---|:-:|:-:|:-:|:-:|
| 3.8 | colorsys | decompyle3 | ✅ | ❌ | 6/6 | - |
| 3.8 | colorsys | uncompyle6 | ✅ | ✅ | 6/6 | 6/6 |
| 3.8 | ree_sample | decompyle3 | ✅ | ❌ | 8/8 | - |
| 3.8 | ree_sample | uncompyle6 | ✅ | ❌ | 8/8 | - |
| 3.10 | colorsys | decompyle3 | ❌ | – | - | - |
| 3.10 | colorsys | uncompyle6 | ❌ | – | - | - |
| 3.10 | ree_sample | decompyle3 | ❌ | – | - | - |
| 3.10 | ree_sample | uncompyle6 | ❌ | – | - | - |
| 3.12 | colorsys | decompyle3 | ❌ | – | - | - |
| 3.12 | colorsys | uncompyle6 | ❌ | – | - | - |
| 3.12 | ree_sample | decompyle3 | ❌ | – | - | - |
| 3.12 | ree_sample | uncompyle6 | ❌ | – | - | - |
| 3.13 | colorsys | decompyle3 | ❌ | – | - | - |
| 3.13 | colorsys | uncompyle6 | ❌ | – | - | - |
| 3.13 | ree_sample | decompyle3 | ❌ | – | - | - |
| 3.13 | ree_sample | uncompyle6 | ❌ | – | - | - |
| 3.14 | colorsys | decompyle3 | ❌ | – | - | - |
| 3.14 | colorsys | uncompyle6 | ❌ | – | - | - |
| 3.14 | ree_sample | decompyle3 | ❌ | – | - | - |
| 3.14 | ree_sample | uncompyle6 | ❌ | – | - | - |

## Findings

1. **Nothing evaluated works on Python 3.9 or newer.** Both uncompyle6 and decompyle3
   stop with "Unsupported Python version" from 3.10 onward — that is 8 of 10
   version/module combinations, including every currently supported Python release.
2. **Even on 3.8, only 1 of 4 results is fully correct.** uncompyle6 on `colorsys`
   compiles and matches all 6 probes. On the richer sample it recovers all 8
   functions but the output does not compile: a generator lost its iterable
   (`sum((q for q in ))`) and a slice became `[None[:n]]`.
3. **decompyle3 leaks its own parser grammar** (`expr ::= LOAD_STR (1)`) into the
   source on 3.8, so its output never compiles here.
4. **Function names are recovered even when bodies are wrong** (8/8 and 6/6 on 3.8),
   which REE's structure-only mode already provides without any tool.

## What REE does with this

- **pycdc**, when installed, is preferred for every version — it is the only
  maintained option that targets 3.9+. Its quality here is **unmeasured** until it
  can be built and run through this evaluation.
- Otherwise **uncompyle6** is used for bytecode up to 3.8; decompyle3 is not used.
- Output containing known failure markers (`Unsupported Python version`,
  `Parse error`, grammar rules, failed-section markers) is **rejected**, and REE
  keeps structure-only analysis with a warning — broken text is never presented as
  source.
- Accepted output is untrusted: it goes through REE's cleaning engine, and the
  limitations report states that Python decompilers are often subtly wrong.
- For 3.9+ without pycdc, the limitations report says plainly that no maintained
  decompiler fully supports the version.

## Next

Build pycdc (cmake) and re-run `npm run bench:pyc`; the harness already looks for it.
