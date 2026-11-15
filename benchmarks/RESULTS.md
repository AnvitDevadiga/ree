# Counter-BLA benchmark results

Generated 2026-11-15T12:27:44.078Z by `npm run bench`. Token counts are REE's deterministic estimate, not a model tokenizer.
Hardened fixtures are produced by REE's own simulator of BLA's documented techniques, not by bla-agents.

| fixture | variant | format | naive tokens | REE tokens | reduction | real recall | decoys removed | exhaust contained | injection leaks |
|---|---|---|---:|---:|---:|---:|---:|---:|---:|
| inventory-cli | clean | js-bundle | 563 | 563 | 0% | 9/9 | n/a | n/a | 0 |
| inventory-cli | hardened | js-bundle | 12648 | 730 | 94.2% | 9/9 | 12/12 | 2/2 | 0 |
| webpack-bundle | clean | js-bundle | 365 | 264 | 27.7% | 4/4 | n/a | n/a | 0 |
| electron-app | clean | asar | 406 | 406 | 0% | 6/6 | n/a | n/a | 0 |
| wasm-module | clean | wasm | 38 | 38 | 0% | 3/3 | n/a | n/a | 0 |
| webpack-bundle | hardened | js-bundle | 994 | 289 | 70.9% | 4/4 | 6/6 | n/a | 0 |
| electron-app | hardened | asar | 561 | 414 | 26.2% | 6/6 | 3/3 | n/a | 0 |
| wasm-module | hardened | wasm | 1394 | 38 | 97.3% | 3/3 | 3/3 | n/a | 0 |

**pyc (structure only):** 8 code objects recovered from `tool.pyc` (Python 3.14+); 6 with parameter names. Pruning is disabled for pyc because REE does not yet recover a bytecode call graph.
**native (structure only):** `/bin/ls` parsed as macho: 1 function symbols, 90 imports, 289 strings. No call graph, so nothing is pruned.