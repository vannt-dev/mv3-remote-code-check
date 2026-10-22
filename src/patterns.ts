/**
 * Manifest V3 forbids remotely hosted code, and the Chrome Web Store checks that by reading the
 * package, not by running it: the address of a script on another host is a violation wherever it
 * stands, also in a branch of a library the extension never reaches.
 *
 * The patterns below find such addresses in source text. They grew out of a real rejection
 * (jsPDF's PDFObject address on cdnjs) and of tesseract.js, whose worker, core and language paths
 * default to jsDelivr.
 */

/** The kind of a finding. */
export type Rule = 'cdn-address' | 'remote-script-file' | 'script-tag' | 'script-tag-built' | 'manifest-csp';

/** One address of remotely hosted code in a piece of source text. */
export interface Located {
  match: string;
  rule: Rule;
  /** Offset in the text. */
  index: number;
  /** 1-based. */
  line: number;
  /** 1-based. */
  column: number;
}

/** Hosts that exist to serve scripts: an address on one of them counts whatever its ending. */
export const SCRIPT_CDN_HOSTS: readonly string[] = [
  'cdnjs.cloudflare.com',
  'cdn.jsdelivr.net',
  'fastly.jsdelivr.net',
  'gcore.jsdelivr.net',
  'unpkg.com',
  'esm.sh',
  'esm.run',
  'cdn.skypack.dev',
  'ga.jspm.io',
  'ajax.googleapis.com',
  'code.jquery.com',
  'stackpath.bootstrapcdn.com',
  'maxcdn.bootstrapcdn.com',
];

const HOSTS = SCRIPT_CDN_HOSTS.map((host) => host.replaceAll('.', '\\.')).join('|');

// What an address is made of inside source text: it ends at a quote, at white space, and at the
// `$` of a template literal, where the rest is put together when the code runs.
const URL_CHAR = '[^\\s"\'`<>\\\\$)]';

const CDN_ADDRESS = `(?:https?:)?//(?:${HOSTS})(?![\\w.-])${URL_CHAR}*`;

// The kinds of finding, in the order of the alternatives of REMOTE_CODE.
const RULES: readonly (readonly [Rule, string])[] = [
  ['cdn-address', CDN_ADDRESS],
  // A script or WebAssembly file on any host, with or without a query.
  ['remote-script-file', `https?://${URL_CHAR}+?\\.(?:m?js|wasm)(?:[?#]${URL_CHAR}*)?(?![\\w./-])`],
  // The same without a scheme, which only an address between quotes can be.
  ['remote-script-file', `(?<=["'\`])//[a-z0-9.-]+\\.[a-z]{2,}/${URL_CHAR}*?\\.(?:m?js|wasm)(?:[?#]${URL_CHAR}*)?(?![\\w./-])`],
  // A script tag that names another host.
  ['script-tag', `<script\\b[^>]*?\\ssrc\\s*=\\s*["']?(?:https?:)?//${URL_CHAR}*`],
  // A script tag whose address is put together when the code runs.
  ['script-tag-built', `<script\\b[^>]*?\\ssrc\\s*=\\s*\\\\?["']?["'\`]\\s*\\+`],
];

// Addresses on localhost count too: the review reads them like any other, so they are reported and
// left to --allow.
const REMOTE_CODE = new RegExp(RULES.map(([, source]) => `(${source})`).join('|'), 'gi');

// A page that shows a source file (a credit link in a library's comment) is HTML, not a script:
// github.com/<owner>/<repo>/blob/..., gitlab's /-/blob/, bitbucket's /src/. raw.githubusercontent.com
// and the like serve the file itself and still count.
const SOURCE_PAGE =
  /^https?:\/\/(?:github\.com\/[^/]+\/[^/]+\/(?:blob|tree|commit|issues|pull)\/|gitlab\.com\/.+?\/-\/(?:blob|tree)\/|bitbucket\.org\/[^/]+\/[^/]+\/src\/)/i;

/** Every address of remotely hosted code in a piece of source text, in the order met. */
export function findRemoteCode(code: string): string[] {
  return locateRemoteCode(code).map(({ match }) => match);
}

/** The same, with where each one stands. */
export function locateRemoteCode(code: string): Located[] {
  const found: Located[] = [];
  let lineStarts: number[] | undefined;
  for (const m of code.matchAll(REMOTE_CODE)) {
    const group = m.slice(1).findIndex((value) => value !== undefined);
    const match = m[0];
    const rule = RULES[group]?.[0];
    if (!rule) continue;
    if (group === 1 && SOURCE_PAGE.test(match)) continue;
    lineStarts ??= lineStartsOf(code);
    const { line, column } = position(lineStarts, m.index);
    found.push({ match, rule, index: m.index, line, column });
  }
  return found;
}

function lineStartsOf(code: string): number[] {
  const starts = [0];
  for (let i = code.indexOf('\n'); i !== -1; i = code.indexOf('\n', i + 1)) starts.push(i + 1);
  return starts;
}

function position(starts: number[], index: number): { line: number; column: number } {
  let low = 0;
  let high = starts.length - 1;
  while (low < high) {
    const mid = (low + high + 1) >> 1;
    if ((starts[mid] ?? 0) <= index) low = mid;
    else high = mid - 1;
  }
  return { line: low + 1, column: index - (starts[low] ?? 0) + 1 };
}

// jsPDF's case, from its label to the label of the case after it. jsPDF 4 still names the address
// in this branch; the CDN pattern also takes it out wherever else it stands.
const JSPDF_PDFOBJECT_CASE = /case\s*"pdfobjectnewwindow"\s*:[\s\S]*?(?=case\s*"pdfjsnewwindow"\s*:)/;

const JSPDF_PDFOBJECT_REFUSAL = 'case "pdfobjectnewwindow": throw new Error("The option pdfobjectnewwindow is not part of this build.");\n';

export interface StripOptions {
  /** Turn jsPDF's `output('pdfobjectnewwindow')` branch into a throw. Default true. */
  jspdf?: boolean;
}

/**
 * Source text without addresses on script CDNs. The code that read a default from one of them is
 * left with an empty path, so a missing option fails instead of reaching for a CDN.
 */
export function stripRemoteCode(code: string, { jspdf = true }: StripOptions = {}): string {
  const out = jspdf ? code.replace(JSPDF_PDFOBJECT_CASE, JSPDF_PDFOBJECT_REFUSAL) : code;
  return out.replace(new RegExp(CDN_ADDRESS, 'gi'), '');
}
