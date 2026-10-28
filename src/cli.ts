import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { scanPath, type ScanResult } from './scan.ts';
import { formatGithub, formatJson, formatMarkdown, formatText } from './report.ts';

const USAGE = `usage: mv3-remote-code-check <folder|.zip|.crx>... [options]

Reads a built browser extension the way the Chrome Web Store review does and lists every
reference to remotely hosted code (script addresses on other hosts, script tags naming them,
a content security policy that allows them). Exits 1 when it finds any.

options:
  --format <f>     text (default), json or github (workflow annotations)
  --allow <text>   leave out findings that contain this text (repeatable)
  --exclude <glob> leave out files matching this glob, * one segment, ** any (repeatable)
  --summary <file> also write a Markdown report there (e.g. $GITHUB_STEP_SUMMARY)
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
  if (values.version) {
    const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string };
    out(`${pkg.version}\n`);
    return 0;
  }
  if (!['text', 'json', 'github'].includes(values.format)) {
    err(`unknown --format ${values.format}: use text, json or github\n`);
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

  const failed = scans.some(({ result }) => result.findings.length > 0);
  if (values.format === 'json') out(formatJson(scans));
  for (const { target, result } of scans) {
    if (values.format === 'github') {
      const isDir = fs.statSync(target).isDirectory();
      out(formatGithub(target, result, isDir ? path.relative(process.cwd(), target) : null));
    } else if (values.format === 'text') out(formatText(target, result));
  }
  const reports = scans.map(({ target, result }) => formatMarkdown(target, result));
  if (values.summary) fs.appendFileSync(values.summary, `${reports.join('\n')}\n`);
  return failed ? 1 : 0;
}
