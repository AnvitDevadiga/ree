/**
 * Real-adversary benchmark: REE vs. genuine `bla-agents` output.
 *
 *   npm run bench:real
 *
 * Unlike `npm run bench` (which hardens fixtures with REE's own simulator of
 * BLA's techniques), this harness installs and runs the real published
 * `bla-agents` package, hardens REE's clean fixtures at the worst-case setting
 * (`--intensity bankrupt --llm-directives`), and then measures REE's
 * deterministic pre-pass over that real output:
 *
 *   - token reduction: naive ingest tokens vs. REE context-slice tokens
 *   - injection leaks:  BLA prompt-injection markers still reaching a slice
 *   - decoy-family:     structural-clone decoy units quarantined
 *
 * It is network-gated by design. When `bla-agents` cannot be obtained (offline
 * CI, restricted network), it prints a skip notice and exits 0 so the suite
 * stays green. Point `REE_BLA_BIN` at a local `bla` CLI to skip installation.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { analyze } from "../../src/core/analyze.js";
import { estimateTokens } from "../../src/core/tokens.js";
import { normalizeLiterals, redactInjections } from "../../src/anti-bla/sanitizer.js";
import { generateFixtures, generatePyc } from "../fixtures/generate.js";
import { readFileSync } from "node:fs";

const BLA_VERSION = process.env.REE_BLA_VERSION ?? "3.3.2";
const here = dirname(fileURLToPath(import.meta.url));
const outDir = resolve(here, "RESULTS.md");

interface RealRow {
  fixture: string;
  format: string;
  naiveTokens: number;
  reeTokens: number;
  reductionPct: number;
  decoyFamilyUnits: number;
  leaks: number;
}

/** Resolve a `bla` CLI: an env override, an existing install, or a fresh temp install. */
function resolveBla(): { cmd: string; args: string[]; cleanup: () => void } | null {
  if (process.env.REE_BLA_BIN) return { cmd: process.env.REE_BLA_BIN, args: [], cleanup: () => {} };
  const dir = mkdtempSync(join(tmpdir(), "ree-bla-"));
  try {
    execFileSync("npm", ["init", "-y"], { cwd: dir, stdio: "ignore" });
    execFileSync("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund", `bla-agents@${BLA_VERSION}`], {
      cwd: dir,
      stdio: "ignore",
      timeout: 180_000,
    });
    const bin = join(dir, "node_modules", ".bin", "bla");
    if (!existsSync(bin)) throw new Error("bla binary missing after install");
    return { cmd: bin, args: [], cleanup: () => rmSync(dir, { recursive: true, force: true }) };
  } catch (err) {
    rmSync(dir, { recursive: true, force: true });
    console.log(`[bench:real] SKIP — could not obtain bla-agents@${BLA_VERSION}: ${(err as Error).message}`);
    console.log("[bench:real] Set REE_BLA_BIN to a local 'bla' CLI, or run with network access.");
    return null;
  }
}

function harden(bla: { cmd: string; args: string[] }, input: string, output: string): boolean {
  try {
    execFileSync(
      bla.cmd,
      [...bla.args, "protect", input, "-o", output, "--intensity", "bankrupt", "--llm-directives", "--seed", "1337"],
      { stdio: "ignore", timeout: 120_000, env: { ...process.env, NO_COLOR: "1" } },
    );
    return existsSync(output);
  } catch {
    return false;
  }
}

async function scoreReal(path: string, fixture: string): Promise<RealRow> {
  const res = await analyze(path);
  const st = res.report.stats;
  const naive =
    res.report.model.format === "js-bundle" ? estimateTokens(readFileSync(path, "utf8")) : st.estTokensBefore;
  const ree = res.slices.reduce((n, s) => n + s.estTokens, 0);
  let leaks = 0;
  for (const s of res.slices) leaks += redactInjections(normalizeLiterals(s.content).text).count;
  return {
    fixture,
    format: res.report.model.format,
    naiveTokens: naive,
    reeTokens: ree,
    reductionPct: naive ? Math.round((1 - ree / naive) * 1000) / 10 : 0,
    decoyFamilyUnits: st.decoyFamilyUnits ?? 0,
    leaks,
  };
}

function toMarkdown(rows: RealRow[]): string {
  const head = "| fixture | format | naive tokens | REE tokens | reduction | decoy-family units | injection leaks |";
  const sep = "|---|---|---:|---:|---:|---:|---:|";
  const lines = rows.map(
    (r) =>
      `| ${r.fixture} | ${r.format} | ${r.naiveTokens} | ${r.reeTokens} | ${r.reductionPct}% | ${r.decoyFamilyUnits} | ${r.leaks} |`,
  );
  return [
    "# Real-adversary benchmark — REE vs. genuine bla-agents",
    "",
    `Generated ${new Date().toISOString()} by \`npm run bench:real\` against **real \`bla-agents@${BLA_VERSION}\`** output`,
    "(`--intensity bankrupt --llm-directives`). Token counts are REE's deterministic estimate, not a model tokenizer.",
    "",
    "**Injection leaks must be 0** — any BLA prompt-injection marker reaching a context slice is a regression.",
    "",
    head,
    sep,
    ...lines,
    "",
  ].join("\n");
}

async function main(): Promise<void> {
  const bla = resolveBla();
  if (!bla) process.exit(0); // gated skip keeps CI green

  const work = mkdtempSync(join(tmpdir(), "ree-realbench-"));
  const cleanDir = join(work, "clean");
  const hardDir = join(work, "hardened");
  mkdirSync(cleanDir, { recursive: true });
  mkdirSync(hardDir, { recursive: true });

  try {
    const fixtures = generateFixtures(cleanDir).filter((f) => f.labels.variant === "clean");
    const pyc = generatePyc(cleanDir);
    const inputs: { path: string; fixture: string }[] = fixtures.map((f) => ({ path: f.path, fixture: f.labels.fixture }));
    if (pyc) inputs.push({ path: pyc, fixture: "python-pyc" });

    const rows: RealRow[] = [];
    let leakTotal = 0;
    for (const { path, fixture } of inputs) {
      const hardened = join(hardDir, fixture.replace(/[^a-z0-9.-]/gi, "_") + "." + path.split(".").pop());
      if (!harden(bla, path, hardened)) {
        console.log(`[bench:real] skip ${fixture}: bla could not harden it`);
        continue;
      }
      const row = await scoreReal(hardened, fixture);
      rows.push(row);
      leakTotal += row.leaks;
      console.log(
        `${fixture.padEnd(16)} ${row.format.padEnd(10)} ${row.reductionPct}% reduction  decoy-family=${row.decoyFamilyUnits}  leaks=${row.leaks}`,
      );
    }

    if (rows.length) {
      writeFileSync(outDir, toMarkdown(rows));
      console.log(`\nWrote ${outDir}`);
    }
    if (leakTotal > 0) {
      console.error(`\n[bench:real] FAIL — ${leakTotal} injection marker(s) leaked into context slices.`);
      process.exitCode = 1;
    } else if (rows.length) {
      console.log("\n[bench:real] PASS — 0 injection leaks across all real-BLA fixtures.");
    }
  } finally {
    rmSync(work, { recursive: true, force: true });
    bla.cleanup();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
