import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import {
  BudgetedClient,
  OpenAICompatClient,
  ProviderConfigError,
  SpendCapError,
  resolveProvider,
} from "../src/agents/providers.js";
import type { LlmClient } from "../src/agents/llm.js";

async function fakeOpenAI(reply: string): Promise<{ url: string; bodies: any[]; close: () => void }> {
  const bodies: any[] = [];
  const srv = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      bodies.push({ path: req.url, auth: req.headers.authorization, body: JSON.parse(raw) });
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({
        model: "qwen-test",
        choices: [{ message: { content: reply }, finish_reason: "stop" }],
        usage: { prompt_tokens: 120, completion_tokens: 40 },
      }));
    });
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  const port = (srv.address() as AddressInfo).port;
  return { url: `http://127.0.0.1:${port}/v1`, bodies, close: () => srv.close() };
}

test("providers: nothing configured -> deterministic-only mode, clearly stated", () => {
  const p = resolveProvider({});
  assert.equal(p.kind, "none");
  assert.equal(p.client, null);
  assert.match(p.note, /deterministic-only mode/);
});

test("providers: a local OpenAI-compatible endpoint is used without a spend cap", () => {
  const p = resolveProvider({ REE_OPENAI_BASE_URL: "http://localhost:11434/v1", REE_MODEL_WORKHORSE: "qwen2.5-coder" });
  assert.equal(p.kind, "openai-compatible");
  assert.ok(p.client instanceof OpenAICompatClient);
  assert.equal(p.budget, undefined);
});

test("providers: Anthropic without a spend cap is refused, not silently run", () => {
  assert.throws(() => resolveProvider({ ANTHROPIC_API_KEY: "x" }), ProviderConfigError);
  assert.throws(() => resolveProvider({ ANTHROPIC_API_KEY: "x", REE_MAX_SPEND_USD: "2" }), /PRICE/);
  const p = resolveProvider({
    ANTHROPIC_API_KEY: "x",
    REE_MAX_SPEND_USD: "2",
    REE_PRICE_INPUT_PER_MTOK: "5",
    REE_PRICE_OUTPUT_PER_MTOK: "25",
  });
  assert.ok(p.budget instanceof BudgetedClient);
});

test("providers: a remote OpenAI-compatible endpoint needs a cap", () => {
  assert.throws(
    () => resolveProvider({ REE_OPENAI_BASE_URL: "https://api.example.com/v1", REE_MODEL_WORKHORSE: "m" }),
    /REE_MAX_SPEND_USD/,
  );
});

test("OpenAICompatClient: speaks chat/completions, strips <think>, maps tiers and usage", async () => {
  const srv = await fakeOpenAI("<think>secret reasoning</think>function f() {}");
  try {
    const c = new OpenAICompatClient({ baseUrl: srv.url, apiKey: "k", models: { workhorse: "small", deep: "big" } });
    const r = await c.complete({ system: "sys", prompt: "p", tier: "deep", maxTokens: 100 });
    assert.equal(r.text, "function f() {}");
    assert.deepEqual(r.usage, { inputTokens: 120, outputTokens: 40 });
    assert.equal(srv.bodies[0].path, "/v1/chat/completions");
    assert.equal(srv.bodies[0].body.model, "big");
    assert.equal(srv.bodies[0].auth, "Bearer k");
    assert.equal(srv.bodies[0].body.messages[0].role, "system");
  } finally {
    srv.close();
  }
});

test("BudgetedClient: refuses before sending when worst case would cross the cap", async () => {
  let sent = 0;
  const inner: LlmClient = {
    async complete() {
      sent++;
      return { text: "ok", model: "m", stopReason: "end_turn", usage: { inputTokens: 1000, outputTokens: 1000 } };
    },
  };
  // $10/MTok in and out. Worst case of a 2,000-token output call ~ $0.02.
  const b = new BudgetedClient(inner, 0.05, { inputPerMTok: 10, outputPerMTok: 10 });
  await b.complete({ system: "s", prompt: "p", maxTokens: 2000 });
  await b.complete({ system: "s", prompt: "p", maxTokens: 2000 });
  assert.equal(sent, 2);
  assert.ok(Math.abs(b.ledger.usd - 0.04) < 1e-9);
  await assert.rejects(() => b.complete({ system: "s", prompt: "p", maxTokens: 2000 }), SpendCapError);
  assert.equal(sent, 2, "refused call was never sent");
  assert.ok(b.ledger.usd <= 0.05);
});
