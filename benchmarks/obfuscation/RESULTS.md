# Real-world protection benchmark (JavaScript)

Generated 2026-11-24T07:29:23.309Z by `npm run bench:obfuscation`. Deterministic pass only; no model calls.

| Source | Protection | Size | Parsed | Units | Literals visible | Decoder flagged | Leaks | Tokens (raw → REE) | Gate |
|---|---|---:|:-:|---:|---:|:-:|---:|---|:-:|
| inventory-cli | none | 1976 | ✅ | 8 | 9/9 | — | 0 | 597 → 641 | ✅ |
| inventory-cli | terser | 1225 | ✅ | 9 | 9/9 | yes | 0 | 535 → 595 | ✅ |
| inventory-cli | obf-low | 2179 | ✅ | 8 | 9/9 | — | 0 | 618 → 659 | ✅ |
| inventory-cli | obf-medium | 5401 | ✅ | 10 | 9/9 | yes | 0 | 1479 → 1523 | ✅ |
| inventory-cli | obf-high | 11020 | ✅ | 10 | 2/9 | yes | 0 | 2983 → 2981 | ✅ |
| ms@2.1.3 | none | 3160 | ✅ | 4 | 20/20 | — | 0 | 1056 → 1197 | ✅ |
| ms@2.1.3 | terser | 1433 | ✅ | 5 | 20/20 | — | 0 | 688 → 746 | ✅ |
| ms@2.1.3 | obf-low | 2336 | ✅ | 4 | 20/20 | — | 0 | 762 → 801 | ✅ |
| ms@2.1.3 | obf-medium | 7745 | ✅ | 6 | 20/20 | yes | 0 | 2215 → 2256 | ✅ |
| ms@2.1.3 | obf-high | 21493 | ✅ | 6 | 17/20 | yes | 0 | 6141 → 6134 | ✅ |
| inventory-cli (jvm) | none (jar) [vineflower] | 3184 | ✅ | 2 | 2/2 · names 5/5 | — | 0 | 0 → 574 | ✅ |
| inventory-cli (jvm) | r8-classfile [vineflower] | 2390 | ✅ | 3 | 2/2 · names 2/5 | — | 0 | 0 → 550 | ✅ |
| inventory-cli (jvm) | r8-dex (apk) [jadx] | 1654 | ✅ | 3 | 2/2 · names 2/5 | — | 0 | 0 → 481 | ✅ |
