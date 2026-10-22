import path from 'node:path';
import { stripRemoteCode } from './patterns.js';
import { findRemoteCodeInDir } from './scan.js';

/**
 * A Vite / Rollup plugin for an extension build:
 *
 *  - `strip` (default true): takes addresses on script CDNs out of every chunk, and with `jspdf`
 *    (default true) turns jsPDF's `output('pdfobjectnewwindow')` branch into a throw;
 *  - `check` (default true): when the bundle is written, reads the whole output folder (also the
 *    files other plugins copied there) and fails the build on any remote code left.
 *
 * Place it last among the plugins so its check sees what the others wrote.
 * @param {{ strip?: boolean, jspdf?: boolean, check?: boolean, allow?: string[], exclude?: string[] }} [options]
 */
export function remoteCodeGuard({ strip = true, jspdf = true, check = true, allow, exclude } = {}) {
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
        const offenders = findRemoteCodeInDir(dir, { allow, exclude });
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
