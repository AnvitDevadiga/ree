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
/** The provider kept returning 429 after all retries — an availability failure, not a quality one. */
export class RateLimitError extends Error {}

/** Parse an OpenAI/Groq-style duration such as "600ms", "7.66s" or "1m2.5s" into ms. */
export function parseDurationMs(v: string | null | undefined): number | undefined {
  if (!v) return undefined;
  const m = /^(?:(\d+)h)?(?:(\d+)m(?!s))?(?:([\d.]+)s)?(?:([\d.]+)ms)?$/.exec(v.trim());
  if (!m || !(m[1] || m[2] || m[3] || m[4])) return undefined;
  return Number(m[1] ?? 0) * 3_600_000 + Number(m[2] ?? 0) * 60_000 + Number(m[3] ?? 0) * 1000 + Number(m[4] ?? 0);
}

/** Parse Retry-After (seconds or HTTP date) or Groq-style "try again in 1m2.5s" hints. */
export function retryDelayMs(retryAfter: string | null, body: string, attempt: number): number {
  if (retryAfter) {
    const s = Number(retryAfter);
    if (Number.isFinite(s)) return Math.min(120_000, Math.max(250, s * 1000));
    const t = Date.parse(retryAfter);
    if (Number.isFinite(t)) return Math.min(120_000, Math.max(250, t - Date.now()));
  }
  const m = /try again in\s+(?:(\d+)m)?(?:([\d.]+)s)?(?:([\d.]+)ms)?/i.exec(body);
  if (m && (m[1] || m[2] || m[3])) {
    const ms = Number(m[1] ?? 0) * 60_000 + Number(m[2] ?? 0) * 1000 + Number(m[3] ?? 0);
    return Math.min(120_000, Math.max(250, ms + 250));
  }
  return Math.min(60_000, 1000 * 2 ** attempt);
}

// ---------------------------------------------------------------------------
// OpenAI-compatible client (Ollama, LM Studio, vLLM, llama.cpp server, ...)
// ---------------------------------------------------------------------------
export interface OpenAICompatOptions {
  baseUrl: string;
  apiKey?: string;
  models: Record<ModelTier, string>;
  timeoutMs?: number;
  /** Retries on 429 / 503 before giving up with RateLimitError. Default 6. */
  maxRetries?: number;
  /** Injected for tests. */
  sleep?: (ms: number) => Promise<void>;
  /**
   * Tokens to budget for a response when pacing against the provider's
   * tokens-per-minute limit. Default 4096.
   */
  expectedOutputTokens?: number;
}

export class OpenAICompatClient implements LlmClient {
  /** Count of 429/503 responses seen, so callers can report rate limiting separately. */
  rateLimitHits = 0;
  /** Milliseconds spent waiting proactively for the token window to refill. */
  pacedMs = 0;
  /** The provider's message from the most recent 429/503, for reporting. */
  lastRateLimitMessage?: string;
  /** Last rate-limit state reported by the provider's x-ratelimit-* headers. */
  private window?: { remainingTokens: number; resetMs: number; at: number };

  constructor(private readonly o: OpenAICompatOptions) {}

  async complete(req: LlmRequest): Promise<LlmResponse> {
    const max = this.o.maxRetries ?? 6;
    const sleep = this.o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    for (let attempt = 0; ; attempt++) {
      await this.pace(req, sleep);
      try {
        return await this.once(req);
      } catch (e) {
        if (!(e instanceof RetryableHttp)) throw e;
        this.rateLimitHits++;
        // A daily quota can't be waited out within a run; fail fast and say so.
        if (/per day|\bTPD\b|\bRPD\b|daily/i.test(this.lastRateLimitMessage ?? "")) {
          throw new RateLimitError(`daily quota exhausted: ${this.lastRateLimitMessage}`);
        }
        if (attempt >= max) throw new RateLimitError(`rate limited after ${max} retries: HTTP ${e.status}`);
        await sleep(e.delayMs);
      }
    }
  }

  /**
   * Wait before sending if the provider said its token window can't cover this
   * call. Uses the x-ratelimit-remaining-tokens / x-ratelimit-reset-tokens
   * headers OpenAI-compatible servers (Groq, OpenAI, vLLM) return, so a small
   * tokens-per-minute tier is respected instead of hammered with retries.
   */
  private async pace(req: LlmRequest, sleep: (ms: number) => Promise<void>): Promise<void> {
    const w = this.window;
    if (!w) return;
    const need = estimateTokens(req.system + req.prompt) + Math.min(req.maxTokens ?? 8192, this.o.expectedOutputTokens ?? 4096);
    if (w.remainingTokens >= need) return;
    const wait = Math.min(60_000, Math.max(0, w.resetMs - (Date.now() - w.at)) + 250);
    if (wait <= 250) return;
    this.pacedMs += wait;
    await sleep(wait);
  }

  private recordWindow(h: Headers): void {
    const remaining = Number(h.get("x-ratelimit-remaining-tokens"));
    const reset = parseDurationMs(h.get("x-ratelimit-reset-tokens"));
    if (Number.isFinite(remaining) && h.get("x-ratelimit-remaining-tokens") !== null && reset !== undefined) {
      this.window = { remainingTokens: remaining, resetMs: reset, at: Date.now() };
    }
  }

  private async once(req: LlmRequest): Promise<LlmResponse> {
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
      this.recordWindow(res.headers);
      if (res.status === 429 || res.status === 503) {
        const body = await res.text();
        try {
          this.lastRateLimitMessage = (JSON.parse(body) as { error?: { message?: string } }).error?.message?.slice(0, 400) ?? body.slice(0, 400);
        } catch {
          this.lastRateLimitMessage = body.slice(0, 400);
        }
        throw new RetryableHttp(res.status, retryDelayMs(res.headers.get("retry-after"), body, 0));
      }
      // Never echo request headers; the body of an error response is safe to show.
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
  /** The raw HTTP client for OpenAI-compatible providers (exposes rateLimitHits). */
  transport?: OpenAICompatClient;
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
      return { kind, client: budget, budget, transport: client, note: `openai-compatible endpoint ${baseUrl} (cap $${cap})` };
    }
    if (!local) throw new ProviderConfigError(`remote endpoint ${baseUrl} is paid or unknown: set REE_MAX_SPEND_USD and prices`);
    return { kind, client, transport: client, note: `local model at ${baseUrl} (no spend cap needed)` };
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

class RetryableHttp extends Error {
  constructor(
    readonly status: number,
    readonly delayMs: number,
  ) {
    super(`HTTP ${status}`);
  }
}
