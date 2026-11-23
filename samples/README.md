# Sample artifacts

Small, openly licensed files bundled with REE so you can see a result immediately:

```bash
npx ree-reverse-engineer-everything demo
```

| File | What it is | License |
|---|---|---|
| `hardened-app.asar` | A tiny Electron app written for this repo, hardened by REE's own BLA simulator: decoy modules, a filler blob, and instructions planted in comments to mislead an AI analyst. Shows REE's cleaning. | MIT (this repo) |
| `escape-dlv.min.js` | A minified esbuild bundle of [escape-html](https://github.com/component/escape-html) 1.0.3 and [dlv](https://github.com/developit/dlv) 1.1.3. Used by the README's reconstruction demo. | MIT — see below |

## Third-party notices for `escape-dlv.min.js`

**escape-html** — Copyright (c) 2012-2013 TJ Holowaychuk, Copyright (c) 2015 Andreas Lubbe,
Copyright (c) 2015 Tiancheng "Timothy" Gu. Licensed under the MIT License.

**dlv** — Copyright (c) Jason Miller. Licensed under the MIT License.

MIT License text: Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal in the Software
without restriction, including without limitation the rights to use, copy, modify, merge,
publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to
whom the Software is furnished to do so, subject to the following conditions: The above
copyright notice and this permission notice shall be included in all copies or substantial
portions of the Software. THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,
EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR
A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE
LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR
OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS
IN THE SOFTWARE.
