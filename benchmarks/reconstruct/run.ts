/**
 * Ground-truth reconstruction benchmark.
 *
 *   npm run bench:reconstruct                  # uses the configured provider (see README)
 *   npm run bench:reconstruct -- --dry-run     # plumbing check, no model calls
 *   npm run bench:reconstruct -- --only ms --max-units 10 --no-verify
 *
 * Takes small open-source (MIT / PSF) projects, builds them into the artifact
 * formats REE handles, runs REE's full pipeline (parse -> clean -> slice ->
 * triage -> synthesis -> verification) on the build output, and compares the
 * reconstruction to the real source:
 *
 *   - function recall:  ground-truth function names that appear as definitions
 *                       in the reconstruction (meaningless for minified builds,
 *                       where names are gone — reported but not headlined);
 *   - behavior:         probe cases run against the original export and against
 *                       every function the reconstruction defines; a probe set
 *                       passes if some reconstructed function reproduces it;
 *   - cost:             tokens and USD per artifact (USD only for capped paid
 *                       providers; local models cost 0).
 *
 * Behavioral probes evaluate *model-written reconstructions of MIT libraries*
 * inside node:vm with no require, no process, and a 1s timeout. REE itself still
 * never executes an analyzed target; this harness only runs its own outputs.
 *
 * Fixture sources are fetched with `npm pack` (no install scripts run) and
 * cached in benchmarks/reconstruct/.cache.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildSync } from "esbuild";
import { callables, definedNames, probePasses, type Probe } from "./score.js";
import { analyze } from "../../src/core/analyze.js";
import { ReconstructionPipeline } from "../../src/agents/pipeline.js";
import { DryRunClient, type LlmClient, type LlmRequest, type LlmResponse } from "../../src/agents/llm.js";
import { ProviderConfigError, RateLimitError, resolveProvider, SpendCapError, type BudgetedClient, type OpenAICompatClient } from "../../src/agents/providers.js";
import { writeAsar } from "../fixtures/generate.js";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../..");
const cache = join(here, ".cache");
const buildDir = join(cache, "build");

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------
export interface Fixture {
  name: string;
  license: string;
  source: string;
  format: string;
  /** How it was built (shown in the report). */
  build: string;
  truthFunctions: string[];
  /** True when the build mangles names, so name recall is not meaningful. */
  minified: boolean;
  probes: Probe[];
  /** Produces the artifact on disk and returns its path. */
  make: () => string;
}

function fetchPkg(spec: string): string {
  const name = spec.slice(0, spec.lastIndexOf("@"));
  const dir = join(cache, name);
  if (existsSync(join(dir, "package.json"))) return dir;
  mkdirSync(dir, { recursive: true });
  execFileSync("npm", ["pack", spec, "--silent", "--pack-destination", cache], { cwd: cache, stdio: "ignore" });
  const tgz = readdirSync(cache).find((f) => f.startsWith(`${name}-`) && f.endsWith(".tgz"))!;
  execFileSync("tar", ["-xzf", join(cache, tgz), "-C", dir, "--strip-components=1"]);
  rmSync(join(cache, tgz));
  return dir;
}

function bundle(entry: string, out: string, minify: boolean, format: "iife" | "cjs" = "iife"): string {
  mkdirSync(dirname(out), { recursive: true });
  buildSync({ entryPoints: [entry], bundle: true, minify, format, globalName: format === "iife" ? "lib" : undefined, outfile: out, platform: "neutral", logLevel: "silent" });
  return out;
}

