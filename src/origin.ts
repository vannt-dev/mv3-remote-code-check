/**
 * Which npm package a finding in a bundled file came from. A source map next to the file says it
 * for certain; without one, the module comments esbuild and webpack write into a bundle that is
 * not minified give a guess.
 */
import fs from 'node:fs';
import path from 'node:path';
import { parseSourceMap, type SourceMap } from './sourcemap.ts';
import type { PackageFile } from './zip.ts';

/** The npm package a finding came from. */
export interface NpmPackage {
  name: string;
  /** From a pnpm store path, or from the package's package.json when the scan can reach it. */
  version?: string;
  /** `source-map`: the file's source map names the package. `module-comment`: a bundler comment
   *  before the finding does, which is a guess. */
  via: 'source-map' | 'module-comment';
  /** The original file, as the source map or the comment names it. */
  source: string;
}

/**
 * The package a source path lies in: the innermost `node_modules/<name>` or
 * `node_modules/@scope/name`, with the version a pnpm path (`.pnpm/<name>@<version>/...`) gives.
 */
export function packageFromPath(source: string): { name: string; version?: string; dir: string } | undefined {
  const parts = source.replace(/\\/g, '/').split('/');
  const at = parts.lastIndexOf('node_modules');
  const first = parts[at + 1];
  if (at === -1 || !first || first.startsWith('.')) return undefined;
  const scoped = first.startsWith('@');
  const second = parts[at + 2];
  if (scoped && !second) return undefined;
  const name = scoped ? `${first}/${second}` : first;
  const dir = parts.slice(0, at + (scoped ? 3 : 2)).join('/');
  // pnpm: node_modules/.pnpm/<name with / as +>@<version>[_peers or (peers)]/node_modules/<name>
  const store = parts[at - 1];
  if (store && parts[at - 2] === '.pnpm') {
    const key = name.replace('/', '+');
    if (store.startsWith(`${key}@`)) {
      const version = store.slice(key.length + 1).split(/[_(]/)[0];
      if (version) return { name, version, dir };
    }
  }
  return { name, dir };
}

/** Finds the package of each finding in the files of one scan; maps and package.json are read once. */
export class OriginFinder {
  private readonly byName: Map<string, PackageFile>;
  private readonly versions = new Map<string, string | undefined>();

  constructor(files: readonly PackageFile[]) {
    this.byName = new Map(files.map((f) => [f.name, f]));
  }

  /** A function from a finding's offset, line and column (1-based) to its package. */
  forFile(file: PackageFile, text: string): (index: number, line: number, column: number) => NpmPackage | undefined {
    const found = this.mapOf(file, text);
    let markers: Marker[] | undefined;
    return (index, line, column) => {
      if (found) {
        const source = found.map.sourceAt(line - 1, column - 1);
        // What the map names is the answer, also when it is the extension's own code.
        if (source !== undefined) return this.describe(source, 'source-map', found.dir);
      }
      markers ??= moduleMarkers(text);
      const source = markerBefore(markers, index);
      return source === undefined ? undefined : this.describe(source, 'module-comment', file.path && path.dirname(file.path));
    };
  }

  private describe(source: string, via: NpmPackage['via'], dir: string | undefined): NpmPackage | undefined {
    const pkg = packageFromPath(source);
    if (!pkg) return undefined;
    const version = pkg.version ?? (dir ? this.versionOnDisk(pkg.name, pkg.dir, dir) : undefined);
    return { name: pkg.name, ...(version ? { version } : {}), via, source };
  }

  // The map named by the file's sourceMappingURL comment, else <file>.map; in the package first,
  // then on disk next to the file. `dir` is the map's folder on disk, if it has one.
  private mapOf(file: PackageFile, text: string): { map: SourceMap; dir?: string } | undefined {
    try {
      const url = mapUrl(text);
      if (url?.startsWith('data:')) {
        const comma = url.indexOf(',');
        const body = url.slice(comma + 1);
        const json = /;base64$/i.test(url.slice(0, comma)) ? Buffer.from(body, 'base64').toString('utf8') : decodeURIComponent(body);
        const map = parseSourceMap(json);
        return map && { map, ...(file.path ? { dir: path.dirname(file.path) } : {}) };
      }
      if (url && /^[a-z][\w+.-]+:/i.test(url)) return undefined;
      const relative = url ? decodeURI(url.replace(/[?#].*$/, '')) : `${path.posix.basename(file.name)}.map`;
      // An address that starts with / is from the root of the package.
      const fromRoot = relative.startsWith('/');
      const inPackage = fromRoot
        ? path.posix.normalize(relative.slice(1))
        : path.posix.normalize(path.posix.join(path.posix.dirname(file.name), relative));
      const entry = this.byName.get(inPackage);
      if (entry) {
        const map = parseSourceMap(entry.read().toString('utf8'));
        const dir = entry.path && path.dirname(entry.path);
        return map && { map, ...(dir ? { dir } : {}) };
      }
      if (!file.path || fromRoot) return undefined;
      const onDisk = path.resolve(path.dirname(file.path), relative);
      if (!fs.existsSync(onDisk)) return undefined;
      const map = parseSourceMap(fs.readFileSync(onDisk, 'utf8'));
      return map && { map, dir: path.dirname(onDisk) };
    } catch {
      return undefined;
    }
  }

  // The version in node_modules/<name>/package.json: at the path the source names when it is a
  // file path, else in the nearest node_modules above `dir` that holds the same package path.
  private versionOnDisk(name: string, pkgDir: string, dir: string): string | undefined {
    const key = `${dir}\0${pkgDir}`;
    if (this.versions.has(key)) return this.versions.get(key);
    const candidates: string[] = [];
    if (!/^[a-z][\w+.-]+:/i.test(pkgDir)) candidates.push(path.resolve(dir, pkgDir));
    const sub = pkgDir.slice(pkgDir.indexOf('node_modules/'));
    for (let current = path.resolve(dir); ; current = path.dirname(current)) {
      candidates.push(path.join(current, sub));
      if (path.dirname(current) === current) break;
    }
    let version: string | undefined;
    for (const candidate of candidates) {
      version = readVersion(path.join(candidate, 'package.json'), name);
      if (version) break;
    }
    this.versions.set(key, version);
    return version;
  }
}

function readVersion(file: string, name: string): string | undefined {
  try {
    const json = JSON.parse(fs.readFileSync(file, 'utf8')) as { name?: unknown; version?: unknown };
    return json.name === name && typeof json.version === 'string' ? json.version : undefined;
  } catch {
    return undefined;
  }
}

// The last `//# sourceMappingURL=` (or `//@`, or `/*# ... */` in CSS) that starts a line.
function mapUrl(text: string): string | undefined {
  let url: string | undefined;
  for (const m of text.matchAll(/^[ \t]*(?:\/\/|\/\*)[#@][ \t]*sourceMappingURL=([^\s'"*]+)/gm)) url = m[1];
  return url;
}

/** Where a module starts (its path) or where bundler code that is no module starts (null). */
interface Marker {
  index: number;
  source: string | null;
}

const MODULE_FILE = String.raw`[^\s"'*]+\.(?:[cm]?[jt]sx?|json|css|vue|svelte)`;

const MARKERS = new RegExp(
  [
    // esbuild: `// node_modules/x/index.js`; webpack's concatenated modules: `;// ./node_modules/x/index.js`
    String.raw`^[ \t]*;?\/\/ (?:CONCATENATED MODULE: )?(${MODULE_FILE})[ \t]*$`,
    // webpack: `/***/ "./node_modules/x/index.js"` and the banner `!*** ./node_modules/x/index.js ***!`
    String.raw`^\/\*\*\*\/ "(${MODULE_FILE})"`,
    String.raw`^[ \t]*!\*\*\* (${MODULE_FILE})(?: \+ \d+ modules?)? \*\*\*!`,
    // webpack: the end of a module, and its runtime
    String.raw`^(\/\*\*\*\/ \}|\/\*{6}\/)`,
  ].join('|'),
  'gm'
);

function moduleMarkers(text: string): Marker[] {
  const out: Marker[] = [];
  for (const m of text.matchAll(MARKERS)) {
    const source = m[1] ?? m[2] ?? m[3];
    const last = out[out.length - 1];
    // webpack writes the path twice (id, then banner): keep one marker
    if (source !== undefined && last?.source === source) continue;
    out.push({ index: m.index, source: source ?? null });
  }
  return out;
}

function markerBefore(markers: Marker[], index: number): string | undefined {
  let low = 0;
  let high = markers.length - 1;
  let found: Marker | undefined;
  while (low <= high) {
    const mid = (low + high) >> 1;
    const marker = markers[mid] as Marker;
    if (marker.index <= index) {
      found = marker;
      low = mid + 1;
    } else high = mid - 1;
  }
  return found?.source ?? undefined;
}
