/**
 * Behavioral Verification agent.
 *
 * Generates a differential test harness that exercises the reconstructed unit and
 * compares its observable behavior against evidence from the original artifact
 * (extracted strings, constants, exported signatures). It does NOT run untrusted
 * target code; it produces a test file plus a structured verdict the pipeline
 * uses to decide whether to accept a reconstruction or escalate a retry.
 */
import type { ArtifactModel, ContextSlice } from "../core/types.js";
import type { LlmClient } from "./llm.js";
import type { ReconstructedUnit } from "./synthesis.js";

export interface Verdict {
  unitId: string;
  accepted: boolean;
  /** False when the model gave no VERDICT line; callers must not treat that as a rejection. */
  explicit: boolean;
  confidence: "low" | "medium" | "high";
  testHarness: string;
  rationale: string;
}

const SYSTEM = `You are REE's verification agent for authorized reverse-engineering.
Given a reconstructed unit and evidence from the original artifact, produce a differential
test harness (idiomatic for the language) that would distinguish a correct reconstruction
from a wrong one, then judge whether the reconstruction is behaviorally faithful. Do not
execute target code. End your response with a single line:
VERDICT: <accept|reject> confidence=<low|medium|high> — <one-sentence reason>`;

export class VerificationAgent {
  constructor(private readonly llm: LlmClient) {}

  async verify(recon: ReconstructedUnit, slice: ContextSlice, model: ArtifactModel): Promise<Verdict> {
    const evidence = gatherEvidence(slice, model);
    const prompt = [
      `Artifact format: ${model.format}. Unit: ${recon.name}.`,
      ``,
      `Reconstructed source:`,
      "```",
      recon.source.slice(0, 8000),
      "```",
      ``,
      `Evidence from the original (behavioral anchors):`,
      evidence,
      ``,
      `Write the differential test harness, then give your VERDICT line.`,
    ].join("\n");

    const res = await this.llm.complete({ system: SYSTEM, prompt, tier: "workhorse", effort: "high", maxTokens: 16000 });
    return parseVerdict(recon.unitId, res.text);
  }
}

function gatherEvidence(slice: ContextSlice, model: ArtifactModel): string {
  const unitStrings = model.strings.filter((s) => s.unitId === slice.unitId).slice(0, 20).map((s) => `  "${s.value}"`);
  const neighbors = slice.neighbors.slice(0, 15).join(", ");
  return [
    `- referenced neighbors: ${neighbors || "(none)"}`,
    `- literal strings/anchors:`,
    ...(unitStrings.length ? unitStrings : ["  (none recovered)"]),
  ].join("\n");
}

/**
 * Strip Markdown decoration models commonly wrap a verdict line in
 * (`**VERDICT:** accept`, `### VERDICT: reject`, `> VERDICT:`, `` `VERDICT: accept` ``).
 */
function plainLine(l: string): string {
  return l.replace(/[*_`]/g, "").replace(/^\s*(?:#{1,6}|>|[-+]\s)\s*/, "").trim();
}

export function parseVerdict(unitId: string, text: string): Verdict {
  const raw = text.split("\n").reverse().find((l) => /^VERDICT\s*:/i.test(plainLine(l))) ?? "";
  if (!raw) {
    return { unitId, accepted: false, explicit: false, confidence: "low", testHarness: text.trim(), rationale: "no verdict returned" };
  }
  const line = plainLine(raw);
  const decision = /^VERDICT\s*:\s*(accept|reject)\b/i.exec(line)?.[1]?.toLowerCase();
  if (!decision) {
    return { unitId, accepted: false, explicit: false, confidence: "low", testHarness: text.trim(), rationale: `unparseable verdict: ${line.slice(0, 120)}` };
  }
  const conf = /confidence\s*[=:]\s*(low|medium|high)/i.exec(line)?.[1]?.toLowerCase() as Verdict["confidence"] | undefined;
  const rationale = line.replace(/^VERDICT\s*:.*?(—|–|-{1,2})\s*/i, "").trim() || "no rationale given";
  const harness = text.slice(0, text.lastIndexOf(raw)).trim();
  return { unitId, accepted: decision === "accept", explicit: true, confidence: conf ?? "low", testHarness: harness, rationale };
}