export const FIXTURES: Fixture[] = [
  {
    name: "ms",
    license: "MIT",
    source: "ms@2.1.3 (vercel/ms)",
    format: "js-bundle",
    build: "esbuild bundle, iife, not minified",
    truthFunctions: ["parse", "fmtShort", "fmtLong", "plural"],
    minified: false,
    probes: [
      { label: "parse", cases: [{ args: ["2h"], expect: 7200000 }, { args: ["1.5d"], expect: 129600000 }, { args: ["100"], expect: 100 }] },
      { label: "fmtShort", cases: [{ args: [7200000], expect: "2h" }, { args: [1500], expect: "2s" }] },
      // Probe the public API: fmtLong is a private helper in the original and
      // only reachable as ms(n, { long: true }).
      { label: "ms(n, {long:true})", cases: [{ args: [7200000, { long: true }], expect: "2 hours" }, { args: [60000, { long: true }], expect: "1 minute" }] },
    ],
    make: () => bundle(join(fetchPkg("ms@2.1.3"), "index.js"), join(buildDir, "ms.bundle.js"), false),
  },
  {
    name: "escape-html + dlv (minified)",
    license: "MIT",
    source: "escape-html@1.0.3, dlv@1.1.3",
    format: "js-bundle",
    build: "esbuild bundle, iife, minified (names mangled)",
    truthFunctions: ["escapeHtml", "dlv"],
    minified: true,
    probes: [
      {
        label: "escapeHtml",
        cases: [
          { args: [`<a href="x">&'`], expect: "&lt;a href=&quot;x&quot;&gt;&amp;&#39;" },
          { args: ["plain"], expect: "plain" },
        ],
      },
      {
        label: "dlv",
        cases: [
          { args: [{ a: { b: { c: 1 } } }, "a.b.c"], expect: 1 },
          { args: [{}, "a.b", 5], expect: 5 },
          { args: [{ a: [10, 20] }, ["a", 1]], expect: 20 },
        ],
      },
    ],
    make: () => {
      const e = fetchPkg("escape-html@1.0.3");
      const d = fetchPkg("dlv@1.1.3");
      const entry = join(buildDir, "eh-dlv.entry.js");
      mkdirSync(buildDir, { recursive: true });
      writeFileSync(entry, `import escapeHtml from ${JSON.stringify(join(e, "index.js"))};\nimport dlv from ${JSON.stringify(join(d, "index.js"))};\nexport { escapeHtml, dlv };\n`);
      return bundle(entry, join(buildDir, "eh-dlv.min.js"), true);
    },
  },
  {
    name: "kleur in an Electron-style .asar",
    license: "MIT",
    source: "kleur@4.1.5 (lukeed/kleur)",
    format: "asar",
    build: "esbuild bundle (cjs) as main.js inside an .asar with package.json",
    truthFunctions: ["run", "chain", "init"],
    minified: false,
    probes: [],
    make: () => {
      const k = fetchPkg("kleur@4.1.5");
      const js = bundle(join(k, "index.js"), join(buildDir, "kleur.cjs.js"), false, "cjs");
      const out = join(buildDir, "kleur-app.asar");
      writeFileSync(out, writeAsar({ "package.json": JSON.stringify({ name: "kleur-app", main: "main.js" }), "main.js": readFileSync(js, "utf8") }));
      return out;
    },
  },
  {
    name: "colorsys (.pyc)",
    license: "PSF-2.0",
    source: "CPython stdlib colorsys.py",
    format: "pyc",
    build: "python3 -m py_compile",
    truthFunctions: ["rgb_to_yiq", "yiq_to_rgb", "rgb_to_hls", "hls_to_rgb", "_v", "rgb_to_hsv", "hsv_to_rgb"],
    minified: false,
    probes: [],
    make: () => {
      const src = execFileSync("python3", ["-I", "-c", "import colorsys;print(colorsys.__file__)"], { encoding: "utf8" }).trim();
      const out = join(buildDir, "colorsys.pyc");
      mkdirSync(buildDir, { recursive: true });
      execFileSync("python3", ["-I", "-c", `import py_compile;py_compile.compile(${JSON.stringify(src)}, cfile=${JSON.stringify(out)}, doraise=True)`]);
      return out;
    },
  },
];

// ---------------------------------------------------------------------------
// token / cost accounting
// ---------------------------------------------------------------------------
class Meter implements LlmClient {
  calls = 0;
  inputTokens = 0;
  outputTokens = 0;
  models = new Set<string>();
  constructor(private readonly inner: LlmClient) {}
  async complete(req: LlmRequest): Promise<LlmResponse> {
    const r = await this.inner.complete(req);
    this.calls++;
    this.inputTokens += r.usage?.inputTokens ?? 0;
    this.outputTokens += r.usage?.outputTokens ?? 0;
    this.models.add(r.model);
    return r;
  }
}

interface Row {
  fixture: string;
  source: string;
  license: string;
  format: string;
  build: string;
  slices: number;
  reconstructed: number;
  verifierAccepted: number;
  nameRecall: string;
  namesFound: string[];
  behavior: string;
  behaviorDetail: Record<string, string>;
  calls: number;
  inputTokens: number;
  outputTokens: number;
  usd: number | null;
  seconds: number;
  /** 429/503 responses absorbed by backoff during this fixture. */
  rateLimitHits: number;
  /** Per-unit reconstruction and verdict, for the eval write-up. */
  units?: Array<{ name: string; tier: string; source: string; verdict?: { accepted: boolean; explicit: boolean; rationale: string } }>;
  /** Set when the fixture failed for availability (rate limit), not quality — excluded from scores. */
  rateLimited?: boolean;
  error?: string;
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------
function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i === -1 ? undefined : process.argv[i + 1];
}

