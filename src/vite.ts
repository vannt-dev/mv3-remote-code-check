import path from 'node:path';
import { stripRemoteCode } from './patterns.ts';
import { findRemoteCodeInDir, type ScanOptions } from './scan.ts';

export interface RemoteCodeGuardOptions extends ScanOptions {
  /** Take addresses on script CDNs out of every chunk. Default true. */
  strip?: boolean;
  /** With strip, turn jsPDF's `output('pdfobjectnewwindow')` branch into a throw. Default true. */
  jspdf?: boolean;
  /** After the bundle is written, read the whole output folder and fail on remote code. Default true. */
  check?: boolean;
}

/** The part of Rollup's / Vite's plugin type this plugin uses, so it needs neither as a dependency. */
export interface RemoteCodeGuardPlugin {
  name: string;
  renderChunk(code: string): { code: string; map: null } | null;
  writeBundle: {
    sequential: true;
    order: 'post';
    handler(outputOptions: { dir?: string; file?: string }): void;
  };
}

/**
 * A Vite / Rollup plugin for an extension build. Place it last among the plugins so its check
 * sees what the others wrote (copied workers, wasm, vendored scripts).
 */
export function remoteCodeGuard({
  strip = true,
  jspdf = true,
  check = true,
  allow,
  exclude,
}: RemoteCodeGuardOptions = {}): RemoteCodeGuardPlugin {
  const scan: ScanOptions = {};
  if (allow) scan.allow = allow;
  if (exclude) scan.exclude = exclude;
  return {
    name: 'mv3-remote-code-guard',
    renderChunk(code) {
      if (!strip) return null;
      const stripped = stripRemoteCode(code, { jspdf });
      return stripped === code ? null : { code: stripped, map: null };
    },
    writeBundle: {
      sequential: true,
      order: 'post',
      handler(outputOptions) {
        if (!check) return;
        const dir = outputOptions.dir ?? (outputOptions.file ? path.dirname(outputOptions.file) : 'dist');
        const offenders = findRemoteCodeInDir(dir, scan);
        if (offenders.length) {
          throw new Error(
            'The package names remotely hosted code, which Manifest V3 forbids:\n' +
              offenders.map(({ file, found }) => `  - ${file}: ${found.join(', ')}`).join('\n')
          );
        }
      },
    },
  };
}
