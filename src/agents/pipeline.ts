/**
 * Autonomous reconstruction pipeline: ties the three agents together.
 *
 *   ingest -> runAntiBla -> toContextSlices
 *                      |
 *                      v
 *   TriageAgent (plan) -> SynthesisAgent (per slice) -> VerificationAgent
 *                                   ^                          |
 *                                   |   reject + escalate      |
 *                                   +--------------------------+
 *
 * On a rejected verdict the pipeline retries once, escalating the slice to the
 * deep model tier with the verifier's feedback. Everything the agents see has
 * already passed the deterministic anti-BLA pre-pass.
 */
import type { AntiBlaReport, ContextSlice } from "../core/types.js";
import { toContextSlices } from "../anti-bla/engine.js";
import type { LlmClient } from "./llm.js";
import { TriageAgent, type TriagePlan } from "./triage.js";
import { SynthesisAgent, type ReconstructedUnit } from "./synthesis.js";
import { VerificationAgent, type Verdict } from "./verification.js";
import { DEFAULT_PACK_TOKENS, packSlices } from "./packing.js";

export interface PipelineOptions {
  tokenBudget?: number;
  maxUnits?: number;
  verify?: boolean;
  maxRetries?: number;
  /**
   * Pack adjacent units from the same file into one reconstruction call up to
   * this many tokens (0 disables packing). Default 4000.
   */
  packTokens?: number;
  onProgress?: (msg: string) => void;
}

export interface ReconstructionResult {
  plan: TriagePlan;
  units: Array<{ recon: ReconstructedUnit; verdict?: Verdict }>;
  stats: { attempted: number; accepted: number; escalated: number };
}

export class ReconstructionPipeline {
  private readonly triage: TriageAgent;
  private readonly synth: SynthesisAgent;
  private readonly verifier: VerificationAgent;

  constructor(private readonly llm: LlmClient) {
    this.triage = new TriageAgent(llm);
    this.synth = new SynthesisAgent(llm);
    this.verifier = new VerificationAgent(llm);
  }

  async run(report: AntiBlaReport, opts: PipelineOptions = {}): Promise<ReconstructionResult> {
    const o = { tokenBudget: 60000, maxUnits: 40, verify: true, maxRetries: 1, ...opts };
    const log = o.onProgress ?? (() => {});

    log("triage: mapping boundaries and entry points");
    const plan = await this.triage.run(report);

    const raw = toContextSlices(report.model, o.tokenBudget);
    const packTokens = opts.packTokens ?? DEFAULT_PACK_TOKENS;
    const slices = (packTokens > 0 ? packSlices(raw, report.model, packTokens) : raw).slice(0, o.maxUnits);
    const sliceById = new Map(slices.map((s) => [s.unitId, s] as const));
    // A pack is keyed by its first member; map every member to its pack.
    const packOf = new Map<string, string>();
    for (const s of slices) for (const m of (s as { memberIds?: string[] }).memberIds ?? [s.unitId]) packOf.set(m, s.unitId);

    // Reconstruct in the plan's order (first appearance of any member), then any
    // packs the plan didn't mention, so every budgeted unit is covered once.
    const order: string[] = [];
    const seen = new Set<string>();
    for (const id of [...plan.reconstructionOrder, ...slices.map((s) => s.unitId)]) {
      const p = packOf.get(id);
      if (p && sliceById.has(p) && !seen.has(p)) {
        seen.add(p);
        order.push(p);
      }
    }
    const units: ReconstructionResult["units"] = [];
    let accepted = 0;
    let escalated = 0;

    for (const id of order) {
      const slice = sliceById.get(id)!;
      log(`synthesize: ${slice.name}`);
      let recon = await this.synth.reconstruct(slice, report.model);
      let verdict: Verdict | undefined;

      if (o.verify) {
        verdict = await this.verifier.verify(recon, slice, report.model);
        let retries = 0;
        while (verdict && verdict.explicit && !verdict.accepted && retries < o.maxRetries) {
          retries++;
          escalated++;
          log(`verify rejected ${slice.name}; escalating to deep tier (retry ${retries})`);
          recon = await this.synth.reconstruct(slice, report.model, {
            escalate: true,
            previousAttempt: recon.source,
            verifierFeedback: verdict.rationale,
          });
          verdict = await this.verifier.verify(recon, slice, report.model);
        }
        if (verdict?.accepted) accepted++;
      }

      units.push({ recon, verdict });
    }

    return { plan, units, stats: { attempted: units.length, accepted, escalated } };
  }
}

export type { ContextSlice };
