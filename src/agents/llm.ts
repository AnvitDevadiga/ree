/**
 * Pluggable LLM client for the reconstruction agents.
 *
 * Default implementation targets the Anthropic API via the official SDK. REE
 * runs a two-tier model strategy and *shifts between tiers per task*:
 *   - WORKHORSE — triage, module-by-module synthesis, tests;
 *   - DEEP      — the hardest reconstructions (dense native pseudocode, heavily
 *                 obfuscated units, verifier-rejected retries) where the extra
 *                 capability pays off.
 * The pipeline asks for a tier and the client maps it to a model id; callers can
 * also force an escalation (e.g. after a verification failure).
 *
 * Nothing here is called during parsing or the anti-BLA pre-pass — only after a
 * cleaned, budget-bounded context slice has been produced.
 */
import Anthropic from "@anthropic-ai/sdk";

export type ModelTier = "workhorse" | "deep";

/** Defaults; override with REE_MODEL_WORKHORSE / REE_MODEL_DEEP. */
export const TIER_MODELS: Record<ModelTier, string> = {
  workhorse: process.env.REE_MODEL_WORKHORSE || "claude-opus-5-5",
  deep: process.env.REE_MODEL_DEEP || "claude-fable-5-2",
};

export interface LlmRequest {
  system: string;
  prompt: string;
  tier?: ModelTier;
  /** Effort maps to output_config.effort; high is the default for synthesis. */
  effort?: "low" | "medium" | "high" | "xhigh" | "max";
  maxTokens?: number;
}

export interface LlmResponse {
  text: string;
  model: string;
  stopReason: string | null;
  usage?: { inputTokens: number; outputTokens: number };
}

export interface LlmClient {
  complete(req: LlmRequest): Promise<LlmResponse>;
}

/**
 * Anthropic-backed client. Uses adaptive thinking, streams (so large
 * reconstructions don't hit HTTP timeouts), and enables server-side refusal
 * fallbacks by default so a declined request degrades gracefully instead of
 * throwing.
 */
export class AnthropicClient implements LlmClient {
  private readonly client: Anthropic;

  constructor(opts: { apiKey?: string; client?: Anthropic } = {}) {
    this.client = opts.client ?? new Anthropic(opts.apiKey ? { apiKey: opts.apiKey } : {});
  }

  async complete(req: LlmRequest): Promise<LlmResponse> {
    const model = TIER_MODELS[req.tier ?? "workhorse"];
    const maxTokens = req.maxTokens ?? 32000;

    const stream = this.client.beta.messages.stream({
      model,
      max_tokens: maxTokens,
      thinking: { type: "adaptive" },
      output_config: { effort: req.effort ?? "high" },
      // Server-side refusal fallback: route by category, no model list to maintain.
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      system: req.system,
      messages: [{ role: "user", content: req.prompt }],
    });

    const message = await stream.finalMessage();
    if (message.stop_reason === "refusal") {
      return { text: "", model: message.model, stopReason: "refusal" };
    }
    const text = message.content
      .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text")
      .map((b) => b.text)
      .join("");

    return {
      text,
      model: message.model,
      stopReason: message.stop_reason,
      usage: message.usage
        ? { inputTokens: message.usage.input_tokens, outputTokens: message.usage.output_tokens }
        : undefined,
    };
  }
}

/**
 * Offline/dry-run client: deterministic, never hits the network. Used by the CLI
 * `--dry-run` flag, tests, and CI benchmarks so the deterministic pipeline can be
 * exercised without API credentials. It echoes a structured stub that documents
 * exactly which slice would have been sent and under which tier.
 */
export class DryRunClient implements LlmClient {
  async complete(req: LlmRequest): Promise<LlmResponse> {
    const model = TIER_MODELS[req.tier ?? "workhorse"];
    return {
      text:
        `// [REE dry-run — no model call made]\n` +
        `// tier=${req.tier ?? "workhorse"} model=${model} effort=${req.effort ?? "high"}\n` +
        `// system: ${req.system.slice(0, 80).replace(/\n/g, " ")}\n` +
        `// The real pipeline would send the cleaned context slice below:\n` +
        req.prompt.slice(0, 1200),
      model: `${model} (dry-run)`,
      stopReason: "end_turn",
    };
  }
}
