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
