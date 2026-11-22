/**
 * Provider selection, local OpenAI-compatible models, and a hard spending cap.
 *
 * REE picks a backend from the environment:
 *
 *   REE_PROVIDER = anthropic | openai-compatible | none   (optional override)
 *
 *   anthropic          ANTHROPIC_API_KEY (or the SDK's credential chain)
 *   openai-compatible  REE_OPENAI_BASE_URL   e.g. http://localhost:11434/v1 (Ollama)
 *                                             or   http://localhost:1234/v1  (LM Studio)
 *                      REE_OPENAI_API_KEY    optional bearer token
 *                      REE_MODEL_WORKHORSE / REE_MODEL_DEEP  model names (required)
 *   none               deterministic-only mode: no model is ever called
 *
 * With nothing configured REE runs in deterministic-only mode and says so.
 *
 * Paid providers are always wrapped in a BudgetedClient. A paid call is refused
 * unless REE_MAX_SPEND_USD and per-token prices are set, and a call is refused
 * *before* it is sent if its worst-case cost could cross the cap.
 */
import { estimateTokens } from "../core/tokens.js";
import { AnthropicClient, type LlmClient, type LlmRequest, type LlmResponse, type ModelTier } from "./llm.js";

export type ProviderKind = "anthropic" | "openai-compatible" | "none";

export class SpendCapError extends Error {}
export class ProviderConfigError extends Error {}

// ---------------------------------------------------------------------------
// OpenAI-compatible client (Ollama, LM Studio, vLLM, llama.cpp server, ...)
// ---------------------------------------------------------------------------
export interface OpenAICompatOptions {
  baseUrl: string;
  apiKey?: string;
  models: Record<ModelTier, string>;
  timeoutMs?: number;
}

export class OpenAICompatClient implements LlmClient {
  constructor(private readonly o: OpenAICompatOptions) {}

  async complete(req: LlmRequest): Promise<LlmResponse> {
    const model = this.o.models[req.tier ?? "workhorse"];
    const url = this.o.baseUrl.replace(/\/+$/, "") + "/chat/completions";
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.o.timeoutMs ?? 600_000);
    try {
      const res = await fetch(url, {
        method: "POST",
        signal: ctrl.signal,
        headers: {
          "content-type": "application/json",
          ...(this.o.apiKey ? { authorization: `Bearer ${this.o.apiKey}` } : {}),
        },
        body: JSON.stringify({
          model,
          max_tokens: req.maxTokens ?? 8192,
          temperature: 0,
          messages: [
            { role: "system", content: req.system },
            { role: "user", content: req.prompt },
          ],
        }),
      });
      if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
      const j = (await res.json()) as {
        model?: string;
        choices?: Array<{ message?: { content?: string }; finish_reason?: string }>;
        usage?: { prompt_tokens?: number; completion_tokens?: number };
      };
      const choice = j.choices?.[0];
      // Some reasoning models wrap their chain of thought in <think> tags.
      const text = (choice?.message?.content ?? "").replace(/<think>[\s\S]*?<\/think>/g, "").trim();
      return {
        text,
        model: j.model ?? model,
        stopReason: choice?.finish_reason ?? null,
        usage: j.usage
          ? { inputTokens: j.usage.prompt_tokens ?? 0, outputTokens: j.usage.completion_tokens ?? 0 }
          : undefined,
      };
    } finally {
      clearTimeout(timer);
    }
  }
}

// ---------------------------------------------------------------------------
// Spending cap
// ---------------------------------------------------------------------------
export interface Pricing {
  /** USD per million input tokens. */
  inputPerMTok: number;
  /** USD per million output tokens. */
  outputPerMTok: number;
}

export interface SpendLedger {
  calls: number;
  inputTokens: number;
  outputTokens: number;
  usd: number;
}

/**
 * Wraps a client so total spend can never exceed `capUsd`. Before each call it
 * prices the worst case (full prompt + full maxTokens output) and refuses if that
 * could cross the cap; after each call it books the actual usage.
 */
export class BudgetedClient implements LlmClient {
  readonly ledger: SpendLedger = { calls: 0, inputTokens: 0, outputTokens: 0, usd: 0 };

  constructor(
    private readonly inner: LlmClient,
    private readonly capUsd: number,
    private readonly price: Pricing,
  ) {
    if (!(capUsd > 0)) throw new ProviderConfigError("spend cap must be a positive number of USD");
  }

  cost(input: number, output: number): number {
    return (input * this.price.inputPerMTok + output * this.price.outputPerMTok) / 1_000_000;
  }

  remaining(): number {
    return Math.max(0, this.capUsd - this.ledger.usd);
  }

