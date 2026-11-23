import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, copyFileSync, existsSync } from "node:fs";
import { tmpdir, platform } from "node:os";
import { join } from "node:path";
import { collectAppArtifacts, findAppBundles } from "../src/apps/appbundle.js";
import { analyzeApp, canMountDmg } from "../src/apps/dmg.js";
import { writeAsar, electronAppFiles } from "../benchmarks/fixtures/generate.js";

function makeAppBundle(): { dir: string; app: string } {
  const dir = mkdtempSync(join(tmpdir(), "ree-app-"));
  const app = join(dir, "Inventory.app");
  mkdirSync(join(app, "Contents", "Resources"), { recursive: true });
  mkdirSync(join(app, "Contents", "MacOS"), { recursive: true });
  writeFileSync(join(app, "Contents", "Resources", "app.asar"), writeAsar(electronAppFiles(false)));
  // A real Mach-O main executable when one is available on this host.
  if (existsSync("/bin/ls")) copyFileSync("/bin/ls", join(app, "Contents", "MacOS", "Inventory"));
  return { dir, app };
}

test("appbundle: finds the Electron asar and the main native executable in a .app", () => {
  const { app } = makeAppBundle();
  const arts = collectAppArtifacts(app);
  assert.ok(arts.some((a) => a.role === "electron-asar"), "finds app.asar");
  assert.equal(arts[0]!.role, "electron-asar", "asar is prioritized first");
  // /bin/ls is Mach-O on macOS and ELF on Linux; both count as the main executable.
  if (existsSync("/bin/ls")) assert.ok(arts.some((a) => a.role === "main-executable"), "finds native main executable");
});

test("appbundle: findAppBundles lists .app directories at a root", () => {
  const { dir, app } = makeAppBundle();
  const bundles = findAppBundles(dir);
  assert.deepEqual(bundles, [app]);
});

test("analyzeApp: analyzes each inner artifact of an extracted .app directory", async () => {
  const { app } = makeAppBundle();
  const analysis = await analyzeApp(app, { maxArtifacts: 8 });
  assert.equal(analysis.kind, "app");
  const asar = analysis.artifacts.find((a) => a.role === "electron-asar");
  assert.ok(asar?.result, "asar analyzed");
  assert.equal(asar!.result!.report.model.format, "asar");
  assert.ok(asar!.result!.limitations.length > 0, "limitations reported for the inner artifact");
});

test("analyzeApp: a non-macOS host cannot mount a .dmg but says so clearly", async () => {
  if (canMountDmg()) return; // only meaningful off macOS
  const dir = mkdtempSync(join(tmpdir(), "ree-dmg-"));
  const fake = join(dir, "x.dmg");
  const img = Buffer.alloc(4096);
  img.write("koly", img.length - 512, "latin1"); // UDIF trailer, so detection says .dmg
  writeFileSync(fake, img);
  await assert.rejects(() => analyzeApp(fake), /\.dmg analysis requires macOS \(hdiutil\)/);
});

test("doctor: reports Node, tools, and provider without exposing secrets", async () => {
  const { runDoctor, which } = await import("../src/cli/doctor.js");
  const r = runDoctor({ PATH: process.env.PATH, ANTHROPIC_API_KEY: "sk-secret-value-123" }, ">=20");
  assert.equal(r.node.version, process.versions.node);
  assert.ok(r.tools.some((t) => t.bin === "hdiutil"));
  assert.doesNotMatch(JSON.stringify(r), /sk-secret-value-123/, "never prints a key");
  assert.equal(r.provider.kind, "misconfigured"); // key but no spend cap
  assert.equal(which("definitely-not-a-real-binary-ree", { PATH: process.env.PATH }), null);
});
