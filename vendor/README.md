# Vendored dependencies

Two libraries are vendored here rather than loaded from a CDN, for one reason:
a CDN request tells a third party that you opened this tool, and a tool whose
entire premise is "your file never leaves your device" should not leak that.
Vendoring also means it works offline.

Download these two files into this folder before running:

| File | From |
|---|---|
| `pdf.min.js` and `pdf.worker.min.js` | [pdf.js](https://github.com/mozilla/pdf.js/releases) — the `pdfjs-dist` build, `build/pdf.min.js` and `build/pdf.worker.min.js` |
| `pdf-lib.min.js` | [pdf-lib](https://github.com/Hopding/pdf-lib/releases) — `dist/pdf-lib.min.js` |

Or with npm, if you prefer:

```bash
npm install pdfjs-dist@4 pdf-lib@1
cp node_modules/pdfjs-dist/build/pdf.min.mjs        vendor/pdf.min.js
cp node_modules/pdfjs-dist/build/pdf.worker.min.mjs vendor/pdf.worker.min.js
cp node_modules/pdf-lib/dist/pdf-lib.min.js         vendor/pdf-lib.min.js
```

Check the version you download exposes the globals `pdfjsLib` and `PDFLib`.
Recent pdf.js builds ship as ES modules; if you use one of those, either take
the legacy UMD build or add `type="module"` and import explicitly.

Both libraries are Apache-2.0 and MIT respectively. Keep their licence files
alongside the code if you redistribute.
