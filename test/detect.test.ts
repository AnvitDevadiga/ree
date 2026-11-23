import { test } from "node:test";
import assert from "node:assert/strict";
import { copyFileSync, mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { classify, detectFormat, unsupportedMessage } from "../src/core/detect.js";
import { ingest } from "../src/parsers/index.js";
import { fixture } from "./helpers.js";

const dir = mkdtempSync(join(tmpdir(), "ree-detect-"));
const renamed = (src: string, name: string) => {
  const p = join(dir, name);
  copyFileSync(src, p);
  return p;
};

test("detect: real fixtures are recognized by content even when renamed", async () => {
  const cases: Array<[string, string, string]> = [
    [fixture("electron-app", "hardened").path, "app.bin", "asar"],
    [fixture("wasm-module", "clean").path, "module.txt", "wasm"],
    [fixture("inventory-cli", "clean").path, "noext", "js-bundle"],
  ];
  for (const [src, name, kind] of cases) assert.equal((await detectFormat(renamed(src, name))).kind, kind, name);
  if (process.platform !== "win32") {
    const d = await detectFormat(renamed("/bin/ls", "ls.js"));
    assert.ok(d.kind === "macho" || d.kind === "elf", `native binary named .js -> ${d.kind}`);
  }
});

test("detect: ingest routes a renamed asar to the asar parser", async () => {
  const m = await ingest(renamed(fixture("electron-app", "clean").path, "archive.dat"));
  assert.equal(m.format, "asar");
});

test("detect: a binary file named .js is not claimed by the JS parser", async () => {
  const p = join(dir, "random.js");
  writeFileSync(p, Buffer.from(Array.from({ length: 4096 }, (_, i) => (i * 97 + 13) & 0xff)));
  assert.equal((await detectFormat(p)).route, "unsupported");
  assert.equal((await ingest(p)).format, "unknown");
});

test("detect: JS behind a long license header is still JavaScript", () => {
  const src = "/*!\n" + " * Copyright (c) Example. MIT License.\n".repeat(40) + " */\n'use strict';\nmodule.exports = function f() {};\n";
  assert.equal(classify(Buffer.from(src), Buffer.from(src), "bundle.min").kind, "js-bundle");
  assert.equal(classify(Buffer.from("name: x\nvalue: 3\n"), Buffer.alloc(0), "conf.yaml").kind, "text");
});

test("detect: Java class vs universal Mach-O share 0xCAFEBABE", () => {
  const java = Buffer.from([0xca, 0xfe, 0xba, 0xbe, 0x00, 0x00, 0x00, 0x41, 0, 0, 0, 0]); // major 65
  const fat = Buffer.from([0xca, 0xfe, 0xba, 0xbe, 0x00, 0x00, 0x00, 0x02, 0, 0, 0, 0]); // 2 archs
  assert.equal(classify(java, java).kind, "java-class");
  assert.equal(classify(fat, fat).kind, "macho");
});

test("detect: APK and AAB are routed to the APK parser", () => {
  const z = (names: string) => classify(Buffer.from("PK\x03\x04", "latin1"), Buffer.from(names, "latin1"));
  assert.equal(z("AndroidManifest.xml classes.dex").route, "parser");
  assert.equal(z("base/manifest/AndroidManifest.xml base/dex/classes.dex").route, "parser");
});

test("detect: ZIP-based formats are told apart by their entry names", () => {
  const zip = (names: string) => [Buffer.from("PK\x03\x04rest", "latin1"), Buffer.from(`...${names}...PK\x05\x06`, "latin1")] as const;
  const kind = (names: string) => classify(...zip(names)).kind;
  assert.equal(kind("AndroidManifest.xml classes.dex resources.arsc"), "apk");
  assert.equal(kind("base/manifest/AndroidManifest.xml base/dex/classes.dex"), "aab");
  assert.equal(kind("Payload/App.app/Info.plist Payload/App.app/App"), "ipa");
  assert.equal(kind("META-INF/MANIFEST.MF com/example/Main.class"), "jar");
  assert.equal(kind("readme.txt"), "zip");
});

test("detect: directories route to the app front-end; .dmg by its koly trailer", async () => {
  const app = join(dir, "My.app");
  mkdirSync(join(app, "Contents"), { recursive: true });
  writeFileSync(join(app, "Contents", "Info.plist"), "<plist/>");
  assert.equal((await detectFormat(app)).kind, "app-bundle");
  assert.equal((await detectFormat(dir)).route, "app");
  const tail = Buffer.alloc(1024);
  tail.write("koly", 512, "latin1");
  assert.equal(classify(Buffer.from([0x78, 0xda, 1, 2, 3, 4, 5, 6]), tail).kind, "dmg");
});

test("detect: unsupported message names the format, gives a hint, and lists what works", () => {
  const msg = unsupportedMessage("x.ipa", classify(Buffer.from("PK\x03\x04", "latin1"), Buffer.from("Payload/App.app/Info.plist", "latin1")));
  assert.match(msg, /iOS app archive/);
  assert.match(msg, /unencrypted builds is planned/);
  assert.match(msg, /Supported today:/);
  assert.match(msg, /Electron \.asar/);
});
