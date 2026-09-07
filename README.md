# RedMoon PDF

Compress a PDF to a target size, in your browser. The file never leaves your
device — there is no server, no upload, and no request that carries your
document anywhere.

**[Live demo](https://codicsystems.github.io/redmoon-pdf/)** ·
Works offline once loaded

---

## Why

PDFs are among the most sensitive things people compress: contracts, passports,
medical records, bank statements, signed agreements. Every free online
compressor requires uploading all of that to a stranger's server, and there is
no technical reason for it — browsers have been able to do this work locally for
years.

This tool does it locally. You can verify that by opening your browser's network
tab and watching nothing leave while it runs.

## What it does

- **Three targeting modes** — a percentage of the original, an exact size in
  MB or KB, or a fixed quality in one pass
- **Binary search for exact sizes** — repeatedly rebuilds the document,
  converging on the highest quality that still fits under your target
- **Resolution cap** — 150 DPI by default, adjustable from 72 to 300
- **Greyscale conversion** — often a large saving on scans, using Rec. 601 luma
  weighting rather than a naive channel average
- **Tells you when it fails** — if the result would be larger than the original,
  it says so and tells you to keep the original

## The trade-off, stated plainly

Pages are rendered to images and re-encoded. The file gets substantially smaller
and looks the same at normal reading size, but:

- **Text is no longer selectable or searchable**
- Links, form fields, bookmarks and annotations are lost
- A PDF that is mostly text and already small may get *larger*

That is the right trade for a scan, a photo-heavy portfolio, or a document you
need to fit under an email limit. It is the wrong trade for a contract someone
needs to search or a form someone needs to fill in. Use it accordingly.

## How it works

1. **Render** — each page is drawn to a canvas with [pdf.js](https://mozilla.github.io/pdf.js/)
   at a scale derived from your DPI cap. A pdf.js viewport at scale 1 is 72 DPI,
   so the cap is a direct ratio.
2. **Flatten** — the canvas is painted white first, because JPEG has no alpha
   channel and transparent regions would otherwise come out black.
3. **Encode** — `canvas.toDataURL('image/jpeg', quality)`.
4. **Rebuild** — pages are embedded into a new document with
   [pdf-lib](https://pdf-lib.js.org/), keeping the original page dimensions in
   points so the document still prints at the correct physical size.
5. **Search**, for exact-size mode — a binary search over a single parameter
   that maps onto quality and scale together.

### One design decision worth explaining

Reducing JPEG quality alone produces visible artefacts long before it produces a
meaningfully smaller file. So the search parameter is mapped in two halves: the
upper half varies quality from 0.95 down to 0.45 at full resolution, and the
lower half holds quality at 0.45 and reduces resolution instead.

Downscaling degrades far more gracefully than quantisation artefacts — a
slightly soft page reads fine, a blocky one does not. See `paramsFor()` in
[`app.js`](app.js).

## Running it

No build step. Clone, add the two vendored libraries, serve the folder.

```bash
git clone https://github.com/codicsystems/redmoon-pdf.git
cd redmoon-pdf

# see vendor/README.md — pdf.js and pdf-lib go in vendor/
npm install pdfjs-dist@4 pdf-lib@1
cp node_modules/pdfjs-dist/build/pdf.min.mjs        vendor/pdf.min.js
cp node_modules/pdfjs-dist/build/pdf.worker.min.mjs vendor/pdf.worker.min.js
cp node_modules/pdf-lib/dist/pdf-lib.min.js         vendor/pdf-lib.min.js

python3 -m http.server 8000   # or any static server
```

Then open `http://localhost:8000`. It must be served over HTTP rather than
opened as a `file://` URL, because the pdf.js worker will not load otherwise.

Deploy by copying the folder to any static host — GitHub Pages, Netlify, Vercel,
or an S3 bucket. There is no backend to deploy.

## Limits

| | |
|---|---|
| Maximum file size | 200 MB, because everything is held in tab memory |
| Encrypted PDFs | Not supported. Remove the password first — a server-side tool could not open it either |
| Very large page counts | Memory scales with page size, not count, but hundreds of pages will be slow |
| Browsers | Anything current. Needs Canvas, File API and `toDataURL` |

If the browser runs out of memory, lower the maximum resolution in Advanced or
split the document first.

## Contributing

Issues and pull requests welcome. Things that would genuinely help:

- **Web Worker offloading** so the main thread stays responsive on large files
- **Selective compression** — leave text pages alone, compress only image pages
- **WebP or AVIF output** where the browser supports it, for better ratios
- **A real memory-pressure strategy** for files above 200 MB

Please keep the core promise intact: **no network requests carrying user data**,
ever. A pull request that adds analytics, a CDN font, or a server-side fallback
will be declined.

## Licence

[MIT](LICENSE).

Built by [Codic Systems](https://codicsystems.com), a software company in
Islamabad. We needed this and there was no reason to keep it.
