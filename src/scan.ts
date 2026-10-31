import fs from 'node:fs';
import path from 'node:path';
import { locateRemoteCode, type Located, type Rule } from './patterns.ts';
import { checkManifest } from './manifest.ts';
import { locateDynamicCode } from './dynamic.ts';
import { zipEntries, type PackageFile } from './zip.ts';
import { OriginFinder, type NpmPackage } from './origin.ts';

/** Files the review reads as code or as markup that can load code. */
export const SCANNED = /\.(?:m?js|cjs|html?|css|json|svg|xhtml)$/i;

/** Files also read for dynamic code (eval and the like). */
export const SCRIPTS = /\.(?:m?js|cjs)$/i;

/** One reference to remotely hosted code in a package, or one warning. */
export interface Finding {
  /** '/'-separated path inside the package. */
  file: string;
  line?: number;
  column?: number;
  match: string;
  rule: Rule;
  detail?: string;
  /** The npm package the finding came from, when a source map or a bundler comment says so. */
  package?: NpmPackage;
}

export interface ScanOptions {
  /** Leave out findings that contain one of these texts. */
  allow?: readonly string[];
  /** Leave out files matching one of these globs (`*` one segment, `**` any number). */
  exclude?: readonly string[];
}

export interface ScanResult {
  /** How many files were read. */
  files: number;
  /** Remotely hosted code: what the Chrome Web Store rejects. */
  findings: Finding[];
  /** Dynamic code (rule `dynamic-code`): blocked by the MV3 content security policy at run time. */
  warnings: Finding[];
}

/** Scans an unpacked extension folder or a packed .zip / .crx. */
export function scanPath(target: string, options: ScanOptions = {}): ScanResult {
  const stat = fs.statSync(target);
  if (stat.isDirectory()) return scanFiles(dirFiles(target), options);
  return scanFiles(archiveFiles(fs.readFileSync(target)), options);
}

/** The same over files already in memory. */
export function scanFiles(files: readonly PackageFile[], { allow = [], exclude = [] }: ScanOptions = {}): ScanResult {
  const excluded = exclude.map(globToRegExp);
  const allowed = (match: string) => allow.some((text) => match.includes(text));
  const manifestName = shallowestManifest(files.map((f) => f.name));
  const findings: Finding[] = [];
  const warnings: Finding[] = [];
  const origins = new OriginFinder(files);
  let count = 0;
  for (const file of files) {
    if (!SCANNED.test(file.name) || excluded.some((re) => re.test(file.name))) continue;
    count++;
    const text = file.read().toString('utf8');
    let originOf: ReturnType<OriginFinder['forFile']> | undefined;
    const take = (into: Finding[], { match, rule, index, line, column }: Located) => {
      if (allowed(match)) return;
      originOf ??= origins.forFile(file, text);
      const pkg = originOf(index, line, column);
      into.push({ file: file.name, line, column, match, rule, ...(pkg ? { package: pkg } : {}) });
    };
    for (const located of locateRemoteCode(text)) take(findings, located);
    if (SCRIPTS.test(file.name)) {
      for (const located of locateDynamicCode(text)) take(warnings, located);
    }
    if (file.name === manifestName) {
      for (const finding of checkManifest(text)) {
        if (!allowed(finding.match)) findings.push({ file: file.name, ...finding });
      }
    }
  }
  return { files: count, findings, warnings };
}

/**
 * The files of a built folder that still name remotely hosted code, each with what was found.
 * Kept in the shape browser-extension's build used.
 */
export function findRemoteCodeInDir(dir: string, options?: ScanOptions): { file: string; found: string[] }[] {
  const byFile = new Map<string, string[]>();
  for (const { file, match } of scanPath(dir, options).findings) {
    const found = byFile.get(file) ?? [];
    found.push(match);
    byFile.set(file, found);
  }
  return [...byFile].map(([file, found]) => ({ file, found }));
}

function dirFiles(dir: string): PackageFile[] {
  return fs
    .readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => {
      const full = path.join(entry.parentPath, entry.name);
      return { name: path.relative(dir, full).split(path.sep).join('/'), read: () => fs.readFileSync(full), path: full };
    })
    .filter(({ name }) => !name.split('/').includes('node_modules'));
}

// A .crx is a ZIP behind a header; the ZIP's offsets count from the start of the ZIP part.
function archiveFiles(buffer: Buffer): PackageFile[] {
  if (buffer.toString('latin1', 0, 4) === 'Cr24') {
    const version = buffer.readUInt32LE(4);
    const start = version === 2 ? 16 + buffer.readUInt32LE(8) + buffer.readUInt32LE(12) : 12 + buffer.readUInt32LE(8);
    return zipEntries(buffer.subarray(start));
  }
  return zipEntries(buffer);
}

function shallowestManifest(names: string[]): string | undefined {
  return names
    .filter((name) => name === 'manifest.json' || name.endsWith('/manifest.json'))
    .sort((a, b) => a.split('/').length - b.split('/').length)[0];
}

/** '*' is one path segment, '**' any number; a pattern without '/' matches a file name anywhere. */
export function globToRegExp(glob: string): RegExp {
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
