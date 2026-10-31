import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { main } from '../src/cli.ts';
import { joinPath } from '../src/report.ts';
import { remoteCodeGuard, type ScanResult } from '../src/index.ts';

function run(args: string[]) {
  let out = '';
  let err = '';
  const code = main(args, { out: (s) => (out += s), err: (s) => (err += s) });
  return { code, out, err };
}

function folder(files: Record<string, string>) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mv3rc-cli-'));
  for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), text);
  return dir;
}

test('exit 0 on a clean package, 1 on findings, 2 on bad usage', () => {
  assert.equal(run([folder({ 'a.js': 'x=1' })]).code, 0);
  const bad = run([folder({ 'a.js': 'x="https://unpkg.com/a"' })]);
  assert.equal(bad.code, 1);
  assert.match(bad.out, /a\.js:1:4 {2}https:\/\/unpkg\.com\/a {2}\(address on a script CDN\)/);
  assert.equal(run([]).code, 2);
  assert.equal(run(['--format', 'xml', 'x']).code, 2);
  assert.equal(run(['does-not-exist']).code, 2);
});

test('json and github formats, and the Markdown summary', () => {
  const dir = folder({ 'a.js': 'x="https://unpkg.com/a"' });
  const json = JSON.parse(run([dir, '--format', 'json']).out) as ScanResult;
  assert.equal(json.findings[0]?.rule, 'cdn-address');

  const summary = path.join(dir, 'summary.md');
  const gh = run([dir, '--format', 'github', '--summary', summary]);
  assert.match(gh.out, /^::error file=[^,]*a\.js,line=1,col=4,title=Remote code%3A address on a script CDN::https/m);
  assert.match(fs.readFileSync(summary, 'utf8'), /\| `a\.js:1:4` \| address on a script CDN \|/);
});

test('paths from the repository root keep a leading .. and drop only a leading ./', () => {
  assert.equal(joinPath('../../tmp/x', 'a.js'), '../../tmp/x/a.js');
  assert.equal(joinPath('..\\out', 'a.js'), '../out/a.js');
  assert.equal(joinPath('./dist/', 'a.js'), 'dist/a.js');
  assert.equal(joinPath('.', 'a.js'), 'a.js');
  assert.equal(joinPath('', 'a.js'), 'a.js');
  assert.equal(joinPath('.hidden', 'a.js'), '.hidden/a.js');
});

test('several paths: one JSON array, and nothing printed when one cannot be read', () => {
  const clean = folder({ 'a.js': 'x=1' });
  const remote = folder({ 'b.js': 'x="https://unpkg.com/b"' });
  const both = run([clean, remote, '--format', 'json']);
  assert.equal(both.code, 1);
  const reports = JSON.parse(both.out) as (ScanResult & { target: string })[];
  assert.deepEqual(
    reports.map((report) => [report.target, report.findings.length]),
    [
      [clean, 0],
      [remote, 1],
    ]
  );

  const summary = path.join(clean, 'summary.md');
  const missing = run([remote, 'does-not-exist', '--summary', summary]);
  assert.equal(missing.code, 2);
  assert.equal(missing.out, '');
  assert.match(missing.err, /^does-not-exist: /);
  assert.equal(fs.existsSync(summary), false);
});

test('sarif: one log for GitHub code scanning, every rule named, findings placed on the file', () => {
  const dir = folder({ 'a.js': 'x="https://unpkg.com/a"' });
  const clean = folder({ 'b.js': 'x=1' });
  const res = run([dir, clean, '--format', 'sarif']);
  assert.equal(res.code, 1);
  const log = JSON.parse(res.out) as {
    version: string;
    runs: {
      tool: { driver: { name: string; rules: { id: string }[] } };
      results: {
        ruleId: string;
        level: string;
        message: { text: string };
        locations: { physicalLocation: { artifactLocation: { uri: string }; region?: object } }[];
      }[];
    }[];
  };
  assert.equal(log.version, '2.1.0');
  assert.equal(log.runs.length, 1);
  const [sarifRun] = log.runs;
  assert.ok(sarifRun);
  assert.equal(sarifRun.tool.driver.name, 'mv3-remote-code-check');
  assert.deepEqual(
    sarifRun.tool.driver.rules.map((rule) => rule.id),
    ['cdn-address', 'remote-script-file', 'script-tag', 'script-tag-built', 'manifest-csp', 'dynamic-code']
  );
  assert.equal(sarifRun.results.length, 1);
  const [result] = sarifRun.results;
  assert.equal(result?.ruleId, 'cdn-address');
  assert.equal(result?.level, 'error');
  assert.match(result?.message.text ?? '', /https:\/\/unpkg\.com\/a/);
  const location = result?.locations[0]?.physicalLocation;
  assert.equal(location?.artifactLocation.uri, `${path.relative(process.cwd(), dir).replaceAll('\\', '/')}/a.js`);
  assert.deepEqual(location?.region, { startLine: 1, startColumn: 4 });

  assert.equal(run([clean, '--format', 'sarif']).code, 0);
});

