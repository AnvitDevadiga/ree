/**
 * Counter-BLA benchmark harness.
 *
 *   npm run bench                         # built-in clean vs hardened fixtures
 *   npm run bench -- --target app.asar    # any artifact (token stats only)
 *   npm run bench -- --target app.asar --labels app.labels.json
 *
 * For each fixture it measures, with no LLM calls:
 *   - naive tokens:  what an agent ingesting the artifact directly would read
 *   - REE tokens:    what REE's context slices contain after the anti-BLA pass
 *   - real recall:   labeled real units still present after cleaning
 *   - decoy removal: labeled decoys removed (pruned, folded away, or quarantined)
 *   - exhaust:       labeled exhaust payloads kept out of LLM context
 *   - leaks:         instruction-like comments that still reach a context slice
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { analyze } from "../../src/core/analyze.js";
import { estimateTokens } from "../../src/core/tokens.js";
import { normalizeLiterals, redactInjections } from "../../src/anti-bla/sanitizer.js";
import type { AnalyzeResult } from "../../src/core/analyze.js";
import { generateFixtures, generatePyc, type Labels } from "../fixtures/generate.js";

const here = dirname(fileURLToPath(import.meta.url));
const outDir = resolve(here, "../fixtures/out");

interface Row {
  fixture: string;
  variant: string;
  format: string;
  naiveTokens: number;
  reeTokens: number;
  reductionPct: number;
  realRecall: string;
  decoyRemoval: string;
  exhaustContained: string;
  leaks: number;
  findings: number;
}

function ratio(hit: number, total: number): string {
  return total === 0 ? "n/a" : `${hit}/${total}`;
}

function naiveTokens(path: string, res: AnalyzeResult): number {
  const fmt = res.report.model.format;
  if (fmt === "js-bundle") return estimateTokens(readFileSync(path, "utf8"));
  return res.report.stats.estTokensBefore;
}

function leakCount(res: AnalyzeResult): number {
  // Honest metric: every injection marker that still reaches a context slice,
  // whether it sat in a comment, a string literal, or raw data.
  let leaks = 0;
  for (const s of res.slices) leaks += redactInjections(normalizeLiterals(s.content).text).count;
  return leaks;
}

export async function scoreFixture(path: string, labels?: Labels): Promise<Row> {
  const res = await analyze(path);
  const names = new Set(res.report.model.units.map((u) => u.name));
  const sliceNames = new Set(res.slices.map((s) => s.name));
  const naive = naiveTokens(path, res);
  const ree = res.slices.reduce((n, s) => n + s.estTokens, 0);

  const real = labels?.real ?? [];
  const decoys = labels?.decoys ?? [];
  const exhaust = labels?.exhaust ?? [];

  return {
    fixture: labels?.fixture ?? path,
    variant: labels?.variant ?? "external",
    format: res.report.model.format,
    naiveTokens: naive,
    reeTokens: ree,
    reductionPct: naive ? Math.round((1 - ree / naive) * 1000) / 10 : 0,
    realRecall: ratio(real.filter((n) => names.has(n)).length, real.length),
    decoyRemoval: ratio(decoys.filter((n) => !names.has(n)).length, decoys.length),
    exhaustContained: ratio(exhaust.filter((n) => !sliceNames.has(n)).length, exhaust.length),
    leaks: leakCount(res),
    findings: res.report.findings.length,
  };
}

function toMarkdown(rows: Row[], extra: string[]): string {
  const head = "| fixture | variant | format | naive tokens | REE tokens | reduction | real recall | decoys removed | exhaust contained | injection leaks |";
  const sep = "|---|---|---|---:|---:|---:|---:|---:|---:|---:|";
  const lines = rows.map((r) =>
    `| ${r.fixture} | ${r.variant} | ${r.format} | ${r.naiveTokens} | ${r.reeTokens} | ${r.reductionPct}% | ${r.realRecall} | ${r.decoyRemoval} | ${r.exhaustContained} | ${r.leaks} |`,
  );
  return [
    "# Counter-BLA benchmark results",
    "",
    `Generated ${new Date().toISOString()} by \`npm run bench\`. Token counts are REE's deterministic estimate, not a model tokenizer.`,
    "Hardened fixtures are produced by REE's own simulator of BLA's documented techniques, not by bla-agents.",
    "",
    head,
    sep,
    ...lines,
    "",
    ...extra,
  ].join("\n");
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const targetIdx = args.indexOf("--target");
  const rows: Row[] = [];
  const extra: string[] = [];

  if (targetIdx !== -1) {
    const target = args[targetIdx + 1];
    if (!target) throw new Error("--target needs a path");
    const labelsIdx = args.indexOf("--labels");
    const labels = labelsIdx !== -1 ? (JSON.parse(readFileSync(args[labelsIdx + 1]!, "utf8")) as Labels) : undefined;
    rows.push(await scoreFixture(resolve(target), labels));
  } else {
    mkdirSync(outDir, { recursive: true });
    for (const f of generateFixtures(outDir)) rows.push(await scoreFixture(f.path, f.labels));

    const pyc = generatePyc(outDir);
    if (pyc) {
      const res = await analyze(pyc);
      const withParams = res.report.model.units.filter((u) => ((u.meta as { params?: string[] }).params ?? []).length > 0);
      extra.push(
        `**pyc (structure only):** ${res.report.model.units.length} code objects recovered from \`tool.pyc\` (Python ${(res.report.model.meta as { pythonVersion?: string }).pythonVersion}); ${withParams.length} with parameter names. Pruning is disabled for pyc because REE does not yet recover a bytecode call graph.`,
      );
    }
    for (const bin of ["/bin/ls", "/usr/bin/true"]) {
      if (!existsSync(bin)) continue;
      const res = await analyze(bin);
      const meta = res.report.model.meta as { importCount?: number };
      extra.push(
        `**native (structure only):** \`${bin}\` parsed as ${res.report.model.format}: ${res.report.model.units.length} function symbols, ${meta.importCount ?? 0} imports, ${res.report.model.strings.length} strings. No call graph, so nothing is pruned.`,
      );
      break;
    }
  }

  const colWidths = ["fixture", "variant", "format", "naive", "ree", "reduction", "recall", "decoys", "exhaust", "leaks"];
  const table = rows.map((r) => [r.fixture, r.variant, r.format, r.naiveTokens, r.reeTokens, `${r.reductionPct}%`, r.realRecall, r.decoyRemoval, r.exhaustContained, r.leaks].map(String));
  const widths = colWidths.map((h, i) => Math.max(h.length, ...table.map((row) => row[i]!.length)));
  const fmt = (row: string[]) => row.map((c, i) => c.padEnd(widths[i]!)).join("  ");
  console.log(fmt(colWidths));
  console.log(widths.map((w) => "-".repeat(w)).join("  "));
  for (const row of table) console.log(fmt(row));
  for (const e of extra) console.log(`\n${e.replace(/\*\*/g, "").replace(/`/g, "")}`);

  const resultsDir = resolve(here, "..");
  writeFileSync(join(resultsDir, "results.json"), JSON.stringify({ rows, notes: extra }, null, 2));
  writeFileSync(join(resultsDir, "RESULTS.md"), toMarkdown(rows, extra));
  console.log(`\nwrote benchmarks/results.json and benchmarks/RESULTS.md`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
