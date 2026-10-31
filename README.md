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

### Which npm package it came from

A finding in a bundle such as `dist/vendor.js` names the npm package it came from when it can, so
you know which dependency to update, configure or replace:

```
  vendor.js:1:48213  https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/worker.min.js  (address on a script CDN)
      from npm package tesseract.js@5.1.1 via source map
```

- **Source map (certain).** When the file has a source map (a `//# sourceMappingURL=` comment, an
  inline `data:` map, or `<file>.map` beside it), the finding's line and column are mapped back to
  the original file. If that file lies in `node_modules/<name>` (also `@scope/name`, pnpm's
  `.pnpm/<name>@<version>/node_modules/<name>`, and nested `node_modules`, where the innermost
  counts), that package is named. The version comes from a pnpm path, or from the package's
  `package.json` when the scanned folder sits in the project (a `.zip` or `.crx` gives only the pnpm
  version). A finding the map places in your own code names no package.
- **Bundler comment (a guess).** Without a map, the module comments that esbuild
  (`// node_modules/x/index.js`) and webpack in development mode (`/***/ "./node_modules/x/…"`) write
  are read, and the last one before the finding is taken. The line then reads
  `probably from npm package x (guessed from a bundler comment)`. Minified bundles have no such
  comments; build with source maps for an answer there (Vite / Rollup `build.sourcemap`, esbuild
  `--sourcemap`, webpack `devtool`).

In `--format json` the finding has a `package` field (`name`, `version` when known, `via`:
`source-map` or `module-comment`, and the `source` path); in `sarif` the result has the properties
`npmPackage`, `npmPackageVersion`, `npmPackageVia` and `npmPackageSource`; `github` annotations and
the Markdown summary name the package too. It never changes the exit code.

## CLI

```sh
npx mv3-remote-code-check dist
npx mv3-remote-code-check my-extension-1.2.0.zip --format github
```

```
dist: 1 reference(s) to remotely hosted code, which Manifest V3 forbids
  chunks/vendor-pdf.js:1:48213  https://cdnjs.cloudflare.com/ajax/libs/pdfobject/2.1.1/pdfobject.min.js  (address on a script CDN)
```

| Option                      | Meaning                                                                     |
| --------------------------- | --------------------------------------------------------------------------- |
| `--format <f>`              | `text` (default), `json`, `github` (annotations) or `sarif` (code scanning) |
| `--allow <text>`            | leave out findings that contain this text (repeatable)                      |
| `--exclude <glob>`          | leave out files matching the glob, `*` one segment, `**` any (repeatable)   |
| `--summary <file>`          | also append a Markdown report there, e.g. `$GITHUB_STEP_SUMMARY`            |
| `--fail-on-dynamic-code`    | exit 1 on `dynamic-code` warnings too, and report them as errors            |
| `--no-fail-on-dynamic-code` | keep them warnings, even when the config file says otherwise                |
| `--config <file>`           | read the settings from this file instead of looking for one                 |
| `--no-config`               | do not read a config file                                                   |

With several paths, `--format json` prints one array with a report per path. Every path is read
before anything is printed: if one cannot be read, the command exits 2 with the error and no report.

The exit code is 0 when the package is clean, 1 when remotely hosted code was found, and 2 on a usage
error, an unreadable package or a bad config file. `dynamic-code` warnings leave it at 0 unless
`--fail-on-dynamic-code` is given. In `--format json` they are in a `warnings` array next to
`findings`; in `github` and `sarif` they have the level `warning` (`error` with the flag).

### Config file

So that CI and local runs check the same way without long command lines, put the settings in
`mv3-remote-code-check.config.json`:

```json
{
  "paths": ["dist"],
  "exclude": ["**/*.map", "sandbox/**"],
  "allow": ["https://example.com/known.js"],
  "format": "text",
  "failOnDynamicCode": true
}
```

Then `npx mv3-remote-code-check` with no arguments checks `dist` with those settings. The same object
can instead sit under a `"mv3RemoteCodeCheck"` key in `package.json`.

- **Where it is looked for:** in the current folder, then each folder above it, up to the repository
  root (the folder that holds `.git`). In each folder the config file comes before `package.json`;
  the first one found is used. `--config <file>` names one (a `package.json` is read for its key),
  and `--no-config` reads none.
- **Keys:** `paths`, `allow` and `exclude` (arrays of strings), `format` (`text`, `json`, `github` or
  `sarif`) and `failOnDynamicCode` (`true` or `false`). `paths` are read from the config file's
  folder, wherever the command runs; `exclude` globs match inside the package, as on the command line.
- **Precedence:** command-line flags, then the config file, then the defaults. Paths given on the
  command line replace the config's `paths`, `--format` replaces `format`, and
  `--fail-on-dynamic-code` / `--no-fail-on-dynamic-code` replace `failOnDynamicCode`. `--allow` and
  `--exclude` **add to** the config's lists rather than replace them, so the exceptions the project
  keeps in the file always apply; use `--no-config` to drop them.
- **Errors:** a key the tool does not know is a warning on stderr and is ignored. A file that is not
  valid JSON, is not an object, or has a value of the wrong type stops the run with exit code 2. A
  `package.json` met during the search that is not valid JSON is skipped with a warning, so it never
  stops a run that did not ask for a config; one with a wrong `"mv3RemoteCodeCheck"` key does.

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
    # config: ci/mv3-check.json   # or 'false' to read no config file
```

The action reads the [config file](#config-file) the same way, from the workspace, so with one in
the repository `uses: vannt-dev/mv3-remote-code-check@v0` needs no inputs at all. An input that is
set wins over the file: `path` replaces its `paths`, `fail-on-dynamic-code` (`'true'` or `'false'`)
replaces `failOnDynamicCode`, and `allow` / `exclude` add to its lists. The action always writes
`github` annotations and the job summary, so the file's `format` does not apply there.

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

The plugin does not read the config file; pass `allow` and `exclude` to it directly.

## API

```js
import { scanPath, findRemoteCode, stripRemoteCode, checkManifest } from 'mv3-remote-code-check';

const { files, findings, warnings } = scanPath('dist'); // or a .zip / .crx
// findings: [{ file, line, column, match, rule, package? }]
// warnings: the same shape, rule 'dynamic-code'
```

## Limits

The check reads text and cannot see an address that is only assembled at run time from separate
pieces (apart from the script-tag case above). It also does not decide whether code you load from your
own server counts as remote code. Read the
[Chrome Web Store policy](https://developer.chrome.com/docs/webstore/program-policies/mv3-requirements)
for those cases.

The npm package of a finding is left out when the source map is an indexed map (`sections`) or
sits on another host, and the guess from bundler comments can be wrong in a bundle that mixes
modules without marking where each ends (esbuild marks only where each starts).

## License

MIT
