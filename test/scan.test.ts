import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { deflateRawSync } from 'node:zlib';
import { checkManifest, findRemoteCodeInDir, scanPath, zipEntries } from '../src/index.ts';
import { globToRegExp } from '../src/scan.ts';

function tempDir(files: Record<string, string>) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mv3rc-'));
  for (const [name, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    fs.writeFileSync(path.join(dir, name), text);
  }
  return dir;
}

// A ZIP with one deflated and one stored entry, written by hand so the reader is tested against
// the format and not against itself.
export function makeZip(files: Record<string, string>): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  Object.entries(files).forEach(([name, text], i) => {
    const raw = Buffer.from(text);
    const method = i % 2 === 0 ? 8 : 0;
    const data = method === 8 ? deflateRawSync(raw) : raw;
    const nameBuf = Buffer.from(name);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x800, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x800, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, nameBuf, data);
    centrals.push(central, nameBuf);
    offset += local.length + nameBuf.length + data.length;
  });
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(files).length, 8);
  end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

const MANIFEST = JSON.stringify({ manifest_version: 3, name: 'x', version: '1' });

test('scans a folder: code, markup and the manifest; skips other files and node_modules', () => {
  const dir = tempDir({
    'manifest.json': MANIFEST,
    'popup.html': '<script src="https://code.jquery.com/jquery.min.js"></script>',
    'lib/a.js': 'x="https://cdn.jsdelivr.net/npm/a"',
    'notes.txt': 'https://unpkg.com/ignored',
    'node_modules/dep/index.js': 'x="https://unpkg.com/ignored"',
  });
  const { files, findings } = scanPath(dir);
  assert.equal(files, 3);
  assert.deepEqual(findings.map((f) => [f.file, f.rule]).sort(), [
    ['lib/a.js', 'cdn-address'],
    ['popup.html', 'script-tag'],
  ]);
});

test('scans a .zip the same way as the folder it came from', () => {
  const files = {
    'manifest.json': MANIFEST,
    'bg.js': 'importScripts("https://example.com/worker.js")',
    'ok.js': 'fetch("https://api.example.com/x")',
  };
  const zipPath = path.join(tempDir({}), 'ext.zip');
  fs.writeFileSync(zipPath, makeZip(files));
  assert.deepEqual(
    zipEntries(fs.readFileSync(zipPath)).map((e) => [e.name, e.read().toString()]),
    Object.entries(files)
  );
  const { findings } = scanPath(zipPath);
  assert.deepEqual(
    findings.map((f) => [f.file, f.match]),
    [['bg.js', 'https://example.com/worker.js']]
  );
});

test('scans a .crx (version 3 header before the ZIP)', () => {
  const zip = makeZip({ 'manifest.json': MANIFEST, 'a.js': 'x="https://unpkg.com/a"' });
  const header = Buffer.alloc(12 + 5);
  header.write('Cr24', 0, 'latin1');
  header.writeUInt32LE(3, 4);
  header.writeUInt32LE(5, 8);
  const crx = path.join(tempDir({}), 'ext.crx');
  fs.writeFileSync(crx, Buffer.concat([header, zip]));
  assert.equal(scanPath(crx).findings.length, 1);
});

test('allow and exclude leave findings out', () => {
  const dir = tempDir({
    'a.js': 'x="https://unpkg.com/a"; y="https://example.com/b.js"',
    'vendor/big.min.js': 'x="https://unpkg.com/z"',
  });
  const { findings } = scanPath(dir, { allow: ['example.com/b.js'], exclude: ['vendor/**'] });
  assert.deepEqual(
    findings.map((f) => f.match),
    ['https://unpkg.com/a']
  );
});

test('findRemoteCodeInDir keeps the shape browser-extension used', () => {
  const dir = tempDir({ 'a.js': 'x="https://unpkg.com/a"; y="https://unpkg.com/b"' });
  assert.deepEqual(findRemoteCodeInDir(dir), [{ file: 'a.js', found: ['https://unpkg.com/a', 'https://unpkg.com/b'] }]);
});

test('manifest CSP: outside script sources are reported, package and wasm sources are not', () => {
  const csp = (policy: string) =>
    checkManifest(JSON.stringify({ content_security_policy: { extension_pages: policy } })).map((f) => f.match);
  assert.deepEqual(csp("script-src 'self' 'wasm-unsafe-eval'; object-src 'self'"), []);
  assert.deepEqual(csp("script-src 'self' https://cdn.example.com; object-src 'self'"), ['https://cdn.example.com']);
  assert.deepEqual(csp("default-src 'self' https:"), ['https:']);
  assert.deepEqual(csp("script-src 'self' 'unsafe-eval'"), ["'unsafe-eval'"]);
  assert.deepEqual(csp("script-src 'self' http://localhost:8080"), []);
  assert.deepEqual(checkManifest(JSON.stringify({ content_security_policy: "script-src 'self' https://x.io" })).length, 1);
  assert.deepEqual(checkManifest('{ not json'), []);
});

test('only the shallowest manifest.json is read as the manifest', () => {
  const bad = JSON.stringify({ content_security_policy: { extension_pages: "script-src 'self' https://x.io" } });
  const dir = tempDir({ 'manifest.json': MANIFEST, 'sub/manifest.json': bad });
  assert.equal(scanPath(dir).findings.length, 0);
});

test('globs', () => {
  assert.ok(globToRegExp('*.map').test('a/b/c.js.map'));
  assert.ok(globToRegExp('vendor/**').test('vendor/a/b.js'));
  assert.ok(globToRegExp('**/x.js').test('x.js'));
  assert.ok(!globToRegExp('vendor/*.js').test('vendor/a/b.js'));
});

test('dynamic code in script files is a warning, kept apart from the findings', () => {
  const dir = tempDir({
    'manifest.json': MANIFEST,
    'bg.js': 'eval(code)',
    'lib/a.mjs': 'x="https://unpkg.com/a"; new Function(src)',
    'vendor/v.js': 'eval(v)',
    'page.html': '<p>eval(x) in prose</p>',
  });
  const { findings, warnings } = scanPath(dir, { exclude: ['vendor/**'] });
  assert.deepEqual(
    findings.map((f) => [f.file, f.rule]),
    [['lib/a.mjs', 'cdn-address']]
  );
  assert.deepEqual(warnings.map((f) => [f.file, f.rule, f.match, f.line, f.column]).sort(), [
    ['bg.js', 'dynamic-code', 'eval(code)', 1, 1],
    ['lib/a.mjs', 'dynamic-code', 'new Function(src)', 1, 26],
  ]);
  assert.deepEqual(scanPath(dir, { allow: ['eval(code)'], exclude: ['vendor/**'] }).warnings.length, 1);
  assert.deepEqual(findRemoteCodeInDir(tempDir({ 'a.js': 'eval(x)' })), []);
});
