/**
 * Python decompiler evaluation.
 *
 *   npm run bench:pyc
 *
 * For each available Python version, compiles two open-source modules — the
 * version's own stdlib `colorsys` (PSF-2.0) and a sample written for this repo
 * (MIT) — then runs each available decompiler on the .pyc and scores:
 *   produced  — the decompiler emitted source
 *   compiles  — that source compiles under the same Python version
 *   functions — ground-truth function names present
 *   behavior  — every probed function returns the same results as the original
 *
 * Behavior checks execute only these two known open-source modules and their
 * decompiled forms, in an isolated `python -I` subprocess with a timeout. REE
 * itself never executes an analyzed target.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { which } from "../../src/tools/external.js";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..");
const work = join(here, ".cache");

export const SAMPLE = `"""Sample module for REE's .pyc decompiler evaluation (MIT)."""
import json


class Ledger:
    def __init__(self, owner):
        self.owner = owner
        self.items = {}

    def add(self, name, qty=1):
        if qty <= 0:
            raise ValueError("qty must be positive")
        self.items[name] = self.items.get(name, 0) + qty
        return self.items[name]

    def total(self):
        return sum(q for q in self.items.values())

    def top(self, n=2):
        return [k for k, _ in sorted(self.items.items(), key=lambda kv: (-kv[1], kv[0]))[:n]]


def parse_line(line):
    try:
        name, qty = line.split(",")
        return name.strip(), int(qty)
    except ValueError:
        return None


def summarize(lines):
    ledger = Ledger("ree")
    bad = 0
    for line in lines:
        parsed = parse_line(line)
        if parsed is None:
            bad += 1
            continue
        ledger.add(*parsed)
    return {"total": ledger.total(), "top": ledger.top(), "bad": bad}


def render(data):
    parts = [f"{k}={v}" for k, v in sorted(data.items())]
    return "; ".join(parts) if parts else "(empty)"


def classify(n):
    if n < 0:
        return "neg"
    elif n == 0:
        return "zero"
    while n % 2 == 0:
        n //= 2
    return "odd-part:" + str(n)


def to_json(data):
    with_sorted = dict(sorted(data.items()))
    return json.dumps(with_sorted)
`;

interface ModuleSpec {
  name: string;
  license: string;
  functions: string[];
  /** Python expressions evaluated against module `m`; results compared as JSON. */
  probes: string[];
}

const MODULES: ModuleSpec[] = [
  {
    name: "colorsys",
    license: "PSF-2.0",
    functions: ["rgb_to_yiq", "yiq_to_rgb", "rgb_to_hls", "hls_to_rgb", "rgb_to_hsv", "hsv_to_rgb"],
    probes: [
      "m.rgb_to_hsv(0.2, 0.4, 0.4)", "m.hsv_to_rgb(0.5, 0.5, 0.4)", "m.rgb_to_hls(1.0, 0.5, 0.0)",
      "m.hls_to_rgb(0.25, 0.5, 1.0)", "m.rgb_to_yiq(0.1, 0.2, 0.3)", "m.yiq_to_rgb(0.5, 0.1, 0.1)",
    ],
  },
  {
    name: "ree_sample",
    license: "MIT",
    functions: ["parse_line", "summarize", "render", "classify", "to_json", "add", "total", "top"],
    probes: [
      "m.summarize(['a,2', 'b,5', 'oops', 'a, 4', 'c,1'])", "m.render({'b': 2, 'a': 1})", "m.render({})",
      "m.classify(-3)", "m.classify(0)", "m.classify(40)", "m.parse_line('x,7')", "m.parse_line('bad')",
      "m.to_json({'z': 1, 'a': [1, 2]})",
    ],
  },
];

interface Decompiler {
  name: string;
  license: string;
  bin: string | null;
  run: (bin: string, pyc: string) => string;
}

