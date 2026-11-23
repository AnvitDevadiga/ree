/**
 * Fetch the open-source Android test fixture(s) into a gitignored cache.
 *
 *   npm run fixtures:android
 *
 * Only open-source apps from F-Droid (which builds every app from public
 * source) are used, pinned by SHA-256. They are downloaded for local testing
 * and never redistributed in this repository or the npm package.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const cache = join(dirname(fileURLToPath(import.meta.url)), ".cache", "android");

export const ANDROID_FIXTURES = [
  {
    file: "coffee.apk",
    app: "Coffee (com.github.muellerma.coffee) 2.27",
    license: "Apache-2.0",
    source: "https://github.com/muellerma/coffee",
    url: "https://f-droid.org/repo/com.github.muellerma.coffee_47.apk",
    sha256: "ae4688fe48e751517e7a1d56aed27bff10b87daac0d7e28993fb193a7dc8f223",
  },
];

async function main(): Promise<void> {
  mkdirSync(cache, { recursive: true });
  for (const f of ANDROID_FIXTURES) {
    const path = join(cache, f.file);
    if (!existsSync(path)) {
      const res = await fetch(f.url);
      if (!res.ok) throw new Error(`${f.url}: HTTP ${res.status}`);
      writeFileSync(path, Buffer.from(await res.arrayBuffer()));
    }
    const got = createHash("sha256").update(readFileSync(path)).digest("hex");
    if (got !== f.sha256) throw new Error(`${f.file}: SHA-256 mismatch (got ${got}); delete it and retry`);
    console.log(`ok  ${f.file}  ${f.app}  [${f.license}]`);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
