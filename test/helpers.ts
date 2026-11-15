import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateFixtures, generatePyc, type FixtureFile } from "../benchmarks/fixtures/generate.js";

let cached: { dir: string; fixtures: FixtureFile[]; pyc: string | null } | undefined;

/** Generate the benchmark fixtures once per test process into a temp directory. */
export function fixtures() {
  if (!cached) {
    const dir = mkdtempSync(join(tmpdir(), "ree-test-"));
    cached = { dir, fixtures: generateFixtures(dir), pyc: generatePyc(dir) };
  }
  return cached;
}

export function fixture(fixtureName: string, variant: "clean" | "hardened"): FixtureFile {
  const f = fixtures().fixtures.find((x) => x.labels.fixture === fixtureName && x.labels.variant === variant);
  if (!f) throw new Error(`no fixture ${fixtureName}/${variant}`);
  return f;
}

export function writeTemp(name: string, content: string | Uint8Array): string {
  const p = join(fixtures().dir, name);
  writeFileSync(p, content);
  return p;
}
