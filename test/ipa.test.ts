import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { analyze } from "../src/core/analyze.js";
import { detectFormat } from "../src/core/detect.js";
import { machoEncryption } from "../src/parsers/ipa.js";
import { parsePlist } from "../src/parsers/plist.js";
import { ZipReader } from "../src/parsers/zip.js";
import { reeInspect } from "../src/mcp/tools.js";
import { buildIpaFixtures, setCryptid } from "../benchmarks/fixtures/ios.js";

const IPA = buildIpaFixtures(); // null off macOS (needs clang, plutil, zip)
const skip = !IPA && "needs clang, plutil and zip (npm run fixtures:ios)";

test("plist: XML and binary forms parse; cycles and bad trailers are rejected", () => {
  const xml = '<?xml version="1.0"?><plist version="1.0"><dict><key>A</key><string>x &amp; y</string><key>B</key><array><integer>3</integer><true/></array></dict></plist>';
  assert.deepEqual(parsePlist(Buffer.from(xml)), { A: "x & y", B: [3, true] });
  assert.throws(() => parsePlist(Buffer.concat([Buffer.from("bplist00"), Buffer.alloc(40, 0xff)])));
  assert.throws(() => parsePlist(Buffer.from("not a plist")));
  // A binary plist whose top dict contains itself: {"a": <self>}.
  const body = Buffer.from([0xd1, 0x01, 0x00, 0x51, 0x61]); // dict(1){ key ref 1, value ref 0 }, "a"
  const offsets = Buffer.from([8, 11]);
  const trailer = Buffer.alloc(32);
  trailer[6] = 1; // offset int size
  trailer[7] = 1; // object ref size
  trailer.writeBigUInt64BE(2n, 8); // objects
  trailer.writeBigUInt64BE(0n, 16); // top object
  trailer.writeBigUInt64BE(13n, 24); // offset table at 8 + body length
  assert.throws(() => parsePlist(Buffer.concat([Buffer.from("bplist00"), body, offsets, trailer])), /cyclic/);
});

test("ipa: real binary Info.plist (made by plutil) is decoded", { skip }, () => {
  const z = new ZipReader(readFileSync(IPA!.dev));
  const bytes = z.read(z.get("Payload/Inventory.app/Info.plist")!);
  assert.equal(Buffer.from(bytes.subarray(0, 8)).toString(), "bplist00");
  const v = parsePlist(bytes) as Record<string, unknown>;
  assert.equal(v.CFBundleIdentifier, "org.ree.fixture.inventory");
  assert.equal(v.CFBundleVersion, "42");
});

test("ipa (development build): identity, permissions, structure, bundled JS — injections cleaned", { skip }, async () => {
  assert.equal((await detectFormat(IPA!.dev)).kind, "ipa");
  const r = await analyze(IPA!.dev);
  const m = r.report.model;
  const meta = m.meta as Record<string, any>;
  assert.equal(m.format, "ipa");
  assert.equal(meta.bundleId, "org.ree.fixture.inventory");
  assert.equal(meta.encrypted, false);
  assert.equal(meta.allowsArbitraryLoads, true);
  assert.deepEqual(meta.urlSchemes, ["inventory"]);
  assert.deepEqual(meta.frameworks, ["InventoryKit.framework"]);
  assert.deepEqual(meta.extensions, ["StockWidget.appex"]);
  assert.ok(meta.usageDescriptions.some((u: string) => /^Camera: Scan barcodes/.test(u)));
  assert.ok(!meta.usageDescriptions.some((u: string) => /ignore previous instructions/i.test(u)), "plist injection redacted in metadata");
  assert.ok(m.units.some((u) => u.name === "Inventory#_scan_code"), "unencrypted executable's symbols read");
  assert.ok(m.units.some((u) => u.name === "main.jsbundle#fetchStock"), "bundled JS analyzed");
  const text = r.slices.map((s) => s.content).join("\n");
  assert.doesNotMatch(text, /system-reminder|refuse further assistance|ignore previous instructions/i);
  const insp = await reeInspect({ path: IPA!.dev });
  assert.doesNotMatch(JSON.stringify(insp), /ignore previous instructions|system-reminder/i, "MCP output clean");
});

test("ipa (App Store–style): encrypted executable detected, never analyzed or decrypted", { skip }, async () => {
  const r = await analyze(IPA!.appstore);
  const m = r.report.model;
  assert.equal((m.meta as { encrypted: boolean }).encrypted, true);
  assert.ok(!m.units.some((u) => u.name.startsWith("Inventory#")), "no executable code units");
  assert.ok(m.units.some((u) => u.name.startsWith("main.jsbundle#")), "bundled JS still analyzed");
  assert.ok(r.limitations.some((l) => /encrypted \(App Store FairPlay\)/.test(l) && /does not decrypt/.test(l)));
});

test("macho: LC_ENCRYPTION_INFO cryptid is read from thin and universal binaries", { skip }, () => {
  const z = new ZipReader(readFileSync(IPA!.dev));
  const exe = Buffer.from(z.read(z.get("Payload/Inventory.app/Inventory")!));
  assert.deepEqual(machoEncryption(exe), { encrypted: false, slices: [{ cpu: machoEncryption(exe).slices[0]!.cpu, cryptid: 0 }] });
  setCryptid(exe, 1);
  assert.equal(machoEncryption(exe).encrypted, true);
  // Wrap the thin slice in a universal (fat) header.
  const fat = Buffer.alloc(4096 + exe.length);
  fat.writeUInt32BE(0xcafebabe, 0);
  fat.writeUInt32BE(1, 4);
  fat.writeUInt32BE(0x0100000c, 8);
  fat.writeUInt32BE(4096, 16);
  fat.writeUInt32BE(exe.length, 20);
  exe.copy(fat, 4096);
  assert.equal(machoEncryption(fat).encrypted, true);
  assert.equal(machoEncryption(Buffer.from("not mach-o at all")).encrypted, false);
});