async function main(): Promise<void> {
  const dry = process.argv.includes("--dry-run");
  const verify = !process.argv.includes("--no-verify");
  const maxUnits = Number(arg("--max-units") ?? 12);
  const only = arg("--only");

  let base: LlmClient;
  let budget: BudgetedClient | undefined;
  let transport: OpenAICompatClient | undefined;
  let providerNote: string;
  if (dry) {
    base = new DryRunClient();
    providerNote = "dry-run (no model calls; scores are meaningless)";
  } else {
    let p;
    try {
      p = resolveProvider();
    } catch (e) {
      if (e instanceof ProviderConfigError) {
        console.error(`[bench:reconstruct] ${e.message}`);
        process.exit(2);
      }
      throw e;
    }
    if (!p.client) {
      console.error(`[bench:reconstruct] needs a model. ${p.note}`);
      console.error("  Local:  REE_OPENAI_BASE_URL=http://localhost:11434/v1 REE_MODEL_WORKHORSE=<model> npm run bench:reconstruct");
      console.error("  Paid:   ANTHROPIC_API_KEY=... REE_MAX_SPEND_USD=<cap> REE_PRICE_INPUT_PER_MTOK=.. REE_PRICE_OUTPUT_PER_MTOK=.. npm run bench:reconstruct");
      process.exit(2);
    }
    base = p.client;
    budget = p.budget;
    transport = p.transport;
    providerNote = p.note;
  }
  console.log(`[bench:reconstruct] provider: ${providerNote}`);

  const rows: Row[] = [];
  for (const fx of FIXTURES.filter((f) => !only || f.name.startsWith(only))) {
    const t0 = Date.now();
    const spentBefore = budget?.ledger.usd ?? 0;
    const hitsBefore = transport?.rateLimitHits ?? 0;
    const pacedBefore = transport?.pacedMs ?? 0;
    const meter = new Meter(base);
    const row: Row = {
      fixture: fx.name, source: fx.source, license: fx.license, format: fx.format, build: fx.build,
      slices: 0, reconstructed: 0, verifierAccepted: 0, nameRecall: "-", namesFound: [], behavior: "-",
      behaviorDetail: {}, calls: 0, inputTokens: 0, outputTokens: 0, usd: null, seconds: 0, rateLimitHits: 0, pacedSeconds: 0,
    };
    try {
      const artifact = fx.make();
      const { report, slices } = await analyze(artifact);
      row.slices = slices.length;
      const result = await new ReconstructionPipeline(meter).run(report, {
        maxUnits,
        verify,
        onProgress: (m) => process.stderr.write(`  [${fx.name}] ${m}\n`),
      });
      row.reconstructed = result.units.length;
      row.verifierAccepted = result.units.filter((u) => u.verdict?.accepted).length;
      row.units = result.units.map((u) => ({
        name: u.recon.name,
        tier: u.recon.tier,
        source: u.recon.source.slice(0, 60000),
        verdict: u.verdict
          ? { accepted: u.verdict.accepted, explicit: u.verdict.explicit, rationale: u.verdict.rationale.slice(0, 600) }
          : undefined,
      }));

      const sources = result.units.map((u) => u.recon.source);
      const names = new Set<string>();
      for (const s of sources) for (const n of definedNames(s)) names.add(n);
      const hit = fx.truthFunctions.filter((n) => names.has(n));
      row.namesFound = hit;
      row.nameRecall = `${hit.length}/${fx.truthFunctions.length}${fx.minified ? " (minified)" : ""}`;

      if (fx.probes.length) {
        const all: Function[] = [];
        for (const s of sources) all.push(...callables(s).values());
        let pass = 0;
        for (const probe of fx.probes) {
          const ok = all.some((f) => probePasses(f, probe));
          row.behaviorDetail[probe.label] = ok ? "pass" : "fail";
          if (ok) pass++;
        }
        row.behavior = `${pass}/${fx.probes.length}`;
      } else {
        row.behavior = "not checked";
      }
    } catch (e) {
      if (e instanceof RateLimitError) {
        row.rateLimited = true;
        row.nameRecall = row.behavior = "n/a (rate-limited)";
      }
      row.error = e instanceof SpendCapError ? `spend cap reached: ${e.message}` : (e as Error).message.slice(0, 300);
      if (e instanceof SpendCapError) console.error(`[bench:reconstruct] ${row.error}`);
    }
    row.calls = meter.calls;
    row.inputTokens = meter.inputTokens;
    row.outputTokens = meter.outputTokens;
    row.usd = budget ? +(budget.ledger.usd - spentBefore).toFixed(4) : dry ? null : 0;
    row.seconds = Math.round((Date.now() - t0) / 100) / 10;
    row.rateLimitHits = (transport?.rateLimitHits ?? 0) - hitsBefore;
    row.pacedSeconds = Math.round(((transport?.pacedMs ?? 0) - pacedBefore) / 100) / 10;
    rows.push(row);
    console.log(
      `${fx.name.padEnd(34)} slices=${row.slices} recon=${row.reconstructed} names=${row.nameRecall} behavior=${row.behavior} ` +
        `tokens=${row.inputTokens}/${row.outputTokens} usd=${row.usd ?? "-"} 429s=${row.rateLimitHits} paced=${row.pacedSeconds}s${row.error ? `  ERROR: ${row.error}` : ""}`,
    );
    if (row.error?.startsWith("spend cap")) break;
  }

  const out = {
    generated: new Date().toISOString(),
    provider: providerNote,
    dryRun: dry,
    verify,
    maxUnits,
    totalUsd: budget ? +budget.ledger.usd.toFixed(4) : null,
    totalRateLimitHits: transport?.rateLimitHits ?? 0,
    label: arg("--label") ?? (dry ? "dry-run" : "run"),
    rows,
  };
  const file = join(here, dry ? "results.dryrun.json" : `results.${(arg("--label") ?? "run").replace(/[^\w-]/g, "_")}.json`);
  writeFileSync(file, JSON.stringify(out, null, 2));
  console.log(`\nwrote ${file.replace(root + "/", "")}${budget ? `  (total spend $${budget.ledger.usd.toFixed(4)})` : ""}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
