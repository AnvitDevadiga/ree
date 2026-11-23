# Third-party notices

REE is MIT-licensed. It does **not** bundle any of the tools below; each is an
optional external program that REE detects on `PATH` at runtime and invokes as
a separate process. Install them yourself (`ree doctor` prints the command).
Licenses were checked for compatibility with MIT before integration.

## Optional external tools

| Tool | Used for | License | Project |
|---|---|---|---|
| jadx | Android APK/AAB → Java decompilation | Apache-2.0 | https://github.com/skylot/jadx |
| hdiutil | Read-only `.dmg` mounting (macOS) | Ships with macOS | Apple |

## Test fixtures (downloaded, not redistributed)

These open-source projects are fetched at test/benchmark time into gitignored
caches. They are not included in this repository or the npm package.

| Fixture | Used by | License | Source |
|---|---|---|---|
| Coffee 2.27 (`com.github.muellerma.coffee`), F-Droid build, SHA-256 pinned | APK tests (`npm run fixtures:android`) | Apache-2.0 | https://github.com/muellerma/coffee |
| ms 2.1.3 | reconstruction benchmark | MIT | https://github.com/vercel/ms |
| escape-html 1.0.3 | reconstruction benchmark | MIT | https://github.com/component/escape-html |
| dlv 1.1.3 | reconstruction benchmark | MIT | https://github.com/developit/dlv |
| kleur 4.1.5 | reconstruction benchmark | MIT | https://github.com/lukeed/kleur |
| CPython `colorsys.py` (from the local Python install) | reconstruction benchmark | PSF-2.0 | https://github.com/python/cpython |
| bla-agents (published package) | real-adversary benchmark | MIT | https://github.com/qybaihe/bla |
