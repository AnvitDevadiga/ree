#!/usr/bin/env node
/**
 * Packaging smoke test: does the published package work on a clean machine?
 *
 *   npm run smoke:pack
 *
 * 1. `npm pack` — exactly what `npm publish` would upload.
 * 2. Check the tarball: CLI entry, bundled samples and notices present; no
 *    tests, benchmarks or TypeScript sources.
 * 3. In a fresh empty directory, run the documented one-liner
 *    `npx --package <tarball> ree …` and an installed copy, on a bundled sample.
 * Exits non-zero on any failure.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const win = process.platform === "win32";
const run = (cmd, args, opts = {}) =>
  execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], shell: win, timeout: 600_000, ...opts });
const fail = (msg) => {
  console.error(`[smoke:pack] FAIL — ${msg}`);
  process.exit(1);
};

const packDir = mkdtempSync(join(tmpdir(), "ree-pack-"));
const info = JSON.parse(run("npm", ["pack", "--json", "--pack-destination", packDir], { cwd: root }))[0];
const tarball = join(packDir, info.filename);
const files = info.files.map((f) => f.path);
console.log(`[smoke:pack] ${info.filename}: ${files.length} files, ${(info.size / 1024).toFixed(0)} KB packed`);

for (const need of ["dist/cli/index.js", "dist/index.js", "samples/hardened-app.asar", "samples/escape-dlv.min.js", "LICENSE", "THIRD_PARTY_NOTICES.md", "README.md"]) {
  if (!files.includes(need)) fail(`tarball is missing ${need}`);
}
const leaked = files.filter((f) => /^(test|benchmarks|src|scripts)\//.test(f) || /\.ts$/.test(f) && !/\.d\.ts$/.test(f) || /\.env/.test(f));
if (leaked.length) fail(`tarball contains files that should not ship: ${leaked.slice(0, 5).join(", ")}`);

const app = mkdtempSync(join(tmpdir(), "ree-clean-"));
writeFileSync(join(app, "package.json"), JSON.stringify({ name: "ree-smoke", version: "0.0.0", private: true }));
try {
  // The documented one-liner, from an empty directory with nothing installed.
  const demo = run("npx", ["--yes", "--package", tarball, "ree", "demo"], { cwd: app });
  if (!/planted instruction\(s\) removed/.test(demo) || !/functions recovered/.test(demo)) fail(`'ree demo' output unexpected:\n${demo}`);
  console.log("[smoke:pack] npx … ree demo: ok");

  // An installed copy, analyzing a bundled sample by path.
  run("npm", ["install", "--no-audit", "--no-fund", tarball], { cwd: app });
  const version = run("npx", ["--no-install", "ree", "--version"], { cwd: app }).trim();
  if (version !== info.version) fail(`ree --version printed '${version}', expected ${info.version}`);
  const sample = join(app, "node_modules", info.name, "samples", "escape-dlv.min.js");
  const out = JSON.parse(run("npx", ["--no-install", "ree", "analyze", sample, "--json"], { cwd: app }));
  if (!out.stats || out.stats.unitsIn < 2 || !Array.isArray(out.limitations)) fail("'ree analyze --json' returned an unexpected report");
  const doctor = JSON.parse(run("npx", ["--no-install", "ree", "doctor", "--json"], { cwd: app }));
  if (doctor.ree !== info.version || !doctor.node?.ok) fail("'ree doctor --json' unexpected");
  console.log(`[smoke:pack] installed: --version ${version}, analyze (${out.stats.unitsIn} units), doctor: ok`);
  console.log("[smoke:pack] PASS");
} finally {
  rmSync(app, { recursive: true, force: true });
  rmSync(packDir, { recursive: true, force: true });
}
