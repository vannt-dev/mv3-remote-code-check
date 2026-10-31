/**
 * Just enough of Source Map v3 to say which original file a place in a generated file came from:
 * no names, no original positions, no indexed maps (`sections`). Kept here so the package stays
 * free of runtime dependencies.
 */

export interface SourceMap {
  /** The original file of a 0-based line and column of the generated file, as the map names it. */
  sourceAt(line: number, column: number): string | undefined;
}

const BASE64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const DIGIT = new Map([...BASE64].map((c, i) => [c, i]));

/** The map in a JSON text, or undefined when it is not a v3 map this module can read. */
export function parseSourceMap(text: string): SourceMap | undefined {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (typeof json !== 'object' || json === null) return undefined;
  const { version, sources, sourceRoot, mappings } = json as Record<string, unknown>;
  if (version !== 3 || !Array.isArray(sources) || typeof mappings !== 'string') return undefined;
  const root = typeof sourceRoot === 'string' && sourceRoot ? sourceRoot.replace(/\/?$/, '/') : '';
  const names = sources.map((s) => (typeof s === 'string' ? root + s : undefined));
  const lines = mappings.split(';');
  // Segments are decoded line by line, the first time a line is asked for; the source index runs
  // on from line to line, so every line before it is decoded too. Original lines and columns are
  // not needed, so they are not added up.
  const decoded: [column: number, source: number][][] = [];
  let source = 0;
  let broken = false;
  const decodeUpTo = (line: number) => {
    if (broken) return false;
    while (decoded.length <= line && decoded.length < lines.length) {
      const segments: [number, number][] = [];
      let column = 0;
      for (const segment of (lines[decoded.length] as string).split(',')) {
        if (!segment) continue;
        const fields = vlq(segment);
        if (!fields) {
          broken = true;
          return false;
        }
        column += fields[0] ?? 0;
        if (fields.length >= 4) {
          source += fields[1] as number;
          segments.push([column, source]);
        } else {
          // A segment with only a column: from here on the line maps to nothing.
          segments.push([column, -1]);
        }
      }
      segments.sort((a, b) => a[0] - b[0]);
      decoded.push(segments);
    }
    return true;
  };
  return {
    sourceAt(line, column) {
      if (line < 0 || !decodeUpTo(line)) return undefined;
      const segments = decoded[line] ?? [];
      let found: number | undefined;
      for (const [start, index] of segments) {
        if (start > column) break;
        found = index;
      }
      return found === undefined || found < 0 ? undefined : names[found];
    },
  };
}

// One segment's fields, each a base64 VLQ: 5 bits a digit, bit 6 says another digit follows, and the
// lowest bit of the number is its sign.
function vlq(segment: string): number[] | undefined {
  const out: number[] = [];
  let value = 0;
  let shift = 0;
  for (const c of segment) {
    const digit = DIGIT.get(c);
    if (digit === undefined) return undefined;
    value += (digit & 31) * 2 ** shift;
    if (digit & 32) {
      shift += 5;
      continue;
    }
    out.push(value % 2 ? -(value - 1) / 2 : value / 2);
    value = 0;
    shift = 0;
  }
  return shift === 0 ? out : undefined;
}
