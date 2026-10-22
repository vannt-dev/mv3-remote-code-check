# mv3-remote-code-check

Reads a built browser extension the way the Chrome Web Store review does, and fails when the package
names **remotely hosted code**, which Manifest V3 forbids.

The review reads the package; it does not run it. A script address on another host is a violation
wherever it stands, including a branch of a bundled library that your extension never calls. That is
how [Universal File Converter](https://github.com/vannt-dev/browser-extension) 1.1.3 was rejected
("Blue Argon"), over jsPDF's PDFObject address on cdnjs, which the extension never used. tesseract.js
carries the same kind of address in its default worker, core and language paths. This tool finds such
addresses before you upload the package, so the review does not have to.

It works as a CLI, a GitHub Action and a Vite / Rollup plugin. It has no dependencies.

## What it reports

| Rule                 | Example                                                                             |
| -------------------- | ----------------------------------------------------------------------------------- |
| `cdn-address`        | any address on a script CDN (cdnjs, jsDelivr, unpkg, esm.sh, …)                     |
| `remote-script-file` | `https://example.com/lib.js`, `//host/x.mjs`, `https://host/core.wasm`              |
| `script-tag`         | `<script src="https://…">`                                                          |
| `script-tag-built`   | `'<script src="' + url + '">'`, an address put together at run time                 |
| `manifest-csp`       | `content_security_policy.extension_pages` allowing a source that is not the package |

It reads `.js`, `.mjs`, `.cjs`, `.html`, `.css`, `.json`, `.svg` and `.xhtml` files, from a folder, a
`.zip` or a `.crx`. It skips `node_modules`, and links to a page that shows a source file
(`github.com/<owner>/<repo>/blob/…`, a common credit comment in libraries), because such a page is
HTML, not a script. Calls to an API (`fetch('https://api…')`) and stylesheets such as Google Fonts are
not code and are not reported.

## CLI

```sh
npx mv3-remote-code-check dist
npx mv3-remote-code-check my-extension-1.2.0.zip --format github
```

```
dist: 1 reference(s) to remotely hosted code, which Manifest V3 forbids
  chunks/vendor-pdf.js:1:48213  https://cdnjs.cloudflare.com/ajax/libs/pdfobject/2.1.1/pdfobject.min.js  (address on a script CDN)
```

| Option             | Meaning                                                                   |
| ------------------ | ------------------------------------------------------------------------- |
| `--format <f>`     | `text` (default), `json`, or `github` (workflow annotations)              |
| `--allow <text>`   | leave out findings that contain this text (repeatable)                    |
| `--exclude <glob>` | leave out files matching the glob, `*` one segment, `**` any (repeatable) |
| `--summary <file>` | also append a Markdown report there, e.g. `$GITHUB_STEP_SUMMARY`          |

The exit code is 0 when the package is clean, 1 when something was found, and 2 on a usage error or
an unreadable package.

## GitHub Action

```yaml
- run: npm run build
- uses: vannt-dev/mv3-remote-code-check@v0
  with:
    path: dist # or the .zip you upload; one path a line
    # allow: |
    #   https://example.com/known.js
    # exclude: '**/*.map'
    # fail: 'false'   # report only
```

Findings are shown as annotations and in the job summary. The output `found` is `'true'` when
something was found. The action runs `node` from its own checkout and installs nothing.

## Vite / Rollup plugin

```js
import { remoteCodeGuard } from 'mv3-remote-code-check/vite';

export default defineConfig({
  plugins: [
    // ...your other plugins, including ones that copy files into the output folder
    remoteCodeGuard(), // last, so its check sees what the others wrote
  ],
});
```

- `strip` (default `true`): removes addresses on script CDNs from every chunk. Code that read a default
  path from one of them is left with an empty path, so a missing option fails loudly instead of
  reaching for a CDN. With `jspdf` (default `true`), jsPDF's `output('pdfobjectnewwindow')` branch
  becomes a `throw`.
- `check` (default `true`): after the bundle is written, reads the whole output folder and fails the
  build if anything is left.
- `allow`, `exclude`: as in the CLI.

## API

```js
import { scanPath, findRemoteCode, stripRemoteCode, checkManifest } from 'mv3-remote-code-check';

const { files, findings } = scanPath('dist'); // or a .zip / .crx
// findings: [{ file, line, column, match, rule }]
```

## Limits

The check reads text and cannot see an address that is only assembled at run time from separate
pieces (apart from the script-tag case above). It also does not decide whether code you load from your
own server counts as remote code. Read the
[Chrome Web Store policy](https://developer.chrome.com/docs/webstore/program-policies/mv3-requirements)
for those cases.

## License

MIT
