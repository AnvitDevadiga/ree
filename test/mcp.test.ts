import { test } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../src/mcp/server.js";
import { reeInspect, reeReconstructModule, reeStripDecoys, reeTraceEntrypoint } from "../src/mcp/tools.js";
import { fixture } from "./helpers.js";

async function connectedClient() {
  const server = createServer();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "ree-test", version: "0.0.0" });
  await client.connect(clientTransport);
  return client;
}

test("mcp: the server advertises the four REE tools", async () => {
  const client = await connectedClient();
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((t) => t.name).sort(), ["ree_inspect", "ree_reconstruct_module", "ree_strip_decoys", "ree_trace_entrypoint"]);
  await client.close();
});

test("mcp: ree_strip_decoys over the protocol returns bounded JSON", async () => {
  const client = await connectedClient();
  const res = await client.callTool({ name: "ree_strip_decoys", arguments: { path: fixture("inventory-cli", "hardened").path, maxFindings: 5 } });
  const content = res.content as Array<{ type: string; text: string }>;
  const body = JSON.parse(content[0]!.text);
  assert.ok(body.stats.tokenReductionPct > 50);
  assert.equal(body.untrustedArtifactData.findings.length, 5);
  assert.equal(body.truncated, true);
  await client.close();
});

test("mcp: tool errors come back as isError results, not crashes", async () => {
  const client = await connectedClient();
  const res = await client.callTool({ name: "ree_inspect", arguments: { path: "/definitely/not/here.wasm" } });
  assert.equal(res.isError, true);
  await client.close();
});

test("tools: inspect wraps artifact text as untrusted data", async () => {
  const res = await reeInspect({ path: fixture("electron-app", "hardened").path });
  assert.equal(res.format, "asar");
  assert.ok(res.notice.includes("data"));
  assert.ok(Array.isArray(res.untrustedArtifactData.units));
});

test("tools: trace follows real edges from the entry point", async () => {
  const res = await reeTraceEntrypoint({ path: fixture("webpack-bundle", "hardened").path, depth: 3 });
  assert.ok(!("error" in res));
  if ("error" in res) return;
  const names = res.untrustedArtifactData.nodes.map((n) => n.name);
  assert.deepEqual(names.sort(), ["module[0]", "module[1]", "module[2]", "module[3]"]);
});

test("tools: reconstruct in dry-run mode sends only the cleaned slice", async () => {
  const res = await reeReconstructModule({ path: fixture("inventory-cli", "hardened").path, unit: "removeItem", dryRun: true, verify: true });
  assert.ok(!("error" in res));
  if ("error" in res) return;
  assert.match(res.source, /dry-run/);
  assert.doesNotMatch(res.source, /SYSTEM: ignore previous instructions/);
  assert.equal(res.tier, "workhorse");
});

test("tools: stripDecoys reports per-pass counts", async () => {
  const res = await reeStripDecoys({ path: fixture("wasm-module", "hardened").path });
  assert.equal(res.stats.unitsPruned, 3);
  assert.ok(res.byPass.reachability >= 3);
});