test('the npm package of a finding in text, json, github and sarif; the exit code stays the same', () => {
  const bundles = path.join(import.meta.dirname, 'fixtures', 'bundles');
  const mapped = path.join(bundles, 'esbuild-map');
  const guessed = path.join(bundles, 'esbuild-plain');

  const text = run([mapped]);
  assert.equal(text.code, 1);
  assert.match(text.out, /jsdelivr\S+ {2}\(address on a script CDN\)\n {6}from npm package cdn-helper via source map\n/);
  assert.match(text.out, /unpkg\S+ {2}\(address on a script CDN\)\n(?! )/);
  assert.match(text.out, /new Function\(n\) {2}\(dynamic code evaluation\)\n {6}from npm package @acme\/loader via source map\n/);
  const plain = run([guessed]);
  assert.equal(plain.code, 1);
  assert.match(plain.out, /\n {6}probably from npm package cdn-helper \(guessed from a bundler comment\)\n/);
  assert.equal(run([path.join(bundles, 'webpack-prod-plain')]).code, 1);
  assert.equal(run([guessed, '--allow', 'jsdelivr', '--allow', 'unpkg']).code, 0);

  const json = JSON.parse(run([mapped, '--format', 'json']).out) as ScanResult;
  assert.deepEqual(json.findings[0]?.package, { name: 'cdn-helper', via: 'source-map', source: '../../node_modules/cdn-helper/index.js' });
  assert.equal(json.findings[1]?.package, undefined);

  assert.match(
    run([guessed, '--format', 'github']).out,
    /^::error [^\n]*::[^\n]*jsdelivr[^\n]* \(probably from npm package cdn-helper\)$/m
  );
  const summary = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mv3rc-cli-')), 'summary.md');
  run([guessed, '--summary', summary]);
  assert.match(
    fs.readFileSync(summary, 'utf8'),
    /\| address on a script CDN, probably from npm package cdn-helper \| `https:\/\/cdn\.jsdelivr/
  );

  const sarif = JSON.parse(run([mapped, '--format', 'sarif']).out) as {
    runs: { results: { message: { text: string }; properties?: Record<string, string> }[] }[];
  };
  const [first, second] = sarif.runs[0]?.results ?? [];
  assert.deepEqual(first?.properties, {
    npmPackage: 'cdn-helper',
    npmPackageVia: 'source-map',
    npmPackageSource: '../../node_modules/cdn-helper/index.js',
  });
  assert.match(first?.message.text ?? '', /from npm package cdn-helper via source map/);
  assert.equal(second?.properties, undefined);
});

test('--allow and --version', () => {
  const dir = folder({ 'a.js': 'x="https://unpkg.com/a"' });
  assert.equal(run([dir, '--allow', 'unpkg.com/a']).code, 0);
  assert.match(run(['--version']).out, /^\d+\.\d+\.\d+\n$/);
});

test('the Vite plugin strips chunks and fails the build on what is left in the output folder', () => {
  const plugin = remoteCodeGuard();
  assert.deepEqual(plugin.renderChunk('a="https://unpkg.com/x"'), { code: 'a=""', map: null });
  assert.equal(plugin.renderChunk('a=1'), null);

  const dir = folder({ 'copied.js': 'x="https://example.com/w.js"' });
  assert.throws(() => plugin.writeBundle.handler({ dir }), /copied\.js: https:\/\/example\.com\/w\.js/);
  assert.doesNotThrow(() => remoteCodeGuard({ allow: ['example.com'] }).writeBundle.handler({ dir }));
  assert.doesNotThrow(() => remoteCodeGuard({ check: false }).writeBundle.handler({ dir }));
});

test('dynamic code: a warning that keeps exit 0, and exit 1 with --fail-on-dynamic-code', () => {
  const dir = folder({ 'bg.js': 'eval(code)' });
  const text = run([dir]);
  assert.equal(text.code, 0);
  assert.match(text.out, /no remotely hosted code in 1 files/);
  assert.match(text.out, /1 warning\(s\): dynamic code/);
  assert.match(text.out, /bg\.js:1:1 {2}eval\(code\) {2}\(dynamic code evaluation/);
  assert.equal(run([dir, '--fail-on-dynamic-code']).code, 1);
  assert.equal(run([folder({ 'a.js': 'x=1' }), '--fail-on-dynamic-code']).code, 0);

  const json = JSON.parse(run([dir, '--format', 'json']).out) as ScanResult;
  assert.deepEqual(json.findings, []);
  assert.equal(json.warnings[0]?.rule, 'dynamic-code');

  const summary = path.join(dir, 'summary.md');
  const gh = run([dir, '--format', 'github', '--summary', summary]);
  assert.equal(gh.code, 0);
  assert.match(gh.out, /^::warning file=[^,]*bg\.js,line=1,col=1,title=Dynamic code%3A [^:]*::eval\(code\)$/m);
  assert.match(fs.readFileSync(summary, 'utf8'), /\| `bg\.js:1:1` \| dynamic code evaluation/);
  assert.match(run([dir, '--format', 'github', '--fail-on-dynamic-code']).out, /^::error file=[^,]*bg\.js/m);

  type Sarif = {
    runs: {
      tool: { driver: { rules: { id: string; defaultConfiguration: { level: string } }[] } };
      results: { ruleId: string; level: string }[];
    }[];
  };
  const sarif = run([dir, '--format', 'sarif']);
  assert.equal(sarif.code, 0);
  const log = JSON.parse(sarif.out) as Sarif;
  const rule = log.runs[0]?.tool.driver.rules.find((r) => r.id === 'dynamic-code');
  assert.equal(rule?.defaultConfiguration.level, 'warning');
  assert.deepEqual(
    log.runs[0]?.results.map((r) => [r.ruleId, r.level]),
    [['dynamic-code', 'warning']]
  );
  const strict = JSON.parse(run([dir, '--format', 'sarif', '--fail-on-dynamic-code']).out) as Sarif;
  assert.equal(strict.runs[0]?.results[0]?.level, 'error');
});

test('the Vite plugin does not fail the build on dynamic code', () => {
  const dir = folder({ 'bg.js': 'eval(code)' });
  assert.doesNotThrow(() => remoteCodeGuard().writeBundle.handler({ dir }));
});
