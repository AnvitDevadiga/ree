/**
 * Native test fixture: a tiny C program written for this repo (MIT, like REE),
 * compiled with the local C compiler. Ground truth is exact: four named
 * functions with a known call graph (main -> parse_qty, add_item; add_item ->
 * checksum). Skips cleanly when no compiler is available.
 *
 *   npm run fixtures:native
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { which } from "../../src/tools/external.js";

export const NATIVE_CACHE = join(dirname(fileURLToPath(import.meta.url)), ".cache", "native");
export const NATIVE_TRUTH = {
  functions: ["main", "parse_qty", "add_item", "checksum"],
  calls: { main: ["parse_qty", "add_item"], add_item: ["checksum"] } as Record<string, string[]>,
};

const SOURCE = `#include <stdio.h>
#include <stdlib.h>

static int total = 0;

__attribute__((noinline)) unsigned checksum(const char *s) {
  unsigned h = 2166136261u;
  while (*s) { h ^= (unsigned char)*s++; h *= 16777619u; }
  return h;
}

__attribute__((noinline)) int parse_qty(const char *arg) {
  int q = atoi(arg);
  return q > 0 ? q : 0;
}

__attribute__((noinline)) void add_item(const char *name, int qty) {
  total += qty;
  printf("%s x%d (%08x)\\n", name, qty, checksum(name));
}

int main(int argc, char **argv) {
  for (int i = 1; i + 1 < argc; i += 2) add_item(argv[i], parse_qty(argv[i + 1]));
  printf("total: %d\\n", total);
  return 0;
}
`;

export function buildNativeFixture(): string | null {
  const cc = which("cc") ?? which("clang") ?? which("gcc");
  if (!cc) return null;
  mkdirSync(NATIVE_CACHE, { recursive: true });
  // Windows compilers append .exe to the output name.
  const out = join(NATIVE_CACHE, process.platform === "win32" ? "inventory-native.exe" : "inventory-native");
  if (existsSync(out)) return out;
  const src = join(NATIVE_CACHE, "inventory.c");
  writeFileSync(src, SOURCE);
  execFileSync(cc, ["-O1", "-o", out, src], { stdio: "ignore" });
  return out;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const p = buildNativeFixture();
  console.log(p ? `ok  ${p}` : "skip: no C compiler found");
}
