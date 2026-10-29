import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { scanPath, type ScanResult } from './scan.ts';
import { formatGithub, formatJson, formatMarkdown, formatSarif, formatText } from './report.ts';

const USAGE = `usage: mv3-remote-code-check <folder|.zip|.crx>... [options]

Reads a built browser extension the way the Chrome Web Store review does and lists every
reference to remotely hosted code (script addresses on other hosts, script tags naming them,
a content security policy that allows them). Exits 1 when it finds any.

It also warns about dynamic code in scripts (eval, new Function, a string given to setTimeout or
setInterval), which the MV3 content security policy blocks. A warning does not change the exit
code unless --fail-on-dynamic-code is given.

options:
  --format <f>     text (default), json, github (workflow annotations) or sarif (code scanning)
  --allow <text>   leave out findings that contain this text (repeatable)
  --exclude <glob> leave out files matching this glob, * one segment, ** any (repeatable)
  --summary <file> also write a Markdown report there (e.g. $GITHUB_STEP_SUMMARY)
  --fail-on-dynamic-code
                   exit 1 on dynamic code too, and report it as an error
  -h, --help       show this help
  -v, --version    print the version
`;

export interface Io {
  out?: (s: string) => void;
  err?: (s: string) => void;
}

/** Runs the command line; returns the exit code (0 clean, 1 found, 2 usage or read error). */
export function main(argv: string[], io: Io = {}): number {
  const out = io.out ?? ((s: string) => void process.stdout.write(s));
  const err = io.err ?? ((s: string) => void process.stderr.write(s));
  let args;
  try {
    args = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        format: { type: 'string', default: 'text' },
        allow: { type: 'string', multiple: true, default: [] },
        exclude: { type: 'string', multiple: true, default: [] },
        summary: { type: 'string' },
        'fail-on-dynamic-code': { type: 'boolean', default: false },
        help: { type: 'boolean', short: 'h' },
        version: { type: 'boolean', short: 'v' },
      },
    });
  } catch (e) {
    err(`${(e as Error).message}\n\n${USAGE}`);
    return 2;
  }
  const { values, positionals } = args;
  if (values.help) {
    out(USAGE);
    return 0;
  }
  const version = () => (JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }).version;
  if (values.version) {
    out(`${version()}\n`);
    return 0;
  }
  if (!['text', 'json', 'github', 'sarif'].includes(values.format)) {
    err(`unknown --format ${values.format}: use text, json, github or sarif\n`);
    return 2;
  }
  if (!positionals.length) {
    err(USAGE);
    return 2;
  }

  // Every path is read before anything is printed: a path that cannot be read stops the run
  // with no report at all, rather than after the reports of the paths before it.
  const scans: { target: string; result: ScanResult }[] = [];
  let unreadable = false;
  for (const target of positionals) {
    try {
      scans.push({ target, result: scanPath(target, { allow: values.allow, exclude: values.exclude }) });
    } catch (e) {
      err(`${target}: ${(e as Error).message}\n`);
      unreadable = true;
    }
  }
  if (unreadable) return 2;

  const strict = values['fail-on-dynamic-code'];
  const level = strict ? 'error' : 'warning';
  const failed = scans.some(({ result }) => result.findings.length > 0 || (strict && result.warnings.length > 0));
  if (values.format === 'json') out(formatJson(scans));
  if (values.format === 'sarif') {
    const placed = scans.map((scan) => ({
      ...scan,
      root: path.relative(process.cwd(), scan.target),
      isDir: fs.statSync(scan.target).isDirectory(),
    }));
    out(formatSarif(placed, version(), level));
  }
  for (const { target, result } of scans) {
    if (values.format === 'github') {
      const isDir = fs.statSync(target).isDirectory();
      out(formatGithub(target, result, isDir ? path.relative(process.cwd(), target) : null, level));
    } else if (values.format === 'text') out(formatText(target, result, level));
  }
  const reports = scans.map(({ target, result }) => formatMarkdown(target, result, level));
  if (values.summary) fs.appendFileSync(values.summary, `${reports.join('\n')}\n`);
  return failed ? 1 : 0;
}
