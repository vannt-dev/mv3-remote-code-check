import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { packageFromPath, scanFiles, scanPath, zipEntries, type Finding } from '../src/index.ts';
import { parseSourceMap } from '../src/sourcemap.ts';
import { makeZip } from './helpers.ts';

// test/fixtures/bundles holds real bundler output of one small project: src/background.js imports
// cdn-helper 1.2.3 (a jsDelivr address) and @acme/loader 0.4.0 (new Function), and names an unpkg
// address itself. Made with esbuild 0.25 and webpack 5.112:
//   esbuild src/background.js --bundle --format=iife --minify --sourcemap --outfile=esbuild-map/background.js
//   esbuild src/background.js --bundle --format=iife --outfile=esbuild-plain/background.js
//   webpack --entry ./src/background.js --mode development|production --devtool source-map|false
const BUNDLES = path.join(import.meta.dirname, 'fixtures', 'bundles');

const origin = (f: Finding | undefined) => f?.package && `${f.package.name}@${f.package.version ?? '?'} ${f.package.via}`;
const byMatch = (items: Finding[], text: string) => items.find((f) => f.match.includes(text));

function attributions(dir: string) {
  const { findings, warnings } = scanPath(dir);
  return {
    cdn: origin(byMatch(findings, 'jsdelivr')),
    own: origin(byMatch(findings, 'unpkg')),
    dynamic: origin(byMatch(warnings, 'Function')),
  };
}

test('packageFromPath: the innermost node_modules package, scoped, and the pnpm version', () => {
  assert.deepEqual(packageFromPath('../../node_modules/cdn-helper/index.js'), { name: 'cdn-helper', dir: '../../node_modules/cdn-helper' });
  assert.equal(packageFromPath('webpack://gen/./node_modules/@acme/loader/index.js')?.name, '@acme/loader');
  assert.equal(packageFromPath('node_modules/a/node_modules/b/lib/x.js')?.name, 'b');
  assert.equal(packageFromPath('C:\\app\\node_modules\\@s\\p\\x.js')?.name, '@s/p');
  assert.deepEqual(packageFromPath('node_modules/.pnpm/lodash@4.17.21/node_modules/lodash/lodash.js'), {
    name: 'lodash',
    version: '4.17.21',
    dir: 'node_modules/.pnpm/lodash@4.17.21/node_modules/lodash',
  });
  assert.equal(packageFromPath('node_modules/.pnpm/@s+p@1.2.3_react@18.2.0/node_modules/@s/p/x.js')?.version, '1.2.3');
  assert.equal(packageFromPath('node_modules/.pnpm/@s+p@1.2.3(react@18.2.0)/node_modules/@s/p/x.js')?.version, '1.2.3');
  // a dependency linked into another package's store folder: that folder's version is not its own
  assert.deepEqual(packageFromPath('node_modules/.pnpm/a@1.0.0/node_modules/b/x.js'), {
    name: 'b',
    dir: 'node_modules/.pnpm/a@1.0.0/node_modules/b',
  });
  assert.equal(packageFromPath('node_modules/.pnpm/node_modules/foo/x.js')?.name, 'foo');
  assert.equal(packageFromPath('src/background.js'), undefined);
  assert.equal(packageFromPath('node_modules/@scope'), undefined);
  assert.equal(packageFromPath('node_modules/.bin/x'), undefined);
});

test('parseSourceMap: the source of a place, column by column, and nothing for what it cannot read', () => {
  // line 0: columns 0-9 from a.js, from 10 from b.js; line 1: column 0 unmapped, then a.js again
  const map = parseSourceMap(
    JSON.stringify({ version: 3, sourceRoot: 'webpack://x', sources: ['a.js', 'b.js'], mappings: 'AAAA,UCAA;A,EDAA' })
  );
  assert.equal(map?.sourceAt(0, 0), 'webpack://x/a.js');
  assert.equal(map?.sourceAt(0, 9), 'webpack://x/a.js');
  assert.equal(map?.sourceAt(0, 10), 'webpack://x/b.js');
  assert.equal(map?.sourceAt(0, 500), 'webpack://x/b.js');
  assert.equal(map?.sourceAt(1, 1), undefined);
  assert.equal(map?.sourceAt(1, 2), 'webpack://x/a.js');
  assert.equal(map?.sourceAt(5, 0), undefined);
  assert.equal(parseSourceMap('not json'), undefined);
  assert.equal(parseSourceMap('{"version":3,"sections":[]}'), undefined);
  assert.equal(parseSourceMap('{"version":3,"sources":["a"],"mappings":"!!"}')?.sourceAt(0, 0), undefined);
});