  async complete(req: LlmRequest): Promise<LlmResponse> {
    // Thinking tokens bill as output, so maxTokens is the right output bound.
    const worstIn = Math.ceil(estimateTokens(req.system + req.prompt) * 1.25);
    const worstOut = req.maxTokens ?? 32000;
    const worst = this.cost(worstIn, worstOut);
    if (this.ledger.usd + worst > this.capUsd) {
      throw new SpendCapError(
        `refusing call: worst-case $${worst.toFixed(4)} would exceed the cap ` +
          `($${this.ledger.usd.toFixed(4)} spent of $${this.capUsd.toFixed(2)})`,
      );
    }
    const res = await this.inner.complete(req);
    const inTok = res.usage?.inputTokens ?? worstIn;
    const outTok = res.usage?.outputTokens ?? worstOut;
    this.ledger.calls++;
    this.ledger.inputTokens += inTok;
    this.ledger.outputTokens += outTok;
    this.ledger.usd += this.cost(inTok, outTok);
    return res;
  }
}

// ---------------------------------------------------------------------------
// Resolution from the environment
// ---------------------------------------------------------------------------
export interface ResolvedProvider {
  kind: ProviderKind;
  client: LlmClient | null;
  /** Present when the provider is paid and wrapped in a spend cap. */
  budget?: BudgetedClient;
  /** One line for the user explaining what was chosen and why. */
  note: string;
}

function num(v: string | undefined): number | undefined {
  if (v === undefined || v.trim() === "") return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

/** Decide which backend to use. Never throws for "nothing configured". */
export function resolveProvider(env: NodeJS.ProcessEnv = process.env): ResolvedProvider {
  const explicit = env.REE_PROVIDER?.trim().toLowerCase() as ProviderKind | undefined;
  const hasAnthropic = !!(env.ANTHROPIC_API_KEY || env.ANTHROPIC_AUTH_TOKEN);
  const kind: ProviderKind =
    explicit ?? (hasAnthropic ? "anthropic" : env.REE_OPENAI_BASE_URL ? "openai-compatible" : "none");

  if (kind === "none") {
    return {
      kind,
      client: null,
      note:
        "deterministic-only mode: no model configured (set ANTHROPIC_API_KEY, or REE_OPENAI_BASE_URL for a " +
        "local model). Parsing, cleaning and slicing work fully; reconstruction is skipped.",
    };
  }

  if (kind === "openai-compatible") {
    const baseUrl = env.REE_OPENAI_BASE_URL;
    const wh = env.REE_MODEL_WORKHORSE;
    if (!baseUrl) throw new ProviderConfigError("REE_PROVIDER=openai-compatible needs REE_OPENAI_BASE_URL");
    if (!wh) throw new ProviderConfigError("openai-compatible provider needs REE_MODEL_WORKHORSE (a model name)");
    const client = new OpenAICompatClient({
      baseUrl,
      apiKey: env.REE_OPENAI_API_KEY,
      models: { workhorse: wh, deep: env.REE_MODEL_DEEP || wh },
    });
    const local = /localhost|127\.0\.0\.1|\[::1\]/.test(baseUrl);
    const cap = num(env.REE_MAX_SPEND_USD);
    if (!local && cap !== undefined) {
      const price = requirePricing(env);
      const budget = new BudgetedClient(client, cap, price);
      return { kind, client: budget, budget, note: `openai-compatible endpoint ${baseUrl} (cap $${cap})` };
    }
    if (!local) throw new ProviderConfigError(`remote endpoint ${baseUrl} is paid or unknown: set REE_MAX_SPEND_USD and prices`);
    return { kind, client, note: `local model at ${baseUrl} (no spend cap needed)` };
  }

  if (kind === "anthropic") {
    const cap = num(env.REE_MAX_SPEND_USD);
    if (cap === undefined) {
      throw new ProviderConfigError(
        "real API calls need a spending cap: set REE_MAX_SPEND_USD (and REE_PRICE_INPUT_PER_MTOK / " +
          "REE_PRICE_OUTPUT_PER_MTOK for the models you use)",
      );
    }
    const budget = new BudgetedClient(new AnthropicClient(), cap, requirePricing(env));
    return { kind, client: budget, budget, note: `Anthropic API (cap $${cap})` };
  }

  throw new ProviderConfigError(`unknown REE_PROVIDER "${explicit}" (use anthropic, openai-compatible, or none)`);
}

function requirePricing(env: NodeJS.ProcessEnv): Pricing {
  const inp = num(env.REE_PRICE_INPUT_PER_MTOK);
  const out = num(env.REE_PRICE_OUTPUT_PER_MTOK);
  if (inp === undefined || out === undefined) {
    throw new ProviderConfigError(
      "set REE_PRICE_INPUT_PER_MTOK and REE_PRICE_OUTPUT_PER_MTOK (USD per million tokens) so the spend cap can be enforced",
    );
  }
  return { inputPerMTok: inp, outputPerMTok: out };
}
