import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { scanPath } from './scan.js';
import { formatGithub, formatJson, formatMarkdown, formatText } from './report.js';

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

/**
 * @param {string[]} argv
 * @param {{ out?: (s: string) => void, err?: (s: string) => void }} [io]
 * @returns {number} the exit code
 */
export function main(argv, io = {}) {
  const out = io.out ?? ((s) => process.stdout.write(s));
  const err = io.err ?? ((s) => process.stderr.write(s));
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
    err(`${e.message}\n\n${USAGE}`);
    return 2;
  }
  const { values, positionals } = args;
  if (values.help) {
    out(USAGE);
    return 0;
  }
  if (values.version) {
    const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
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

  let failed = false;
  const reports = [];
  for (const target of positionals) {
    let result;
    try {
      result = scanPath(target, { allow: values.allow, exclude: values.exclude });
    } catch (e) {
      err(`${target}: ${e.message}\n`);
      return 2;
    }
    if (result.findings.length) failed = true;
    if (values.format === 'json') out(formatJson(target, result));
    else if (values.format === 'github') {
      const isDir = fs.statSync(target).isDirectory();
      out(formatGithub(target, result, isDir ? path.relative(process.cwd(), target) : null));
    } else out(formatText(target, result));
    reports.push(formatMarkdown(target, result));
  }
  if (values.summary) fs.appendFileSync(values.summary, `${reports.join('\n')}\n`);
  return failed ? 1 : 0;
}
