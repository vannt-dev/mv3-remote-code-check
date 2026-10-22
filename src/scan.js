import fs from 'node:fs';
import path from 'node:path';
import { locateRemoteCode } from './patterns.js';
import { checkManifest } from './manifest.js';
import { zipEntries } from './zip.js';

/** Files the review reads as code or as markup that can load code. */
export const SCANNED = /\.(?:m?js|cjs|html?|css|json|svg|xhtml)$/i;

/**
 * @typedef {{ file: string, line?: number, column?: number, match: string, rule: string, detail?: string }} Finding
 * @typedef {{ allow?: string[], exclude?: string[] }} ScanOptions
 */

/**
 * Scans an unpacked extension folder or a packed .zip / .crx.
 * @param {string} target
 * @param {ScanOptions} [options]
 * @returns {{ files: number, findings: Finding[] }}
 */
export function scanPath(target, options = {}) {
  const stat = fs.statSync(target);
  if (stat.isDirectory()) return scanFiles(dirFiles(target), options);
  return scanFiles(archiveFiles(fs.readFileSync(target)), options);
}

/**
 * The same over files already in memory: { name, read() } with '/'-separated names.
 * @param {{ name: string, read: () => Buffer | string }[]} files
 * @param {ScanOptions} [options]
 */
export function scanFiles(files, { allow = [], exclude = [] } = {}) {
  const excluded = exclude.map(globToRegExp);
  const allowed = (match) => allow.some((text) => match.includes(text));
  const manifestName = shallowestManifest(files.map((f) => f.name));
  const findings = [];
  let count = 0;
  for (const file of files) {
    if (!SCANNED.test(file.name) || excluded.some((re) => re.test(file.name))) continue;
    count++;
    const text = file.read().toString('utf8');
    for (const { match, rule, line, column } of locateRemoteCode(text)) {
      if (!allowed(match)) findings.push({ file: file.name, line, column, match, rule });
    }
    if (file.name === manifestName) {
      for (const finding of checkManifest(text)) {
        if (!allowed(finding.match)) findings.push({ file: file.name, ...finding });
      }
    }
  }
  return { files: count, findings };
}

/**
 * The files of a built folder that still name remotely hosted code, each with what was found.
 * Kept in the shape browser-extension's build used.
 * @param {string} dir
 * @param {ScanOptions} [options]
 * @returns {{ file: string, found: string[] }[]}
 */
export function findRemoteCodeInDir(dir, options) {
  const byFile = new Map();
  for (const { file, match } of scanPath(dir, options).findings) {
    if (!byFile.has(file)) byFile.set(file, []);
    byFile.get(file).push(match);
  }
  return [...byFile].map(([file, found]) => ({ file, found }));
}

function dirFiles(dir) {
  return fs
    .readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => {
      const full = path.join(entry.parentPath, entry.name);
      return { name: path.relative(dir, full).split(path.sep).join('/'), read: () => fs.readFileSync(full) };
    })
    .filter(({ name }) => !name.split('/').includes('node_modules'));
}

// A .crx is a ZIP behind a header; the ZIP reader finds its end record from the back either way,
// but its offsets count from the start of the ZIP part.
function archiveFiles(buffer) {
  if (buffer.toString('latin1', 0, 4) === 'Cr24') {
    const version = buffer.readUInt32LE(4);
    const start = version === 2 ? 16 + buffer.readUInt32LE(8) + buffer.readUInt32LE(12) : 12 + buffer.readUInt32LE(8);
    return zipEntries(buffer.subarray(start));
  }
  return zipEntries(buffer);
}

function shallowestManifest(names) {
  return names
    .filter((name) => name === 'manifest.json' || name.endsWith('/manifest.json'))
    .sort((a, b) => a.split('/').length - b.split('/').length)[0];
}

/** '*' is one path segment, '**' any number; a pattern without '/' matches a file name anywhere. */
export function globToRegExp(glob) {
  const body = glob
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*\//g, '')
    .replace(/\*\*/g, '')
    .replace(/\*/g, '[^/]*')
    .replace(/\?/g, '[^/]')
    .replace(//g, '(?:.*/)?')
    .replace(//g, '.*');
  return new RegExp(glob.includes('/') ? `^${body}$` : `(?:^|/)${body}$`);
}
