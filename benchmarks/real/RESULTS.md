# Real-adversary benchmark — REE vs. genuine bla-agents

Generated 2026-11-23T08:52:55.925Z by `npm run bench:real` against **real `bla-agents@3.3.2`** output
(`--intensity bankrupt --llm-directives`). Token counts are REE's deterministic estimate, not a model tokenizer.

**Injection leaks must be 0** — any BLA prompt-injection marker reaching a context slice is a regression.

| fixture | format | naive tokens | REE tokens | reduction | decoy-family units | injection leaks |
|---|---|---:|---:|---:|---:|---:|
| inventory-cli | js-bundle | 37442 | 21832 | 41.7% | 94 | 0 |
| webpack-bundle | js-bundle | 35521 | 19919 | 43.9% | 94 | 0 |
| electron-app | asar | 301053 | 59997 | 80.1% | 4560 | 0 |
| wasm-module | wasm | 38 | 38 | 0% | 0 | 0 |
| python-pyc | pyc | 0 | 725 | 0% | 0 | 0 |
