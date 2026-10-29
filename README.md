# mv3-remote-code-check

Reads a built browser extension the way the Chrome Web Store review does, and fails when the package
names **remotely hosted code**, which Manifest V3 forbids.

The review reads the package; it does not run it. A script address on another host is a violation
wherever it stands, including a branch of a bundled library that your extension never calls. That is
how [Universal File Converter](https://github.com/vannt-dev/browser-extension) 1.1.3 was rejected
("Blue Argon"), over jsPDF's PDFObject address on cdnjs, which the extension never used. tesseract.js
carries the same kind of address in its default worker, core and language paths. This tool finds such
addresses before you upload the package, so the review does not have to.

It works as a CLI, a GitHub Action and a Vite / Rollup plugin, written in TypeScript with types for
the API and the plugin. It has no runtime dependencies.

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

### Warning: dynamic code

| Rule           | Example                                                                   |
| -------------- | ------------------------------------------------------------------------- |
| `dynamic-code` | `eval(code)`, `new Function("a", "return a")`, `setTimeout("tick()", 10)` |

The content security policy of Manifest V3 extension pages has no `'unsafe-eval'`, so such code
throws when it runs. It is not remotely hosted code, so it is a **warning**: it is listed in every
format but does not change the exit code. Pass `--fail-on-dynamic-code` (or the action's
`fail-on-dynamic-code: 'true'`) to fail on it too. The Vite plugin does not fail the build on it.

It reads `.js`, `.mjs` and `.cjs` files, with the contents of strings, comments and regular
expressions left out, so `"eval() is off"` or `// no eval(x)` are not reported. It covers
`eval(…)` bare or on `window`, `self` or `globalThis` (not `vm.eval(…)` or a method named `eval`),
`new Function(…)`, and `setTimeout` / `setInterval` given a string literal or template. It does not
see `Function("…")` without `new`, indirect eval such as `(0, eval)(x)`, or a timer given a variable
that holds a string. `--allow` and `--exclude` apply to warnings as well; a script that runs only in
a sandboxed page (`sandbox.pages` in the manifest), where eval is allowed, is one to `--exclude`.

## CLI

```sh
npx mv3-remote-code-check dist
npx mv3-remote-code-check my-extension-1.2.0.zip --format github
```

```
dist: 1 reference(s) to remotely hosted code, which Manifest V3 forbids
  chunks/vendor-pdf.js:1:48213  https://cdnjs.cloudflare.com/ajax/libs/pdfobject/2.1.1/pdfobject.min.js  (address on a script CDN)
```

| Option                   | Meaning                                                                     |
| ------------------------ | --------------------------------------------------------------------------- |
| `--format <f>`           | `text` (default), `json`, `github` (annotations) or `sarif` (code scanning) |
| `--allow <text>`         | leave out findings that contain this text (repeatable)                      |
| `--exclude <glob>`       | leave out files matching the glob, `*` one segment, `**` any (repeatable)   |
| `--summary <file>`       | also append a Markdown report there, e.g. `$GITHUB_STEP_SUMMARY`            |
| `--fail-on-dynamic-code` | exit 1 on `dynamic-code` warnings too, and report them as errors            |

With several paths, `--format json` prints one array with a report per path. Every path is read
before anything is printed: if one cannot be read, the command exits 2 with the error and no report.

The exit code is 0 when the package is clean, 1 when remotely hosted code was found, and 2 on a usage
error or an unreadable package. `dynamic-code` warnings leave it at 0 unless `--fail-on-dynamic-code`
is given. In `--format json` they are in a `warnings` array next to `findings`; in `github` and
`sarif` they have the level `warning` (`error` with the flag).

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
    # fail-on-dynamic-code: 'true'   # also fail on eval / new Function
```

Findings are shown as annotations and in the job summary. The output `found` is `'true'` when
remotely hosted code was found (or dynamic code, with `fail-on-dynamic-code`). The action builds the checker from its own checkout (about 15 seconds) and
needs only the `node` of the runner.

To keep findings in the repository's **Security → Code scanning** tab instead, write SARIF and upload it:

```yaml
- run: npx mv3-remote-code-check dist --format sarif > remote-code.sarif || true
- uses: github/codeql-action/upload-sarif@v4
  with:
    sarif_file: remote-code.sarif
```

A finding in a folder points at the file, line and column; one in a `.zip` or `.crx` points at the
archive and names the file inside it.

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

const { files, findings, warnings } = scanPath('dist'); // or a .zip / .crx
// findings: [{ file, line, column, match, rule }]
// warnings: the same shape, rule 'dynamic-code'
```

## Limits

The check reads text and cannot see an address that is only assembled at run time from separate
pieces (apart from the script-tag case above). It also does not decide whether code you load from your
own server counts as remote code. Read the
[Chrome Web Store policy](https://developer.chrome.com/docs/webstore/program-policies/mv3-requirements)
for those cases.

## License

MIT
