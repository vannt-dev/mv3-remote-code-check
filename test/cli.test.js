import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { main } from '../src/cli.js';
import { remoteCodeGuard } from '../src/index.js';

function run(args) {
  let out = '';
  let err = '';
  const code = main(args, { out: (s) => (out += s), err: (s) => (err += s) });
  return { code, out, err };
}

function folder(files) {
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
  const json = JSON.parse(run([dir, '--format', 'json']).out);
  assert.equal(json.findings[0].rule, 'cdn-address');

  const summary = path.join(dir, 'summary.md');
  const gh = run([dir, '--format', 'github', '--summary', summary]);
  assert.match(gh.out, /^::error file=[^,]*a\.js,line=1,col=4,title=Remote code%3A address on a script CDN::https/m);
  assert.match(fs.readFileSync(summary, 'utf8'), /\| `a\.js:1:4` \| address on a script CDN \|/);
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