test('esbuild and webpack bundles with a source map: the package, for certain', () => {
  for (const name of ['esbuild-map', 'webpack-dev-map', 'webpack-prod-map']) {
    assert.deepEqual(
      attributions(path.join(BUNDLES, name)),
      { cdn: 'cdn-helper@? source-map', own: undefined, dynamic: '@acme/loader@? source-map' },
      name
    );
  }
  const { findings } = scanPath(path.join(BUNDLES, 'webpack-dev-map'));
  assert.equal(byMatch(findings, 'jsdelivr')?.package?.source, 'webpack://gen/./node_modules/cdn-helper/index.js');
});

test('esbuild and webpack bundles without a map: a guess from the module comments, none when minified', () => {
  for (const name of ['esbuild-plain', 'webpack-dev-plain']) {
    assert.deepEqual(
      attributions(path.join(BUNDLES, name)),
      { cdn: 'cdn-helper@? module-comment', own: undefined, dynamic: '@acme/loader@? module-comment' },
      name
    );
  }
  assert.deepEqual(attributions(path.join(BUNDLES, 'webpack-prod-plain')), { cdn: undefined, own: undefined, dynamic: undefined });
});

test('webpack runtime code after a module is not put on that module', () => {
  const text = ['/***/ "./node_modules/x/index.js"', 'function x() {}', '/***/ }', '/******/ 	var u = "https://unpkg.com/runtime.js";'].join(
    '\n'
  );
  const { findings } = scanFiles([{ name: 'a.js', read: () => text }]);
  assert.equal(findings[0]?.package, undefined);
});

test('the version comes from package.json beside the built folder', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mv3rc-origin-'));
  for (const name of ['esbuild-map', 'webpack-dev-map', 'esbuild-plain']) {
    fs.cpSync(path.join(BUNDLES, name), path.join(root, 'out', name), { recursive: true });
  }
  for (const [name, version] of [
    ['cdn-helper', '1.2.3'],
    ['@acme/loader', '0.4.0'],
  ] as const) {
    fs.mkdirSync(path.join(root, 'node_modules', name), { recursive: true });
    fs.writeFileSync(path.join(root, 'node_modules', name, 'package.json'), JSON.stringify({ name, version }));
  }
  // esbuild names ../../node_modules/..., webpack webpack://gen/./node_modules/...: both are found
  assert.deepEqual(attributions(path.join(root, 'out', 'esbuild-map')), {
    cdn: 'cdn-helper@1.2.3 source-map',
    own: undefined,
    dynamic: '@acme/loader@0.4.0 source-map',
  });
  assert.equal(attributions(path.join(root, 'out', 'webpack-dev-map')).cdn, 'cdn-helper@1.2.3 source-map');
  assert.equal(attributions(path.join(root, 'out', 'esbuild-plain')).cdn, 'cdn-helper@1.2.3 module-comment');
});

test('an inline data: map, a map named by sourceMappingURL, a zip, and a broken map', () => {
  const js = fs.readFileSync(path.join(BUNDLES, 'esbuild-map', 'background.js'), 'utf8');
  const map = fs.readFileSync(path.join(BUNDLES, 'esbuild-map', 'background.js.map'));
  const code = js.replace(/\/\/# sourceMappingURL=.*/, '');
  const scan = (files: Record<string, string | Buffer>) =>
    scanFiles(Object.entries(files).map(([name, body]) => ({ name, read: () => body })));

  const inline = scan({ 'bg.js': `${code}//# sourceMappingURL=data:application/json;base64,${map.toString('base64')}\n` });
  assert.equal(origin(byMatch(inline.findings, 'jsdelivr')), 'cdn-helper@? source-map');

  const named = scan({ 'js/bg.js': `${code}//# sourceMappingURL=../maps/bg.js.map\n`, 'maps/bg.js.map': map });
  assert.equal(origin(byMatch(named.findings, 'jsdelivr')), 'cdn-helper@? source-map');

  const zip = scanFiles(zipEntries(makeZip({ 'background.js': js, 'background.js.map': map.toString() })));
  assert.equal(origin(byMatch(zip.findings, 'jsdelivr')), 'cdn-helper@? source-map');

  const broken = scan({ 'background.js': js, 'background.js.map': '{ not a map' });
  assert.equal(broken.findings.length, 2);
  assert.ok(broken.findings.every((f) => f.package === undefined));
});
