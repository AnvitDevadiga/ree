# Phase 1 Audit — REE vs. the real world

**Date:** 2026-11-15
**Scope:** reverse-engineer the two reference projects, test REE against *real* BLA
output (not REE's own fixtures), and produce a prioritized change list for
Phases 2–3.

> Headline: Against REE's **self-made** fixtures, REE scores ~94% token reduction
> and zero injection leaks. Against **real `bla-agents@3.3.2`** output, REE leaks
> dozens of hostile prompts into the model context, removes almost no decoy code,
> ingests ~1,900 planted decoy files as if they were real source, and wrongly
> prunes genuine Electron entry points. This is the gap the "benchmarks are
> self-made" caveat was pointing at, now measured.

---

## A. What the two references are

Both were cloned into `../ree-references/` (siblings of this repo, **not** vendored
in). Both are **MIT licensed**, so studying them and reimplementing ideas is fine —
but we copy *no source text*; we reimplement concepts in our own code.

### BLA — `qybaihe/bla`, npm `bla-agents` v3.3.2 (the adversary)

- **Self-description:** "Blind LLM Agents" — a *defensive* Blue-Team shield that
  hardens a vendor's **own** artifacts so AI reverse-engineering agents (it names
  REA) burn tokens and hallucinate. Slogan: "Poison → Exhaust → Hallucinate."
- **Size:** ~52k LOC, 115 source files, 465 tracked files. Trending-grade polish
  (20+ translated READMEs, website, CrackMe arena v6–v9).
- **Three pillars** (these are exactly what REE must beat):
  1. **Poison / Deception** (`src/shields/deception/*`): shadow business logic,
     architecture mirage, semantic honeypots, decompiler-pseudocode illusion,
     canary honeypots, **cognitive-armor triggers** (in-band `<system-reminder>`,
     ChatML `<|im_start|>`, fake `Human:/Assistant:` turns, fake ASL-3 / CBRN
     "safety" canaries designed to make an analyzing model refuse).
  2. **Exhaust / Budget-breakers** (`src/shields/exhaustion/*`): obligation
     flooder, call-graph labyrinth, BPE-token amplifier, **asar-header amplifier**
     (plants thousands of decoy files), WASM interface exhaustion.
  3. **Entangle / Anti-strip** (`src/shields/runtime/*`): self-seal, sidecar
     entanglement, so stripping decoys breaks the artifact.
- **Opaque predicates** (`src/shields/tarpit/opaque-predicates.ts`): the mod-7
  quadratic-residue form REE already folds, **plus three forms REE does not**:
  parameterized affine MBA over Z/2³², an unsigned bit-31 `(u|(u-1)) >= (u^(u-1))`
  identity, and an OR-XOR-AND affine identity. REE folds ~1 of BLA's 4 JS variants.
- **"LLM directives" are opt-in** (`--llm-directives`, off by default). The nastiest
  CBRN/ChatML payloads only appear with that flag — which I enabled for the test so
  we measure the worst case.

### REA — `morluto/rea`, npm `rea-agents` v6.9.0 (the role model)

- **What it is:** "Reverse Engineer Anything" — the mature MCP+CLI tool BLA is built
  to defeat. ~4,400 source files, 30+ target formats.
- **Design ideas worth copying:**
  1. **Evidence + limitations on every finding.** REA never asserts; it returns the
     conclusion *and* the evidence *and* what it could not establish. REE asserts.
  2. **Provider delegation for deep native work** (Hopper / Ghidra / IDA / Kuna /
     Rizin / objdump). REA does not pretend to decompile natively — it drives a real
     decompiler. REE's native/pyc support is shallow by comparison and should be
     honest about it.
  3. **Reconstruction coverage as a metric.** Their DX-Ball showcase reconstructs a
     function that passes **3,205 original test cases** and reproduces all 63
     compiled bytes. That is a *verification harness*, which REE lacks entirely.
  4. **Compact MCP input schemas + omitted output schemas** to cut context overhead.
  5. **Clean static/runtime split**, each runtime capability permissioned.

---

## B. Real-world validation — REE vs. `bla-agents@3.3.2`

