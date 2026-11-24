# Changelog

All notable changes to REE are documented here. This project adheres to
[Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- **`ree` opens an interactive terminal app.** Pick an app from a list of what's on
  the machine (this folder, Downloads, Desktop, Applications) or paste a path, then
  browse an exploded view of its parts: grouped by what they do (start here, screens,
  core logic, network, files, system, config, libraries), with the evidence for each
  grouping, how parts connect, decoys REE removed and what it couldn't determine.
  Open a part to read its cleaned code, follow connections, or ask the configured
  model to explain it. Built on Ink (MIT); works on macOS, Linux and Windows.
- `ree <file>` opens that file in the app (prints the report outside a terminal).
- `ree export <file>` / **e** in the app: a parts workspace with a README map and
  diagram, one Markdown note per part and `parts.json`. Never overwrites a folder.
- Mistyped commands get a suggestion (`ree analyse` → "Did you mean 'ree analyze'?").

### Security

- Everything the app displays comes from the artifact or a model, so control
  characters, terminal escape sequences and bidi overrides are neutralized before
  display; a hostile function name cannot clear the screen, move the cursor or
  retitle the terminal. Export file names are reduced to a safe character set,
  avoid Windows-reserved names and are verified to stay inside the export folder;
  code fences cannot be closed early by the code they contain.

## [2.0.0] — 2026-11-23

REE now understands most of what ships: Android, Java, .NET, native, Python and iOS
alongside JavaScript, Electron and WebAssembly. It installs and runs with one `npx`
command on macOS, Linux and Windows.

### Breaking

- **Node 22 or newer is required** (`engines.node >= 22`). Node 20 is no longer
  tested or supported.
- `ree analyze` now detects the format from content and routes `.dmg`, `.app` and
  directories to whole-app analysis. Unsupported input exits with code 2 and a
  message listing supported formats, instead of being guessed.

### Added

- **Formats:** Android APK/AAB (bounded ZIP + binary-manifest reader), Java JAR and
  `.class`, .NET assemblies (ECMA-335 metadata reader), iOS `.ipa` (structure only;
  encrypted App Store binaries are detected and reported, never decrypted).
- **Optional decompilers, detected at runtime and never bundled:** jadx (APK),
  Vineflower (JAR), ilspycmd (.NET), Ghidra headless (ELF/Mach-O/PE → C per function
  plus call graph), pycdc and uncompyle6 (`.pyc`). Missing tools print an exact install
  command; a tool that is installed but crashes is reported as failed, not missing.
  All tool output is treated as untrusted and cleaned like any other input.
- **Model providers:** any OpenAI-compatible API (Groq, local Ollama/LM Studio/vLLM)
  next to Anthropic; a deterministic-only mode when none is configured; a required
  spending cap with worst-case pre-pricing; rate-limit pacing from provider headers.
- `ree demo` — analyzes two bundled open-source samples, no setup.
- `ree doctor` — Node version, installed tools and what each missing one unlocks,
  provider status (never prints a key).
- Benchmarks: `bench:reconstruct` (reconstruction vs. real source, behavioral
  probes), `bench:obfuscation` (Terser, javascript-obfuscator ×3, R8; CI gate),
  `bench:pyc` (Python decompilers 3.8–3.14). Write-ups in `docs/eval/`.
- Packaging: bundled `samples/`, `npm run smoke:pack` (packs, installs into an empty
  directory, runs the CLI), CI on macOS, Linux and Windows.

### Fixed

- **Security — injection filter evasion:** instructions hidden with `\xNN`/`\u`
  escapes or split across concatenated strings bypassed the sanitizer. Escapes are
  now decoded and fragments joined before matching; metadata summaries and MCP
  results are redacted too.
- **Webpack bundles:** code outside the module registry (93% of a real BLA-hardened
  bundle) was silently ignored; it is now modeled and cleaned, and large module
  factories are split per function. The reported reduction drops from 91.8% to an
  honest 43.9%.
- **Real code discarded with decoys:** units mixing generated filler with real logic
  are split at statement level, so real code is kept (Electron 90% → 80.1%, Node CLI
  65.8% → 41.7% reduction, with the real entry points now preserved).
- esbuild/rollup/UMD bundles were one opaque slice; wrappers are now unwrapped and
  same-file units packed into reconstruction-sized slices. Measured with
  gpt-oss-120b on Groq: full recall and behavior on the minified fixture
  (per-function slicing alone had dropped it to 0/2 names, 1/2 behavior), at
  less than half the cost.
- Verifier verdicts written in Markdown were ignored; reconstructions could ship with
  a stray code fence.
- `.NET` generic types (``Foo`2``) now map to their decompiled file.

### Changed

- README rewritten around understanding, studying and auditing software, with a
  responsible-use section, a supported-formats table and honest benchmark numbers.

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
