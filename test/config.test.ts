import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { main } from '../src/cli.ts';
import { CONFIG_FILE, findConfig } from '../src/config.ts';

function run(args: string[], cwd: string) {
  let out = '';
  let err = '';
  const code = main(args, { out: (s) => (out += s), err: (s) => (err += s), cwd });
  return { code, out, err };
}

/** A project folder with a .git marker, so the config lookup stops there. */
function project(files: Record<string, string>) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mv3rc-config-'));
  fs.mkdirSync(path.join(dir, '.git'));
  for (const [name, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    fs.writeFileSync(path.join(dir, name), text);
  }
  return dir;
}

const remote = 'x="https://unpkg.com/a"';
const config = (value: unknown) => JSON.stringify(value);

test('paths, format and exclude come from the config file in the current folder', () => {
  const dir = project({
    'dist/a.js': remote,
    'dist/vendor/b.js': remote,
    [CONFIG_FILE]: config({ paths: ['dist'], exclude: ['vendor/**'], format: 'json' }),
  });
  const res = run([], dir);
  assert.equal(res.code, 1);
  const report = JSON.parse(res.out) as { target: string; findings: { file: string }[] };
  assert.deepEqual(
    report.findings.map((f) => f.file),
    ['a.js']
  );
});

test('CLI flags win over the config; allow and exclude lists are merged', () => {
  const dir = project({
    'dist/a.js': remote,
    'dist/vendor/b.js': remote,
    'dist/bg.js': 'eval(code)',
    [CONFIG_FILE]: config({ paths: ['dist'], exclude: ['vendor/**'], failOnDynamicCode: true, format: 'json' }),
  });
  // failOnDynamicCode from the config: the eval in bg.js is an error
  assert.equal(run(['--allow', 'unpkg.com'], dir).code, 1);
  // the CLI turns it off again; --allow adds to the config's exclude, so nothing is left
  const off = run(['--allow', 'unpkg.com', '--no-fail-on-dynamic-code'], dir);
  assert.equal(off.code, 0);
  // --format on the CLI replaces the config's format
  assert.match(run(['--format', 'text', '--no-fail-on-dynamic-code'], dir).out, /^dist: 1 reference/m);
  // positional paths replace the config's paths
  const other = path.join(dir, 'dist', 'vendor');
  const replaced = JSON.parse(run([other, '--no-fail-on-dynamic-code'], dir).out) as { target: string };
  assert.equal(replaced.target, other);
});

test('--no-config ignores the config file, --config names one', () => {
  const dir = project({
    'dist/vendor/b.js': remote,
    [CONFIG_FILE]: config({ paths: ['dist'], exclude: ['vendor/**'] }),
    'ci/strict.json': config({ paths: ['../dist'] }),
  });
  assert.equal(run([], dir).code, 0);
  assert.equal(run(['dist', '--no-config'], dir).code, 1);
  // with --no-config the paths in the config are gone too
  assert.equal(run(['--no-config'], dir).code, 2);
  // paths in a named config are read from that file's folder
  const named = run(['--config', path.join(dir, 'ci', 'strict.json')], dir);
  assert.equal(named.code, 1);
  assert.match(named.out, /vendor\/b\.js:1:4/);
  assert.equal(run(['--config', 'x.json', '--no-config'], dir).code, 2);
  const missing = run(['--config', 'nope.json'], dir);
  assert.equal(missing.code, 2);
  assert.match(missing.err, /nope\.json/);
});

test('the lookup walks up to the repository root and reads the package.json key', () => {
  const dir = project({
    'dist/a.js': remote,
    'package.json': config({ name: 'ext', mv3RemoteCodeCheck: { paths: ['dist'], allow: ['unpkg.com'] } }),
    'src/deep/x.ts': '',
  });
  assert.equal(findConfig(path.join(dir, 'src', 'deep'))?.file, path.join(dir, 'package.json'));
  assert.equal(run([], path.join(dir, 'src', 'deep')).code, 0);

  // the config file wins over the package.json key in the same folder
  fs.writeFileSync(path.join(dir, CONFIG_FILE), config({ paths: ['dist'] }));
  assert.equal(findConfig(dir)?.file, path.join(dir, CONFIG_FILE));
  assert.equal(run([], dir).code, 1);

  // a package.json without the key is not a config, and the lookup stops at .git
  const plain = project({ 'package.json': config({ name: 'x' }), 'sub/a.js': '' });
  assert.equal(findConfig(path.join(plain, 'sub')), null);
});

test('a bad config is a usage error (exit 2); an unknown key is a warning', () => {
  const bad = (text: string) => run(['--config', path.join(project({ 'c.json': text }), 'c.json'), '.'], os.tmpdir());
  const broken = bad('{ paths: [ }');
  assert.equal(broken.code, 2);
  assert.match(broken.err, /c\.json: invalid JSON/);
  assert.match(bad(config(['dist'])).err, /c\.json: the config must be a JSON object/);
  assert.match(bad(config({ exclude: 'vendor/**' })).err, /c\.json: "exclude" must be an array of strings/);
  assert.match(bad(config({ format: 'xml' })).err, /c\.json: "format" must be text, json, github or sarif/);
  assert.match(bad(config({ failOnDynamicCode: 'yes' })).err, /c\.json: "failOnDynamicCode" must be true or false/);
  assert.equal(bad(config({ paths: [1] })).code, 2);
  const pkg = project({ 'package.json': config({ mv3RemoteCodeCheck: [] }) });
  assert.equal(run(['.'], pkg).code, 2);

  const dir = project({ 'dist/a.js': 'x=1', [CONFIG_FILE]: config({ $schema: 'x', paths: ['dist'], fial: true }) });
  const res = run([], dir);
  assert.equal(res.code, 0);
  assert.match(res.err, /unknown key "fial" ignored/);
  assert.doesNotMatch(res.err, /\$schema/);
});
