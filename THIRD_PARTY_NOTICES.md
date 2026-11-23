# Third-party notices

REE is MIT-licensed. It does **not** bundle any of the tools below (REE writes a small export script of its own for Ghidra at runtime); each is an
optional external program that REE detects on `PATH` at runtime and invokes as
a separate process. Install them yourself (`ree doctor` prints the command).
Licenses were checked for compatibility with MIT before integration.

## Optional external tools

| Tool | Used for | License | Project |
|---|---|---|---|
| jadx | Android APK/AAB → Java decompilation | Apache-2.0 | https://github.com/skylot/jadx |
| Vineflower | Java JAR/`.class` → Java decompilation | Apache-2.0 | https://github.com/Vineflower/vineflower |
| ilspycmd (ILSpy) | .NET assembly → C# decompilation | MIT | https://github.com/icsharpcode/ILSpy |
| pycdc (Decompyle++) | Python `.pyc` → source (preferred, any version) | GPL-3.0 — run as a separate program, never bundled or linked | https://github.com/zrax/pycdc |
| uncompyle6 | Python `.pyc` → source (bytecode ≤ 3.8) | GPL-3.0 — run as a separate program, never bundled or linked | https://github.com/rocky/python-uncompyle6 |
| Ghidra (`analyzeHeadless`) | Native ELF/Mach-O/PE → C pseudocode + call graph | Apache-2.0 | https://github.com/NationalSecurityAgency/ghidra |
| hdiutil | Read-only `.dmg` mounting (macOS) | Ships with macOS | Apple |

## Test fixtures (downloaded, not redistributed)

These open-source projects are fetched at test/benchmark time into gitignored
caches. They are not included in this repository or the npm package.

| Fixture | Used by | License | Source |
|---|---|---|---|
| Coffee 2.27 (`com.github.muellerma.coffee`), F-Droid build, SHA-256 pinned | APK tests (`npm run fixtures:android`) | Apache-2.0 | https://github.com/muellerma/coffee |
| Gson 2.11.0 (Maven Central, SHA-256 pinned) | JAR tests (`npm run fixtures:java`) | Apache-2.0 | https://github.com/google/gson |
| `inventory-cli.jar` (written for this repo, compiled locally) | JAR ground-truth tests | MIT (this repo) | `benchmarks/fixtures/java.ts` |
| Newtonsoft.Json 13.0.3 (NuGet, netstandard2.0 DLL, SHA-256 pinned) | .NET tests (`npm run fixtures:dotnet`) | MIT | https://github.com/JamesNK/Newtonsoft.Json |
| `inventory-native` (C, written for this repo, compiled locally) | native ground-truth tests (`npm run fixtures:native`) | MIT (this repo) | `benchmarks/fixtures/native.ts` |
| CPython stdlib `colorsys.py` for 3.8, 3.10, 3.12, 3.13, 3.14 (`uv` installs) | `.pyc` decompiler evaluation (`npm run bench:pyc`) | PSF-2.0 | https://github.com/python/cpython |
| `inventory-dev.ipa` / `inventory-appstore.ipa` (assembled from parts written for this repo; the App Store variant only sets `cryptid`, nothing is encrypted) | iOS tests (`npm run fixtures:ios`) | MIT (this repo) | `benchmarks/fixtures/ios.ts` |
| ms 2.1.3 | reconstruction benchmark | MIT | https://github.com/vercel/ms |
| escape-html 1.0.3 | reconstruction benchmark | MIT | https://github.com/component/escape-html |
| dlv 1.1.3 | reconstruction benchmark | MIT | https://github.com/developit/dlv |
| kleur 4.1.5 | reconstruction benchmark | MIT | https://github.com/lukeed/kleur |
| CPython `colorsys.py` (from the local Python install) | reconstruction benchmark | PSF-2.0 | https://github.com/python/cpython |
| bla-agents (published package) | real-adversary benchmark | MIT | https://github.com/qybaihe/bla |