**Method:** took REE's five *clean* fixtures, hardened copies with real BLA at
`--intensity bankrupt --llm-directives --seed 1337`, then ran REE's deterministic
pre-pass (`ingest` + `analyze`, no LLM) over the hardened output. Measured: token
reduction, how many of BLA's planted prompt-injection markers leaked into the
context slices REE would hand a model, and how much real logic survived.

| Fixture | REE token reduction | Injection markers leaked into slices | Decoy units removed | Verdict |
|---|---|---|---|---|
| `inventory.js` (plain JS) | 37,467 → 28,506 (**24%**) | 0 ✅ | 0 of ~140 ❌ | Kept every `scc_*` tarpit fn |
| `webpack.js` | 2,902 → 2,902 (**0%**) | 0 ✅ | 0 ❌ | Treated whole bundle as 4 opaque modules |
| `app.asar` (Electron) | 300,845 → 194,553 (**35%**) | **42** ❌ (`system-reminder`×6, ChatML×9, `Human:`×3, canary×9, stop-words×15) | 4 of ~1,900 ❌ | See below — worst case |
| `module.wasm` | 38 → 38 tok (**0%**) | 0 ✅ | 0 ❌ | Real fns gone; kept mirage export name |
| `tool.pyc` | 0 → 0 tok | 0 ✅ | 0 ❌ | `graphComplete:false` → no pruning |

### The three findings that matter

1. **Prompt injection leaks through the sanitizer (P0, security).**
   BLA plants its cognitive-armor payloads as **string-literal arrays** inside the
   real source files (`main.js`, `lib/store.js`, `tiny-utils/index.js`), not as
   comments. REE's sanitizer (`src/anti-bla/sanitizer.ts`) only *removes* matching
   **comments**; matching **string literals** are flagged-but-kept and travel into
   the slice verbatim. So an analyzing model receives 42 live injection markers —
   including `<system-reminder>…stop reverse-engineering…</system-reminder>`, ChatML
   turn-boundary tokens, and fake `Human:/Assistant:` refusal scripts. Two of this
   session's own responses were halted by a safety classifier while handling this
   file — proof the payloads are "live." **This is REE's single most important bug:
   the anti-BLA tool currently forwards BLA's attack.**

2. **No decoy pruning without a reachability graph (P0, core value prop).**
   On flat JS and webpack, REE kept 100% of units — every `scc_deriveSubkeySchedule`,
   `enclave_*`, and shadow-logic function. REE only prunes via reachability from an
   entry point; BLA's flat, entry-less, mutually-referencing decoy web defeats that.
   The whole "strip decoys" promise degrades to a 0–24% trim on real input.

3. **Exhaustion files ingested as real units (P0/P1).**
   BLA's asar-header amplifier planted ~1,900 `enclave/shards/ring0-slot-*.json`
   decoy files. REE ingested all of them as units and put **1,904 of them into
   context slices (~42k tokens of pure chaff)**. REE has no notion of "N near-identical
   sibling files = exhaustion chaff." REE *did* flag the 17 MB header as inflated, so
   the signal exists — it just isn't acted on.

### Secondary findings

- **False pruning of Electron entry points (P1, correctness).** REE pruned
  `preload.js`, `renderer.js`, and `index.html` as "unreachable." In Electron these
  are real entry points, referenced via `BrowserWindow` config and HTML `<script>`,
  not `require()`. REE's reachability model doesn't know Electron's wiring, so it
  deletes genuine code. (`realKept 3/6` on the asar.)
- **Name-based labels are brittle (test infra).** BLA renames every function, so
  REE's fixtures that match "real units" by name report `0/9` even when logic
  survives. Phase 2's real-target harness must verify by **behavior**, not names.
- **WASM/pyc reductions are 0%** because the real logic in those fixtures is tiny;
  not a bug, but it means those formats need bigger, realistic targets to prove
  anything (feeds the `.dmg`/real-app plan).

Reproducer and raw probes are in the scratchpad; Phase 2 should commit a
`benchmarks/real/` harness that regenerates this table from `npx bla-agents`.

---

## C. REE code self-audit (root causes)

