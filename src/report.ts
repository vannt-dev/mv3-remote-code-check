import type { Finding, ScanResult } from './scan.ts';

const RULE_TEXT: Record<Finding['rule'], string> = {
  'cdn-address': 'address on a script CDN',
  'remote-script-file': 'script file on another host',
  'script-tag': 'script tag naming another host',
  'script-tag-built': 'script tag whose address is built at run time',
  'manifest-csp': 'content security policy allows outside scripts',
  'dynamic-code': 'dynamic code evaluation',
};

/** How a dynamic-code warning is reported: a warning, or an error with --fail-on-dynamic-code. */
export type DynamicLevel = 'warning' | 'error';

const DYNAMIC_TEXT = 'dynamic code, which the MV3 content security policy blocks in extension pages';
const DYNAMIC_TITLE = 'Dynamic code: eval, new Function or a string timer, blocked by the MV3 CSP';

const where = (f: Finding) => `${f.file}${f.line ? `:${f.line}:${f.column}` : ''}`;
const shorten = (text: string, max = 160) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

export function formatText(target: string, { files, findings, warnings }: ScanResult, level: DynamicLevel = 'warning'): string {
  const list = (items: Finding[]) => items.map((f) => `  ${where(f)}  ${shorten(f.match)}  (${RULE_TEXT[f.rule]})\n`).join('');
  let text = findings.length
    ? `${target}: ${findings.length} reference(s) to remotely hosted code, which Manifest V3 forbids\n${list(findings)}`
    : `${target}: no remotely hosted code in ${files} files\n`;
  if (warnings.length) text += `${target}: ${warnings.length} ${level}(s): ${DYNAMIC_TEXT}\n${list(warnings)}`;
  return text;
}

/** One path: one JSON object. Several: one array of them, so the output stays a single JSON value. */
export function formatJson(scans: { target: string; result: ScanResult }[]): string {
  const reports = scans.map(({ target, result }) => ({ target, ...result }));
  return `${JSON.stringify(reports.length === 1 ? reports[0] : reports, null, 2)}\n`;
}

/**
 * GitHub workflow commands. `fileRoot` is the scanned folder's path from the repository root, so
 * an annotation lands on the file; for an archive there is no such file (null) and the target is
 * named in the message instead.
 */
export function formatGithub(target: string, result: ScanResult, fileRoot: string | null, level: DynamicLevel = 'warning'): string {
  const annotate = (command: DynamicLevel, title?: string) => (f: Finding) => {
    const props: string[] = [];
    if (fileRoot !== null) {
      props.push(`file=${escapeProperty(joinPath(fileRoot, f.file))}`);
      if (f.line) props.push(`line=${f.line}`, `col=${f.column}`);
    }
    props.push(`title=${escapeProperty(title ?? `Remote code: ${RULE_TEXT[f.rule]}`)}`);
    const place = fileRoot === null ? `${target}!/${where(f)}: ` : '';
    return `::${command} ${props.join(',')}::${escapeData(`${place}${shorten(f.match, 300)}`)}`;
  };
  const out = [...result.findings.map(annotate('error')), ...result.warnings.map(annotate(level, DYNAMIC_TITLE))];
  out.push(formatText(target, result, level).trimEnd());
  return `${out.join('\n')}\n`;
}

/**
 * One SARIF 2.1.0 log for every path, for GitHub code scanning (github/codeql-action/upload-sarif).
 * `root` is the path from the repository root; a folder's findings point at its files, an archive's
 * at the archive itself, with the file inside it named in the message.
 */
export function formatSarif(
  scans: { target: string; result: ScanResult; root: string; isDir: boolean }[],
  version: string,
  level: DynamicLevel = 'warning'
): string {
  const rules = Object.entries(RULE_TEXT).map(([id, text]) =>
    id === 'dynamic-code'
      ? {
          id,
          name: id,
          shortDescription: { text: `Dynamic code: ${text}` },
          fullDescription: {
            text:
              'The Manifest V3 content security policy of extension pages blocks eval, new Function and a ' +
              'string given to setTimeout or setInterval; such code throws when it runs.',
          },
          defaultConfiguration: { level: 'warning' },
        }
      : {
          id,
          name: id,
          shortDescription: { text: `Remote code: ${text}` },
          fullDescription: { text: `Manifest V3 forbids remotely hosted code; the Chrome Web Store rejects a package with a ${text}.` },
          defaultConfiguration: { level: 'error' },
        }
  );
  const results = scans.flatMap(({ target, result, root, isDir }) =>
    [...result.findings, ...result.warnings].map((f) => {
      const uri = isDir ? joinPath(root, f.file) : joinPath(root, '').replace(/\/$/, '');
      const place = isDir ? '' : `${where(f)} in ${target}: `;
      return {
        ruleId: f.rule,
        level: f.rule === 'dynamic-code' ? level : 'error',
        message: { text: `${place}${shorten(f.match, 300)} (${RULE_TEXT[f.rule]})` },
        locations: [
          {
            physicalLocation: {
              artifactLocation: { uri },
              ...(isDir && f.line ? { region: { startLine: f.line, startColumn: f.column } } : {}),
            },
          },
        ],
      };
    })
  );
  const log = {
    $schema: 'https://json.schemastore.org/sarif-2.1.0.json',
    version: '2.1.0',
    runs: [
      {
        tool: {
          driver: {
            name: 'mv3-remote-code-check',
            version,
            informationUri: 'https://github.com/vannt-dev/mv3-remote-code-check',
            rules,
          },
        },
        results,
      },
    ],
  };
  return `${JSON.stringify(log, null, 2)}\n`;
}

export function formatMarkdown(target: string, { files, findings, warnings }: ScanResult, level: DynamicLevel = 'warning'): string {
  const table = (items: Finding[]) =>
    '| Where | What | Found |\n| --- | --- | --- |\n' +
    items.map((f) => `| \`${where(f)}\` | ${RULE_TEXT[f.rule]} | \`${shorten(f.match, 120).replaceAll('|', '\\|')}\` |\n`).join('');
  let text = findings.length
    ? `### Remote code check\n\n\`${target}\`: **${findings.length}** reference(s) to remotely hosted code, ` +
      `which Manifest V3 forbids.\n\n${table(findings)}`
    : `### Remote code check\n\n\`${target}\`: no remotely hosted code in ${files} files.\n`;
  if (warnings.length) text += `\n\`${target}\`: **${warnings.length}** ${level}(s): ${DYNAMIC_TEXT}.\n\n${table(warnings)}`;
  return text;
}

export function joinPath(root: string, file: string): string {
  const clean = root
    .replace(/\\/g, '/')
    // A leading ./ or a lone . only: a leading .. is part of the path.
    .replace(/^\.(\/|$)/, '')
    .replace(/\/$/, '');
  return clean ? `${clean}/${file}` : file;
}

const escapeData = (s: string) => s.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
const escapeProperty = (s: string) => escapeData(s).replace(/:/g, '%3A').replace(/,/g, '%2C');
