/**
 * Manifest V3 forbids remotely hosted code, and the Chrome Web Store checks that by reading the
 * package, not by running it: the address of a script on another host is a violation wherever it
 * stands, also in a branch of a library the extension never reaches.
 *
 * The patterns below find such addresses in source text. They grew out of a real rejection
 * (jsPDF's PDFObject address on cdnjs) and of tesseract.js, whose worker, core and language paths
 * default to jsDelivr.
 */

/** Hosts that exist to serve scripts: an address on one of them counts whatever its ending. */
export const SCRIPT_CDN_HOSTS = [
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
const RULES = [
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

/**
 * Every address of remotely hosted code in a piece of source text, in the order met.
 * @param {string} code
 * @returns {string[]}
 */
export function findRemoteCode(code) {
  return locateRemoteCode(code).map(({ match }) => match);
}

/**
 * The same, with where each one stands.
 * @param {string} code
 * @returns {{ match: string, rule: string, index: number, line: number, column: number }[]}
 */
export function locateRemoteCode(code) {
  const found = [];
  let lineStarts;
  for (const m of code.matchAll(REMOTE_CODE)) {
    const group = m.slice(1).findIndex((value) => value !== undefined);
    const match = m[0];
    if (group === 1 && SOURCE_PAGE.test(match)) continue;
    lineStarts ??= lineStartsOf(code);
    const { line, column } = position(lineStarts, m.index);
    found.push({ match, rule: RULES[group][0], index: m.index, line, column });
  }
  return found;
}

function lineStartsOf(code) {
  const starts = [0];
  for (let i = code.indexOf('\n'); i !== -1; i = code.indexOf('\n', i + 1)) starts.push(i + 1);
  return starts;
}

function position(starts, index) {
  let low = 0;
  let high = starts.length - 1;
  while (low < high) {
    const mid = (low + high + 1) >> 1;
    if (starts[mid] <= index) low = mid;
    else high = mid - 1;
  }
  return { line: low + 1, column: index - starts[low] + 1 };
}

// jsPDF 2's case, from its label to the label of the case after it. jsPDF 4 builds the address
// with createElement, which only the CDN pattern then sees.
const JSPDF_PDFOBJECT_CASE = /case\s*"pdfobjectnewwindow"\s*:[\s\S]*?(?=case\s*"pdfjsnewwindow"\s*:)/;

const JSPDF_PDFOBJECT_REFUSAL = 'case "pdfobjectnewwindow": throw new Error("The option pdfobjectnewwindow is not part of this build.");\n';

/**
 * Source text without addresses on script CDNs. The code that read a default from one of them is
 * left with an empty path, so a missing option fails instead of reaching for a CDN.
 *
 * With `jspdf` (on by default) jsPDF's `output('pdfobjectnewwindow')` branch, which writes a
 * script tag for PDFObject into a new window, becomes a throw.
 * @param {string} code
 * @param {{ jspdf?: boolean }} [options]
 * @returns {string}
 */
export function stripRemoteCode(code, { jspdf = true } = {}) {
  const out = jspdf ? code.replace(JSPDF_PDFOBJECT_CASE, JSPDF_PDFOBJECT_REFUSAL) : code;
  return out.replace(new RegExp(CDN_ADDRESS, 'gi'), '');
}
