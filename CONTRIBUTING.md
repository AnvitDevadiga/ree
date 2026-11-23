# Contributing to REE

Thanks for helping. REE is small on purpose, so most contributions fall into one of three kinds.

## The most useful contribution: a technique REE misses

If hardened output gets past REE — a decoy survives, an injection reaches a context slice, real code gets pruned — open an issue with:

- the artifact format and how it was hardened (tool, version, flags);
- a **minimal sample you own or generated yourself** (never a third-party product);
- what `ree analyze <file> --json` reported, and what you expected.

A failing test is even better. Injection leaks are treated as bugs, not feature requests.

## Development

```bash
npm install
npm run typecheck
npm test                # node:test via tsx
npm run bench           # synthetic fixtures, offline
npm run bench:real      # real bla-agents; needs network, exits non-zero on any leak
```

Node 22 or newer. CI runs the suite on macOS, Linux and Windows (Node 22 and 24), plus the real-adversary gate, the protection gates (`npm run bench:obfuscation`) and the packaging smoke test (`npm run smoke:pack`).

Optional decompilers (jadx, Vineflower, ilspycmd, Ghidra, pycdc, uncompyle6) are never required; tests that need one skip when it is missing. `npx tsx src/cli/index.ts doctor` shows what you have. A new tool integration must have a license compatible with MIT, recorded in `THIRD_PARTY_NOTICES.md`, run as a separate process with a timeout, and pass its output through the sanitizer.

## Ground rules for changes

- **Never delete real code.** A pass may remove a unit only when it can justify it; when unsure, keep the unit and report a limitation. Add a test proving real units survive.
- **Folds must be sound.** An opaque-predicate identity needs a proof or an exhaustive check in the test, not a plausible-looking pattern.
- **Stay static.** REE never executes a target. Don't add a code path that runs, evaluates, or loads artifact content.
- **Bound everything.** Parsers take size, depth, and entry caps; new ones must too.
- **Report what you did.** Every removal or redaction emits a finding.

## Pull requests

Keep them focused, describe what changed and why, and include tests. Run `npm run typecheck && npm test && npm run bench:real` before pushing.

## Scope

REE is for authorized analysis: security research, malware analysis, interoperability, auditing your own software, and CTFs. Contributions aimed at circumventing DRM, license enforcement, or encryption are out of scope.
