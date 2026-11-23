/**
 * .NET test fixture: Newtonsoft.Json 13.0.3 (MIT) from NuGet, SHA-256 pinned.
 *
 *   npm run fixtures:dotnet
 *
 * The NuGet package is a ZIP; the netstandard2.0 DLL is extracted with REE's
 * own bounded ZIP reader. Downloaded for local testing, never redistributed.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ZipReader } from "../../src/parsers/zip.js";

export const DOTNET_CACHE = join(dirname(fileURLToPath(import.meta.url)), ".cache", "dotnet");
export const NEWTONSOFT = {
  file: "Newtonsoft.Json.dll",
  license: "MIT",
  url: "https://api.nuget.org/v3-flatcontainer/newtonsoft.json/13.0.3/newtonsoft.json.13.0.3.nupkg",
  nupkgSha256: "872fc189e638ab1056555b03aaa38f68bcb54286e221aa646eb1129babf63c77",
  dllSha256: "8c1dd5c184b4e2e7ead06971ff3ebcb46783be972292d1deb1061744369b4d80",
  entry: "lib/netstandard2.0/Newtonsoft.Json.dll",
};

const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

export async function fetchNewtonsoft(): Promise<string> {
  mkdirSync(DOTNET_CACHE, { recursive: true });
  const dll = join(DOTNET_CACHE, NEWTONSOFT.file);
  if (existsSync(dll) && sha(readFileSync(dll)) === NEWTONSOFT.dllSha256) return dll;
  const res = await fetch(NEWTONSOFT.url);
  if (!res.ok) throw new Error(`${NEWTONSOFT.url}: HTTP ${res.status}`);
  const pkg = new Uint8Array(await res.arrayBuffer());
  if (sha(pkg) !== NEWTONSOFT.nupkgSha256) throw new Error("Newtonsoft.Json nupkg: SHA-256 mismatch");
  const z = new ZipReader(pkg);
  const bytes = z.read(z.get(NEWTONSOFT.entry)!);
  if (sha(bytes) !== NEWTONSOFT.dllSha256) throw new Error("Newtonsoft.Json.dll: SHA-256 mismatch");
  writeFileSync(dll, bytes);
  return dll;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  fetchNewtonsoft()
    .then((p) => console.log(`ok  ${p}  [${NEWTONSOFT.license}]`))
    .catch((e) => {
      console.error(e);
      process.exit(1);
    });
}
