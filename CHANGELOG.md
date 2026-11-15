# Changelog

All notable changes to REE are documented here. This project adheres to
[Semantic Versioning](https://semver.org/).

## [1.0.1] — 2026-11-15

### Fixed

- `ree app` / the bundle walker now detects **ELF** main executables, not only
  Mach-O, so bundles built or extracted on Linux (and CI runners) are analyzed
  correctly. Fixes a test failure on Linux.

## [1.0.0] — 2026-11-15

First stable release. REE now neutralizes **real** `bla-agents` output, not just a
simulator of it — validated end to end and gated in CI.

### Highlights

- **Validated against the real adversary.** A new `npm run bench:real` harness
  installs the published `bla-agents`, hardens REE's fixtures at
  `--intensity bankrupt --llm-directives`, and scores REE's pre-pass over that
  genuine output. 0 injection leaks across every format; it fails CI if a single
  BLA marker reaches a context slice.
- **Whole-app analysis.** `ree app <target>` analyzes a macOS `.dmg` (mounted
  read-only, always detached), a `.app` bundle, or an extracted directory,
  routing the Electron `app.asar`, main Mach-O, and dylibs through the pipeline.

### Added

- `src/anti-bla/decoy-family.ts` — structural-clone **decoy-family clustering**.
  Quarantines large templated tarpit-function families and ASAR "mass chaff"
  (thousands of near-identical decoy shards) that reachability cannot touch.
- `src/apps/` — `.dmg` / `.app` bundle walker and read-only mount front-end;
  `analyzeApp()` plus the `ree app` CLI command.
- `src/core/limitations.ts` — every analysis now reports honest caveats (what REE
  could **not** establish), surfaced in the CLI, `--json`, and `ree_strip_decoys`.
- Bitmask MBA opaque predicate `(X|Y) ≥ (X^Y)` (sound for any operands).
- Per-literal **context-bomb elision**: packed/encoded blobs embedded inside
  otherwise-real units are elided, not just whole-unit quarantined.
- `benchmarks/real/` real-adversary harness, GitHub Actions CI, and the
  `docs/audit/phase-1-audit.md` audit report.

### Fixed

- **Prompt-injection leak (critical).** The sanitizer only removed injections in
  comments; BLA plants them in string-literal arrays and JSON data. Injections
  are now **redacted in place** across literals and data, with broadened
  signatures (ChatML frames, `Human:`/`Assistant:` turns, alignment canaries,
  refusal scripts). Measured 42 → 0 leaks on the real Electron case.
- **Electron over-pruning.** `preload`/`renderer`/HTML entry files, wired via
  `BrowserWindow`/`loadFile` rather than `require`, are no longer pruned as dead
  when real BLA output de-literalizes their filenames.

### Changed

- The anti-BLA pipeline is now five passes: fold → prune → decoy-family →
  context-bomb (+ in-unit elision) → redact.
- README leads with the real-adversary results; the synthetic fixtures are kept
  as a clearly-labeled regression table.

### Notes

- REE remains static-only and never executes a target. `.dmg` images are mounted
  read-only. Use only on software you own or are authorized to analyze.

## [0.1.0] — 2026-11-15

Initial release: multi-format parsers (asar, JS/webpack, WASM, `.pyc`,
ELF/Mach-O/PE), the anti-BLA engine, reconstruction agents, MCP server, CLI, and
the synthetic benchmark suite.
