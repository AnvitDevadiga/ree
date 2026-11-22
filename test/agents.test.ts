import { test } from "node:test";
import assert from "node:assert/strict";
import { analyze } from "../src/core/analyze.js";
import { ReconstructionPipeline } from "../src/agents/pipeline.js";
import type { LlmClient, LlmRequest, LlmResponse } from "../src/agents/llm.js";
import { fixture } from "./helpers.js";

/** Scripted LLM: verifier replies come from `verdicts` in order; everything else echoes. */
class StubLlm implements LlmClient {
  readonly calls: LlmRequest[] = [];
  constructor(private readonly verdicts: string[]) {}
  async complete(req: LlmRequest): Promise<LlmResponse> {
    this.calls.push(req);
    const isVerifier = req.system.includes("verification agent");
    const text = isVerifier ? (this.verdicts.shift() ?? "") : "```js\nfunction reconstructed() {}\n```\n// notes: stub";
    return { text, model: `stub-${req.tier ?? "workhorse"}`, stopReason: "end_turn" };
  }
}

async function runPipeline(verdicts: string[]) {
  const { report } = await analyze(fixture("inventory-cli", "clean").path);
  const llm = new StubLlm(verdicts);
  const result = await new ReconstructionPipeline(llm).run(report, { maxUnits: 1 });
  return { llm, result };
}

test("pipeline: an explicit reject escalates once to the deep tier", async () => {
  const { llm, result } = await runPipeline([
    "harness...\nVERDICT: reject confidence=high — loop bound is off by one",
    "harness...\nVERDICT: accept confidence=medium — matches anchors",
  ]);
  assert.equal(result.stats.escalated, 1);
  assert.equal(result.stats.accepted, 1);
  const synthTiers = llm.calls.filter((c) => c.system.includes("synthesis agent")).map((c) => c.tier);
  assert.deepEqual(synthTiers, ["workhorse", "deep"]);
  const retryPrompt = llm.calls.filter((c) => c.system.includes("synthesis agent"))[1]!.prompt;
  assert.match(retryPrompt, /loop bound is off by one/);
});

test("pipeline: a missing verdict is unverified, not a rejection", async () => {
  const { llm, result } = await runPipeline(["here is a harness but no verdict line"]);
  assert.equal(result.stats.escalated, 0);
  assert.equal(result.units[0]!.verdict!.explicit, false);
  assert.equal(llm.calls.filter((c) => c.tier === "deep").length, 0);
});

test("pipeline: synthesis output is unfenced and notes are split off", async () => {
  const { result } = await runPipeline(["VERDICT: accept confidence=high — ok"]);
  assert.equal(result.units[0]!.recon.source, "function reconstructed() {}");
  assert.equal(result.units[0]!.recon.notes, "stub");
});

test("verifier: verdicts wrapped in Markdown are still parsed (seen from gpt-oss-120b)", async () => {
  const { parseVerdict } = await import("../src/agents/verification.js");
  const cases: Array<[string, boolean, string]> = [
    ["harness...\n\n**VERDICT:** accept confidence=high — matches all anchors", true, "high"],
    ["### VERDICT: reject confidence=medium - fmtLong differs", false, "medium"],
    ["`VERDICT: accept confidence=low`", true, "low"],
    ["> VERDICT: Reject confidence: high — wrong rounding", false, "high"],
    ["VERDICT: accept confidence=high — plain form still works", true, "high"],
  ];
  for (const [text, accepted, conf] of cases) {
    const v = parseVerdict("u", text);
    assert.equal(v.explicit, true, text);
    assert.equal(v.accepted, accepted, text);
    assert.equal(v.confidence, conf, text);
  }
  assert.equal(parseVerdict("u", "no decision here").explicit, false);
  // A malformed decision is not silently treated as a reject.
  assert.equal(parseVerdict("u", "**VERDICT:** maybe").explicit, false);
  assert.match(parseVerdict("u", "**VERDICT:** accept — ok").rationale, /^ok$/);
});

test("synthesis: fences are stripped even when the notes trailer sits inside the fence", async () => {
  const { stripFences } = await import("../src/agents/synthesis.js");
  // Unclosed fence: what remains after splitting at an in-fence `// notes:` trailer.
  assert.equal(stripFences("```js\nfunction f() {}\n"), "function f() {}");
  assert.equal(stripFences("```typescript\nconst a = 1;"), "const a = 1;");
  // Closed fence with prose around it.
  assert.equal(stripFences("Here you go:\n```js\nfunction g() {}\n```\nDone."), "function g() {}");
  // No fence at all.
  assert.equal(stripFences("function h() {}"), "function h() {}");
  // End-to-end through the agent: notes inside the fence.
  const { SynthesisAgent } = await import("../src/agents/synthesis.js");
  const llm = { async complete() { return { text: "```js\nfunction k() { return 1; }\n// notes: ok\n```", model: "m", stopReason: "end_turn" }; } };
  const r = await new SynthesisAgent(llm as any).reconstruct(
    { unitId: "u", name: "k", content: "x", neighbors: [], estTokens: 1 },
    { format: "js-bundle", sourcePath: "", byteLength: 0, units: [], strings: [], entryPoints: [], warnings: [], meta: {} },
  );
  assert.equal(r.source, "function k() { return 1; }");
  assert.equal(r.notes.replace(/`/g, "").trim(), "ok");
});
