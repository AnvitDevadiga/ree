import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { callables, definedNames, probePasses } from "../benchmarks/reconstruct/score.js";
import { FIXTURES } from "../benchmarks/reconstruct/run.js";

const cache = join(import.meta.dirname, "..", "benchmarks", "reconstruct", ".cache");

test("score: definedNames finds JS, arrow, and Python definitions", () => {
  const n = definedNames("function a(){}\nconst b = (x) => x;\nlet c = async function(){}\ndef d(x):\n  pass");
  assert.deepEqual([...n].sort(), ["a", "b", "c", "d"]);
});

test("score: a wrong reconstruction fails its probes", () => {
  const fns = [...callables("function escapeHtml(s){ return s; }").values()];
  const probe = FIXTURES.find((f) => f.name.startsWith("escape-html"))!.probes[0]!;
  assert.ok(!fns.some((f) => probePasses(f, probe)));
});

test("score: a runaway reconstruction is cut off by the timeout", () => {
  const fns = [...callables("function spin(){ for(;;){} }").values()];
  assert.equal(probePasses(fns[0]!, { label: "x", cases: [{ args: [], expect: 1 }] }), false);
});

// Oracle check: the real original sources, used as if they were the
// reconstruction, must pass every probe. Proves the scorer isn't the bottleneck.
test("score: the original sources pass every probe (oracle)", { skip: !existsSync(join(cache, "ms")) && "fixture cache not fetched; run bench:reconstruct once" }, () => {
  const oracle: Record<string, string[]> = {
    ms: [readFileSync(join(cache, "ms", "index.js"), "utf8")],
    "escape-html + dlv (minified)": [
      readFileSync(join(cache, "escape-html", "index.js"), "utf8"),
      readFileSync(join(cache, "dlv", "index.js"), "utf8"),
    ],
  };
  for (const fx of FIXTURES.filter((f) => oracle[f.name])) {
    const fns = oracle[fx.name]!.flatMap((s) => [...callables(s).values()]);
    for (const probe of fx.probes) {
      assert.ok(fns.some((f) => probePasses(f, probe)), `${fx.name}: oracle failed probe ${probe.label}`);
    }
    const names = new Set(oracle[fx.name]!.flatMap((s) => [...definedNames(s)]));
    for (const n of fx.truthFunctions) assert.ok(names.has(n), `${fx.name}: oracle missing name ${n}`);
  }
});

test("score: functions exposed on a bundle's global object count (var lib = IIFE)", () => {
  const src = `var lib = (function () {
    function escapeHtml(s) { return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]); }
    function dlv(o, k, d, i) { k = k.split ? k.split(".") : k; for (i = 0; i < k.length; i++) o = o ? o[k[i]] : undefined; return o === undefined ? d : o; }
    var out = {}; Object.defineProperty(out, "escapeHtml", { get: () => escapeHtml, enumerable: true }); out.dlv = dlv; return out;
  })();`;
  const fns = [...callables(src).values()];
  const fx = FIXTURES.find((f) => f.name.startsWith("escape-html"))!;
  for (const probe of fx.probes) assert.ok(fns.some((f) => probePasses(f, probe)), probe.label);
});