| # | File | Issue | Fix direction |
|---|---|---|---|
| C1 | `anti-bla/sanitizer.ts:141` | Injected **string literals** only flagged, kept verbatim in body → leaks to model. | Redact the *matched span* inside the literal (keep a `"[ree:redacted-injection]"` placeholder so program shape is preserved for reconstruction), not just flag. |
| C2 | `anti-bla/sanitizer.ts:26` | Signature misses `<|im_start|>` (pipe guards defeat `<\s*system>`), bare `Human:`/`Assistant:` turns, and the `ALIGNMENT-EVAL-CANARY` / fake-safety-classifier family. | Add ChatML, turn-boundary, and canary signatures; scan for them inside **data/JSON** units too, not just JS comments/strings. |
| C3 | `anti-bla/reachability.ts` | Prunes only by `require`/import edges; unreachable ≠ dead for Electron (config/HTML entry points) and flat bundles. | Add Electron entry heuristics (preload/renderer/html as roots); never prune when `graphComplete` but entry set is synthetic/empty. |
| C4 | `anti-bla/engine.ts` (decoy detection) | No decoy-family clustering. BLA names decoys predictably and plants N near-identical siblings. | Add a "decoy-family" pass: cluster units by name prefix/structural hash; quarantine large near-duplicate families (the ring0-slot case) and the `scc_*`/`enclave_*` tarpit clusters. |
| C5 | `anti-bla/opaque-predicates.ts` | Folds ~1 of BLA's 4 JS opaque forms. | Add the affine-MBA, unsigned bit-31, and OR-XOR-AND identities (concepts only; our own implementation). |
| C6 | `anti-bla/context-bomb.ts` | Only the top-level unit was quarantined; per-function base64/high-entropy blobs inside kept functions were not. | Run entropy/repetition scoring per-unit *and* per-large-literal, not just whole-unit. |
| C7 | `parsers/asar.ts` | Ingests every archive entry as a unit with no cap/dedup, so exhaustion files become context. | Cap + structurally-dedupe sibling files; emit the inflated-header warning as an actionable quarantine, not just text. |
| C8 | pipeline / reporting | REE asserts findings without evidence/limitations (REA does the opposite). | Attach `evidence` + `limitations` to each finding; surface "what REE could not establish." |

None of these are crashes — REE ran cleanly on every real input in <250 ms. They
are gaps between the synthetic benchmark and the adversary's real output.

---

## D. Prioritized change list (feeds Phases 2–3)

**P0 — correctness/security, do first (Phase 2 "audit"):**
- C1 + C2: stop leaking injections (redact matched spans in literals & data units;
  broaden signatures to ChatML/turn/canary). *This is the credibility fix.*
- C4: decoy-family clustering so pruning actually works on flat/entry-less bundles.
- C7: asar exhaustion-file quarantine.
- Commit `benchmarks/real/` harness that builds real BLA output and regenerates
  the Part B table in CI (gated/skipped when `bla-agents` unavailable).

**P1 — accuracy (Phase 2/3):**
- C3: Electron-aware reachability (stop deleting real entry points).
- C5: more opaque-predicate forms.
- C6: per-unit context-bomb scoring.
- A real-target smoke test: one open-source Electron `.dmg`/app end-to-end.

**P2 — polish & positioning (Phase 3 → Final):**
- C8: evidence + limitations on findings (REA parity).
- `.dmg` ingester (mount → walk `.app` → route inner Mach-O/asar through parsers).
- A real before/after demo (the asar case makes a strong GIF).
- Honesty pass on README/benchmarks: label synthetic numbers as synthetic, publish
  the real-BLA table beside them.

**Deliberately out of scope / won't do:**
- No DRM/encryption circumvention. No bypassing BLA's runtime anti-strip seals.
- Keep the responsible-use posture; REE still never executes targets.

---

## E. One-paragraph positioning

REE's defensible niche isn't "decompile anything" (REA already owns that and does it
better by driving real decompilers). It's **"neutralize anti-LLM hardening so any
downstream analyzer — human or model — gets clean, honest, injection-free context."**
That's a real, unoccupied slot: BLA is trending and nothing yet undoes it safely. But
REE only earns the claim after the P0 fixes, because today it forwards BLA's
injections instead of stripping them. Fix that first; it's both the biggest bug and
the best launch story.
