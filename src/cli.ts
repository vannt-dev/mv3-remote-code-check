import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { ConfigError, FORMATS, findConfig, loadConfig, type Config, type Format } from './config.ts';
import { scanPath, type ScanResult } from './scan.ts';
import { formatGithub, formatJson, formatMarkdown, formatSarif, formatText } from './report.ts';

const USAGE = `usage: mv3-remote-code-check [<folder|.zip|.crx>...] [options]

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
  --no-fail-on-dynamic-code
                   keep dynamic code a warning, even when the config file says otherwise
  --config <file>  read the settings from this file instead of looking for one
  --no-config      do not read a config file
  -h, --help       show this help
  -v, --version    print the version

Settings can also live in mv3-remote-code-check.config.json, or under "mv3RemoteCodeCheck" in
package.json, looked for from the current folder up to the repository root: paths, allow,
exclude, format and failOnDynamicCode. Paths in it are read from the config file's folder.
Paths and flags given here replace the config's values; --allow and --exclude add to its lists.
`;

export interface Io {
  out?: (s: string) => void;
  err?: (s: string) => void;
  /** The folder to run in: where the config file is looked for and relative paths start. */
  cwd?: string;
}

/** Runs the command line; returns the exit code (0 clean, 1 found, 2 usage, config or read error). */
export function main(argv: string[], io: Io = {}): number {
  const out = io.out ?? ((s: string) => void process.stdout.write(s));
  const err = io.err ?? ((s: string) => void process.stderr.write(s));
  const cwd = io.cwd ?? process.cwd();
  let args;
  try {
    args = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        // no defaults: a flag that is not given leaves the config file's value in place
        format: { type: 'string' },
        allow: { type: 'string', multiple: true },
        exclude: { type: 'string', multiple: true },
        summary: { type: 'string' },
        'fail-on-dynamic-code': { type: 'boolean' },
        'no-fail-on-dynamic-code': { type: 'boolean' },
        config: { type: 'string' },
        'no-config': { type: 'boolean' },
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
  if (values.format !== undefined && !FORMATS.includes(values.format as Format)) {
    err(`unknown --format ${values.format}: use text, json, github or sarif\n`);
    return 2;
  }
  if (values.config !== undefined && values['no-config']) {
    err('--config and --no-config cannot be used together\n');
    return 2;
  }
  if (values['fail-on-dynamic-code'] && values['no-fail-on-dynamic-code']) {
    err('--fail-on-dynamic-code and --no-fail-on-dynamic-code cannot be used together\n');
    return 2;
  }

  // CLI flags over the config file over the defaults; the allow and exclude lists add up.
  let config: Config = {};
  let configDir = cwd;
  if (!values['no-config']) {
    try {
      const loaded = values.config !== undefined ? loadConfig(path.resolve(cwd, values.config)) : findConfig(cwd);
      if (loaded) {
        config = loaded.config;
        configDir = path.dirname(loaded.file);
        for (const key of loaded.unknown) err(`${loaded.file}: unknown key "${key}" ignored\n`);
      }
    } catch (e) {
      if (!(e instanceof ConfigError)) throw e;
      err(`${e.message}\n`);
      return 2;
    }
  }
  const format = (values.format as Format | undefined) ?? config.format ?? 'text';
  const allow = [...(config.allow ?? []), ...(values.allow ?? [])];
  const exclude = [...(config.exclude ?? []), ...(values.exclude ?? [])];
  const strict = values['no-fail-on-dynamic-code'] ? false : (values['fail-on-dynamic-code'] ?? config.failOnDynamicCode ?? false);
  // a path from the config file is named from the current folder, as if it had been typed
  const targets = positionals.length ? positionals : (config.paths ?? []).map((p) => path.relative(cwd, path.resolve(configDir, p)) || '.');
  if (!targets.length) {
    err(USAGE);
    return 2;
  }
  const at = (target: string) => path.resolve(cwd, target);

  // Every path is read before anything is printed: a path that cannot be read stops the run
  // with no report at all, rather than after the reports of the paths before it.
  const scans: { target: string; result: ScanResult }[] = [];
  let unreadable = false;
  for (const target of targets) {
    try {
      scans.push({ target, result: scanPath(at(target), { allow, exclude }) });
    } catch (e) {
      err(`${target}: ${(e as Error).message}\n`);
      unreadable = true;
    }
  }
  if (unreadable) return 2;

  const level = strict ? 'error' : 'warning';
  const failed = scans.some(({ result }) => result.findings.length > 0 || (strict && result.warnings.length > 0));
  if (format === 'json') out(formatJson(scans));
  if (format === 'sarif') {
    const placed = scans.map((scan) => ({
      ...scan,
      root: path.relative(cwd, at(scan.target)),
      isDir: fs.statSync(at(scan.target)).isDirectory(),
    }));
    out(formatSarif(placed, version(), level));
  }
  for (const { target, result } of scans) {
    if (format === 'github') {
      const isDir = fs.statSync(at(target)).isDirectory();
      out(formatGithub(target, result, isDir ? path.relative(cwd, at(target)) : null, level));
    } else if (format === 'text') out(formatText(target, result, level));
  }
  const reports = scans.map(({ target, result }) => formatMarkdown(target, result, level));
  if (values.summary) fs.appendFileSync(path.resolve(cwd, values.summary), `${reports.join('\n')}\n`);
  return failed ? 1 : 0;
}
