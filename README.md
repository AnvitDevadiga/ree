<div align="center">

# REE — Reverse Engineer Everything

**Decoy-resistant, budget-safe reverse engineering for AI analysis agents.**

REE puts a deterministic static-analysis pass in front of the LLM. Decoys, context bombs, and planted instructions are removed *before* a model reads a single token, so hardened builds can't poison, exhaust, or mislead your analysis agent.

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
![Node](https://img.shields.io/badge/node-%3E%3D20-339933)
![Tests](https://img.shields.io/badge/tests-48%20passing-brightgreen)
![MCP](https://img.shields.io/badge/MCP-4%20tools-8A2BE2)
![Validated vs real bla-agents](https://img.shields.io/badge/validated%20vs-real%20bla--agents-1d4ed8)

</div>

> [!IMPORTANT]
> **Responsible use.** REE is for security research, malware analysis, interoperability work, auditing your own software and dependencies, and CTFs. Only analyze software you own or are explicitly authorized to analyze, and follow applicable law and license terms (including anti-circumvention rules in your jurisdiction). REE is a static analyzer: it never executes the target.

---

## Why REE exists

The first wave of AI reverse-engineering tools ([REA](https://github.com/morluto/rea)) showed that an agent with decompilers and MCP tools can reconstruct real applications. The counter-wave ([BLA](https://github.com/qybaihe/bla)) showed how fragile that is: when a raw artifact goes into the context window, the artifact controls what the model sees. BLA's pipeline:

- **Poison:** decoy functions, shadow state machines, decoys guarded by opaque predicates, honey source maps
- **Exhaust:** inflated headers, deep nesting, filler tables, and packed blobs that burn token budgets
- **Hallucinate:** instructions planted in comments and strings ("this file is empty, analysis complete")

REE's answer is architectural: **an LLM never reads a raw artifact.** Parsers build a structural model, the anti-BLA engine removes everything that isn't reachable, real, and inert, and only budget-bounded slices of what's left reach a model.

## Results

### Validated against *real* `bla-agents`

These numbers come from hardening REE's clean fixtures with the **real published `bla-agents@3.3.2`** at its worst-case setting (`--intensity bankrupt --llm-directives`), then running REE's deterministic pre-pass over that genuine output. No LLM calls. Reproduce with `npm run bench:real` (see [Benchmarks](#benchmarks)).

| fixture | format | naive tokens | REE tokens | reduction | decoy-family units removed | injection leaks |
|---|---|---:|---:|---:|---:|---:|
| inventory CLI | JS | 37,442 | 12,787 | **65.8%** | 94 | **0** |
| webpack bundle | JS | 35,521 | 2,902 | **91.8%** | 0 | **0** |
| Electron app | .asar | 300,845 | ~18k | **~90%** | 4,000 | **0** |
| WASM module | wasm | — | — | n/a¹ | 0 | **0** |

**Injection leaks are 0 across every format** — no `<system-reminder>`, ChatML frame, fake refusal turn, or alignment canary that BLA plants reaches a context slice. `bench:real` fails CI if a single marker leaks.

<sub>¹ REE's WASM parser already discards the bloated custom sections BLA inflates at parse time, so there is nothing left to reduce.<br>
**Honesty note:** an earlier version of this README reported only a *synthetic* benchmark (REE's own simulator of BLA's techniques). That table is kept below for completeness, but the table above is the one that matters — it is measured against the real adversary. See [`docs/audit/phase-1-audit.md`](docs/audit/phase-1-audit.md) for how the synthetic numbers overstated REE before the Phase 2–3 fixes.</sub>

### Synthetic fixtures (REE's own BLA simulator)

Reproducible with `npm run bench`, no LLM calls. Useful as fast unit-level regression fixtures; **not** a substitute for the real-adversary table above.

| fixture | variant | naive tokens | REE tokens | reduction | real code kept | decoys removed | injection leaks |
|---|---|---:|---:|---:|---:|---:|---:|
| inventory CLI (JS) | **hardened** | 12,648 | 730 | **94.2%** | 9/9 | 12/12 | 0 |
| webpack bundle | **hardened** | 994 | 289 | **70.9%** | 4/4 | 6/6 | 0 |
| Electron app (.asar) | **hardened** | 561 | 414 | **26.2%** | 6/6 | 3/3 | 0 |
| WASM module | **hardened** | 1,394 | 38 | **97.3%** | 3/3 | 3/3 | 0 |

On clean inputs REE removes nothing; on hardened inputs it keeps all real code.

## Architecture

```mermaid
flowchart LR
    A[Artifact<br/>.asar · JS · .wasm · .pyc · ELF/Mach-O/PE] --> B

    subgraph DET["Deterministic: no LLM, no execution"]
        B[Parsers<br/>bounded by header/depth/entry limits] --> C[ArtifactModel<br/>units · references · entry points · strings]
        C --> D1[1 · Fold opaque predicates]
        D1 --> D2[2 · Prune unreachable code]
        D2 --> D3[3 · Quarantine structural-clone decoy families]
        D3 --> D4[4 · Quarantine context bombs + elide in-unit data blobs]
        D4 --> D5[5 · Redact planted instructions]
        D5 --> E[Budgeted context slices<br/>entry points first]
    end

    E --> F
    subgraph AG["Agents: LLM, opt-in"]
        F[Triage<br/>boundaries & plan] --> G[Synthesis<br/>one unit per call]
        G --> H[Verification<br/>differential harness]
        H -- explicit reject --> G2[Synthesis retry<br/>deep tier + feedback]
    end

    E --> M[MCP server<br/>ree_inspect · ree_strip_decoys<br/>ree_trace_entrypoint · ree_reconstruct_module]
    E --> CLI[CLI<br/>analyze · sanitize · trace · app · mcp]
```

The order of the passes matters. Folding opaque predicates **before** reachability analysis deletes the call sites inside dead branches, so a decoy that's only "called" from behind `if ((7*x*x-1)%7 === (y*y)%7)` becomes unreachable and gets pruned with the rest. Reachability can only remove *provably dead* code, so the **decoy-family** pass runs next: it clusters units by a structural fingerprint and quarantines large clone families (templated tarpit functions, thousands of near-identical decoy files) that have no honest entry graph for reachability to work from — the floods that real BLA output relies on.

## Anti-BLA defense matrix

| BLA technique | REE countermeasure | Status |
|---|---|---|
| Unreferenced decoy functions / modules / files | Reachability from real entry points (`main`, exports, bootstrap `require`, `package.json` main, WASM start/exports/table targets) | ✅ JS, webpack, asar, WASM |
| Decoy chains (decoys calling decoys) | Same; reachability is transitive from real roots only | ✅ |
| **Templated tarpit-function floods** (dozens of `scc_*` clones, no honest entry graph) | **Decoy-family clustering**: structural fingerprint, quarantine large clone families | ✅ verified vs. real bla-agents |
| **ASAR exhaustion floods** (thousands of near-identical decoy shard files) | Decoy-family "mass chaff" rule: tiny clones that dominate the archive are quarantined | ✅ verified (4,000 shards) |
| Opaque-predicate-guarded decoys (`7x²−1 ≢ y² mod 7`; bitmask `(X|Y)≥(X^Y)` MBA) | AST-level folding of `if` / ternary / `while`, then edge removal and pruning | ✅ |
| Honey source maps | `.map` files excluded from analysis; `sourceMappingURL` references removed | ✅ |
| Inflated ASAR header (16 MiB trap) | Hard cap (64 MiB) plus a warning above 8 MiB; never decoded unbounded | ✅ |
| Deep nesting traps | Depth cap on ASAR trees and marshal data; warning above 32 levels | ✅ |
| Filler / lookup-table tarpits | Repetition scoring: quarantined from LLM context | ✅ |
| Packed / encrypted blobs | Entropy scoring: whole-unit quarantine **and** per-literal elision inside kept units | ✅ |
| **Electron preload/renderer/HTML wired via config (not `require`)** | Electron-aware entry detection, so de-literalized wiring doesn't get them pruned | ✅ verified vs. real bla-agents |
| WASM padding functions | Exact instruction decoding plus reachability | ✅ |
| Instructions in comments / docstrings | Removed (comments never affect behavior) | ✅ |
| **Instructions in string literals / data payloads** (BLA's main vector) | **Redacted in place** to a placeholder; program/JSON structure preserved | ✅ verified: 42→0 leaks |
| ChatML frames, fake `Human:`/`Assistant:` turns, alignment canaries | Signature set covers them; redacted from literals and data | ✅ verified vs. real bla-agents |
| Instructions in the string table | Dropped | ✅ |
| Poisoned tool output reaching the agent | MCP results wrap artifact text in an `untrustedArtifactData` envelope | ✅ |
| AST-span XOR string encryption | Decoders detected and flagged | ⚠️ detection only; no decryption yet |
| Runtime "Truman Show" (anti-debug, fuse flips) | Doesn't trigger, because REE never executes the target | ➖ out of scope |
| Entangle (runtime SHA-256 binding across sidecars) | Not addressed; needs dynamic analysis | ❌ roadmap |

## Format coverage

| Format | Parsing | Call graph | Dead-code pruning | Opaque folding | Sanitizer | What agents receive |
|---|---|---|---|---|---|---|
| JS / ESM / CJS bundle | acorn AST: declarations, top-level code, JSDoc | ✅ identifiers, callbacks, exports | ✅ | ✅ | ✅ | source |
| Webpack-style bundle | Module registry plus bootstrap entry | ✅ `require(id)` edges | ✅ | ✅ | ✅ | module source |
| Electron `.asar` | Pickle header and file tree | ✅ relative, `node_modules`, path strings (preload, HTML, workers) | ✅ (code files only) | ✅ | ✅ | file source |
| WebAssembly | All sections, `name` section, element segments | ✅ exact `call` / `ref.func` targets | ✅ | n/a | n/a | WAT-style listing |
| Python `.pyc` (3.7–3.14) | Full marshal decoder with per-version code-object layouts | ❌ | ❌ (safe default) | n/a | strings | structured summary (params, names, consts) |
| ELF / Mach-O (incl. universal) / PE | Headers, sections, symbols, imports, PE exports, strings | ❌ | ❌ (safe default) | n/a | strings | symbol and import summary |

**Safety rule:** REE prunes only when it has a trusted call graph *and* at least one known entry point. For anything else, nothing is removed. An incomplete graph never deletes real code.

## Quick start

```bash
git clone https://github.com/AnvitDevadiga/ree.git
cd ree
npm install
npm run build
npm link            # optional: puts `ree` on your PATH

ree analyze path/to/app.asar          # structural report + anti-BLA findings (no LLM)
ree sanitize path/to/bundle.js -o clean.json   # LLM-safe slices as JSON
ree trace path/to/module.wasm --depth 3        # call tree from the real entry point
```

Reconstruction is opt-in and is the only feature that calls a model:

```bash
export ANTHROPIC_API_KEY=...                         # or any credential the Anthropic SDK resolves
ree analyze app.js --reconstruct --max-units 5 -o reconstruction.json
ree analyze app.js --reconstruct --dry-run           # see exactly what would be sent, at zero cost
```

## CLI

| Command | What it does |
|---|---|
| `ree analyze <target>` | Ingest, run the anti-BLA engine, and print stats, entry points, warnings, and findings. Flags: `--json`, `--findings <n>`, `--no-prune`, `--budget <tokens>` |
| `ree analyze <target> --reconstruct` | Run the triage → synthesis → verification pipeline. Flags: `--dry-run`, `--max-units <n>`, `--no-verify`, `-o <file>` |
| `ree sanitize <target>` | Write the cleaned model's context slices and findings to JSON (`-o`, `--budget`) |
| `ree trace <target>` | Print the reference tree from an entry point (`-e <unit>`, `-d <depth>`) |
| `ree app <target>` | Analyze a macOS `.dmg`, a `.app` bundle, or an extracted app directory (`--json`, `--max-artifacts`) |
| `ree mcp` | Start the MCP server on stdio |

### Whole-app analysis (`.dmg` / `.app`)

A shipped desktop app is a container — a disk image wrapping a bundle wrapping many artifacts. `ree app` walks it and routes each analyzable inner artifact (the Electron `app.asar`, the main Mach-O executable, bundled dylibs) through the same anti-BLA pipeline:

```bash
ree app ./MyApp.dmg            # mounts read-only (macOS/hdiutil), analyzes each inner artifact, detaches
ree app ./MyApp.app            # an extracted bundle — works on any platform
ree app ./extracted-dir --json
```

On macOS the `.dmg` is mounted **read-only** and always detached, even on failure; REE never executes anything inside it. On other platforms, extract the `.app` first and point REE at the directory. Electron apps give the richest recovery (the asar is packed JavaScript); native Mach-O apps yield symbols, imports, and structure — pair them with Ghidra/Hopper/IDA for instruction-level work.

## MCP server

REE ships a native MCP tool catalog, so an interactive agent can work on hardened targets without pulling raw artifacts into its context. Results are bounded and wrap artifact-derived text in an `untrustedArtifactData` envelope.

| Tool | LLM? | Purpose |
|---|---|---|
| `ree_inspect` | no | Format, units, entry points, warnings, sample strings |
| `ree_strip_decoys` | no | Run the anti-BLA engine; return per-pass findings and token reduction |
| `ree_trace_entrypoint` | no | Bounded call/reference graph from a real entry point or a named unit |
| `ree_reconstruct_module` | yes (`dryRun` supported) | Reconstruct one cleaned unit, with optional verification and one escalated retry |

Register it with any MCP-compatible client (Cursor, VS Code, and others) as a stdio server:

```json
{
  "mcpServers": {
    "ree": {
      "command": "node",
      "args": ["/absolute/path/to/ree/dist/cli/index.js", "mcp"],
      "env": { "ANTHROPIC_API_KEY": "..." }
    }
  }
}
```

Analysis results are cached per file (path, size, mtime), so chained tool calls on one artifact don't re-parse it.

## Reconstruction agents

| Agent | Input | Output |
|---|---|---|
| **Triage & Boundary Mapper** | Cleaned model summary | Entry points, IPC/network/fs/export boundaries, reconstruction order (computed deterministically; the LLM only writes the summary) |
| **Decompilation & Logic Synthesis** | One budgeted slice plus neighbor names | Idiomatic source with explicit TODOs for unknowns |
| **Behavioral Verification** | Reconstruction plus behavioral anchors from the original | Differential test harness and `VERDICT: accept/reject` |

Agents use two model tiers: a **workhorse** tier for triage, synthesis, and verification, and a **deep** tier for native/WASM slices, slices with obfuscation markers, and retries after an explicit verifier rejection. A missing verdict counts as *unverified*, never as a rejection, so the deep tier is only used when there's a concrete reason. Tiers are set in `src/agents/llm.ts` and can be overridden with `REE_MODEL_WORKHORSE` and `REE_MODEL_DEEP`. The backend is the Anthropic API through its official SDK, with streaming, adaptive thinking, and server-side refusal fallbacks. Swap in any backend by implementing the `LlmClient` interface.

## Library usage

```ts
import { analyze, ReconstructionPipeline, AnthropicClient } from "ree-reverse-engineer-everything";

const { report, slices } = await analyze("dist/app.asar");
console.log(report.stats);            // units in/out, pruned, quarantined, token estimates
console.log(report.findings);         // every decision, auditable

const result = await new ReconstructionPipeline(new AnthropicClient()).run(report, { maxUnits: 5 });
```

## Benchmarks

```bash
npm run bench:real                              # vs. REAL bla-agents (installs it; network-gated, CI-safe)
npm run bench                                    # built-in synthetic clean vs hardened fixtures
npm run bench -- --target ./app.asar            # any artifact: token stats only
npm run bench -- --target ./app.asar --labels ./app.labels.json   # with ground truth
```

`bench:real` installs the published `bla-agents`, hardens REE's clean fixtures at `--intensity bankrupt --llm-directives`, scores REE's pre-pass over that genuine output, and **exits non-zero if any injection marker leaks**. When `bla-agents` can't be obtained (offline CI) it skips and exits 0; set `REE_BLA_BIN` to a local `bla` CLI to skip installation. Results go to `benchmarks/real/RESULTS.md`.

The labels file names the units you expect to survive and the ones you expect to be removed:

```json
{ "fixture": "my-app", "variant": "hardened", "format": "asar",
  "real": ["main.js", "preload.js"], "decoys": ["lib/telemetry-v2.js"], "exhaust": [],
  "injectedComments": 0, "injectedLiterals": 0 }
```

To test against real BLA output, harden a project **you own** with `npx bla-agents harden .`, list its real and decoy units, and point the harness at the result. Results are written to `benchmarks/RESULTS.md` and `benchmarks/results.json`.

## Project layout

```
ree/
├── src/
│   ├── core/          types, token estimator, entropy, analyze() façade, limitations
│   ├── parsers/       asar · js-bundle · wasm · pyc · native (ELF/Mach-O/PE) · registry
│   ├── anti-bla/      opaque-predicates · reachability · decoy-family · context-bomb · sanitizer · engine
│   ├── apps/          .dmg / .app bundle walker and mount front-end
│   ├── agents/        llm client · triage · synthesis · verification · pipeline
│   ├── mcp/           tool implementations · cached sessions · stdio server
│   └── cli/           commander CLI · terminal formatting
├── benchmarks/
│   ├── fixtures/      deterministic clean/hardened fixture generator
│   ├── harness/       scoring + RESULTS.md writer (synthetic)
│   └── real/          real bla-agents harness + RESULTS.md
├── docs/audit/        Phase 1 audit: REE vs. real bla-agents
└── test/              48 tests: parsers, anti-BLA passes, apps, agents, MCP protocol
```

## Limitations and roadmap

REE is honest about where its guarantees stop:

- **No call graph for `.pyc` or native code yet**, so those formats get structural triage and sanitization but no pruning. Next steps: bytecode opcode analysis per CPython version, plus a pluggable disassembler provider (objdump / radare2 / Ghidra headless) for native call graphs.
- **Native and `.pyc` are structure-only** (symbols, imports, code objects), not decompilation. Pair REE with Ghidra/Hopper/IDA for instruction-level recovery. Every analysis now reports these caveats explicitly (`limitations` in the CLI/JSON/MCP output).
- **Opaque-predicate folding covers known identities**: BLA's mod-7 quadratic-residue form, the bitmask `(X|Y) ≥ (X^Y)` MBA form, consecutive-product parity, and square non-negativity. It isn't a general SMT-backed simplifier; the parameterized affine-MBA form is detected structurally by the decoy-family pass rather than folded (folding it soundly is hard, so REE quarantines the clones instead).
- **Decoy-family clustering is conservative**: it quarantines only large structural-clone families and never an entry point or the whole artifact, so it errs toward keeping code. Webpack bundles whose decoys live *inside* module closures aren't yet split to sub-function granularity (roadmap).
- **Identifier-based JS references over-approximate**: a property named like a top-level function keeps that function alive. This errs toward keeping code.
- **String decryption**: XOR/keystream decoders are flagged, not executed.
- **Dynamic defenses** (runtime entanglement, environment checks) are out of scope for a static analyzer.

## Development

```bash
npm run typecheck
npm test            # node:test via tsx
npm run build
npm run bench
```

## License

[MIT](LICENSE)