function pythons(): Array<{ version: string; exe: string }> {
  const out: Array<{ version: string; exe: string }> = [];
  for (const v of ["3.8", "3.10", "3.12", "3.13", "3.14"]) {
    let exe: string | null = null;
    try {
      exe = execFileSync("uv", ["python", "find", v], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    } catch {
      exe = which(`python${v}`);
    }
    if (exe && existsSync(exe)) out.push({ version: v, exe });
  }
  return out;
}

function decompilers(): Decompiler[] {
  const local = (n: string) => which(n) ?? (existsSync(join(process.env.HOME ?? "", ".local", "bin", n)) ? join(process.env.HOME ?? "", ".local", "bin", n) : null);
  const plain = (bin: string, pyc: string) => execFileSync(bin, [pyc], { encoding: "utf8", timeout: 60_000, stdio: ["ignore", "pipe", "pipe"], maxBuffer: 16 * 1024 * 1024 });
  return [
    { name: "pycdc", license: "GPL-3.0", bin: local("pycdc") ?? (existsSync(join(here, "..", "fixtures", ".cache", "tools", "pycdc-build", "pycdc")) ? join(here, "..", "fixtures", ".cache", "tools", "pycdc-build", "pycdc") : null), run: plain },
    { name: "decompyle3", license: "GPL-3.0", bin: local("decompyle3"), run: plain },
    { name: "uncompyle6", license: "GPL-3.0", bin: local("uncompyle6"), run: plain },
  ];
}

const PROBE_RUNNER = `
import importlib.util, json, sys
spec = importlib.util.spec_from_file_location("m", sys.argv[1])
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
out = []
for expr in json.loads(sys.argv[2]):
    try:
        out.append(repr(eval(expr, {"m": m})))
    except Exception as e:
        out.append("EXC:" + type(e).__name__)
print(json.dumps(out))
`;

function probe(py: string, src: string, probes: string[]): string[] | null {
  try {
    const res = execFileSync(py, ["-I", "-c", PROBE_RUNNER, src, JSON.stringify(probes)], { encoding: "utf8", timeout: 10_000, stdio: ["ignore", "pipe", "ignore"] });
    return JSON.parse(res.trim()) as string[];
  } catch {
    return null;
  }
}

interface Cell {
  produced: boolean;
  compiles: boolean;
  functions: string;
  behavior: string;
  note?: string;
}

async function main(): Promise<void> {
  mkdirSync(work, { recursive: true });
  const pys = pythons();
  const decs = decompilers();
  const results: Array<{ python: string; module: string; decompiler: string; cell: Cell }> = [];
  for (const { version, exe } of pys) {
    for (const mod of MODULES) {
      const dir = join(work, `py${version}`);
      mkdirSync(dir, { recursive: true });
      const src = join(dir, `${mod.name}.py`);
      if (mod.name === "colorsys") {
        writeFileSync(src, readFileSync(execFileSync(exe, ["-I", "-c", "import colorsys;print(colorsys.__file__)"], { encoding: "utf8" }).trim()));
      } else writeFileSync(src, SAMPLE);
      const pyc = join(dir, `${mod.name}.pyc`);
      execFileSync(exe, ["-I", "-c", `import py_compile;py_compile.compile(${JSON.stringify(src)}, cfile=${JSON.stringify(pyc)}, doraise=True)`]);
      const truth = probe(exe, src, mod.probes);
      for (const d of decs) {
        const cell: Cell = { produced: false, compiles: false, functions: "-", behavior: "-" };
        if (!d.bin) {
          cell.note = "not installed";
          results.push({ python: version, module: mod.name, decompiler: d.name, cell });
          continue;
        }
        let out = "";
        try {
          out = d.run(d.bin, pyc);
        } catch (e) {
          const err = e as { stdout?: string; stderr?: string; message: string };
          out = String(err.stdout ?? "");
          cell.note = `${String(err.stdout ?? "")}\n${String(err.stderr ?? err.message)}`.split("\n").find((l) => /error|unsupported|not supported|Unknown|magic/i.test(l))?.trim().slice(0, 120) ?? "failed";
        }
        const marker = out.split("\n").find((l) => /Unsupported Python version|Parse error|::=|--- This code section failed/i.test(l));
        if (marker && !cell.note) cell.note = marker.trim().slice(0, 120);
        const decompiledPath = join(dir, `${mod.name}.${d.name}.py`);
        writeFileSync(decompiledPath, out);
        cell.produced = out.trim().length > 0 && /\bdef\b|\bclass\b/.test(out);
        if (cell.produced) {
          try {
            execFileSync(exe, ["-I", "-c", `import sys;compile(open(sys.argv[1]).read(), sys.argv[1], 'exec')`, decompiledPath], { stdio: "ignore", timeout: 10_000 });
            cell.compiles = true;
          } catch {
            cell.compiles = false;
          }
          const found = mod.functions.filter((f) => new RegExp(`\\bdef\\s+${f}\\s*\\(`).test(out));
          cell.functions = `${found.length}/${mod.functions.length}`;
          if (cell.compiles && truth) {
            const got = probe(exe, decompiledPath, mod.probes);
            const same = got ? got.filter((g, i) => g === truth[i]).length : 0;
            cell.behavior = `${same}/${mod.probes.length}`;
          }
        }
        results.push({ python: version, module: mod.name, decompiler: d.name, cell });
      }
    }
  }

  // Report
  const lines: string[] = [];
  lines.push("| Python | Module | Decompiler | Output | Compiles | Functions | Behavior | Note |");
  lines.push("|---|---|---|:-:|:-:|:-:|:-:|---|");
  for (const r of results) {
    const c = r.cell;
    lines.push(`| ${r.python} | ${r.module} | ${r.decompiler} | ${c.produced ? "✅" : "❌"} | ${c.produced ? (c.compiles ? "✅" : "❌") : "–"} | ${c.functions} | ${c.behavior} | ${c.note ?? ""} |`);
  }
  const json = { generated: new Date().toISOString(), pythons: pys.map((p) => p.version), decompilers: decs.map((d) => ({ name: d.name, license: d.license, installed: !!d.bin })), results };
  writeFileSync(join(here, "results.json"), JSON.stringify(json, null, 2));
  writeFileSync(join(here, "RESULTS.md"), lines.join("\n") + "\n");
  console.log(lines.join("\n"));
  console.log(`\nwrote ${join(here, "results.json").replace(root + "/", "")}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
