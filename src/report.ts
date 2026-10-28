import type { Finding, ScanResult } from './scan.ts';

const RULE_TEXT: Record<Finding['rule'], string> = {
  'cdn-address': 'address on a script CDN',
  'remote-script-file': 'script file on another host',
  'script-tag': 'script tag naming another host',
  'script-tag-built': 'script tag whose address is built at run time',
  'manifest-csp': 'content security policy allows outside scripts',
};

const where = (f: Finding) => `${f.file}${f.line ? `:${f.line}:${f.column}` : ''}`;
const shorten = (text: string, max = 160) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

export function formatText(target: string, { files, findings }: ScanResult): string {
  if (!findings.length) return `${target}: no remotely hosted code in ${files} files\n`;
  const lines = findings.map((f) => `  ${where(f)}  ${shorten(f.match)}  (${RULE_TEXT[f.rule]})`);
  return `${target}: ${findings.length} reference(s) to remotely hosted code, which Manifest V3 forbids\n${lines.join('\n')}\n`;
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
export function formatGithub(target: string, result: ScanResult, fileRoot: string | null): string {
  const out = result.findings.map((f) => {
    const props: string[] = [];
    if (fileRoot !== null) {
      props.push(`file=${escapeProperty(joinPath(fileRoot, f.file))}`);
      if (f.line) props.push(`line=${f.line}`, `col=${f.column}`);
    }
    props.push(`title=${escapeProperty(`Remote code: ${RULE_TEXT[f.rule]}`)}`);
    const place = fileRoot === null ? `${target}!/${where(f)}: ` : '';
    return `::error ${props.join(',')}::${escapeData(`${place}${shorten(f.match, 300)}`)}`;
  });
  out.push(formatText(target, result).trimEnd());
  return `${out.join('\n')}\n`;
}

/**
 * One SARIF 2.1.0 log for every path, for GitHub code scanning (github/codeql-action/upload-sarif).
 * `root` is the path from the repository root; a folder's findings point at its files, an archive's
 * at the archive itself, with the file inside it named in the message.
 */
export function formatSarif(scans: { target: string; result: ScanResult; root: string; isDir: boolean }[], version: string): string {
  const rules = Object.entries(RULE_TEXT).map(([id, text]) => ({
    id,
    name: id,
    shortDescription: { text: `Remote code: ${text}` },
    fullDescription: { text: `Manifest V3 forbids remotely hosted code; the Chrome Web Store rejects a package with a ${text}.` },
    defaultConfiguration: { level: 'error' },
  }));
  const results = scans.flatMap(({ target, result, root, isDir }) =>
    result.findings.map((f) => {
      const uri = isDir ? joinPath(root, f.file) : joinPath(root, '').replace(/\/$/, '');
      const place = isDir ? '' : `${where(f)} in ${target}: `;
      return {
        ruleId: f.rule,
        level: 'error',
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

export function formatMarkdown(target: string, { files, findings }: ScanResult): string {
  if (!findings.length) return `### Remote code check\n\n\`${target}\`: no remotely hosted code in ${files} files.\n`;
  const rows = findings.map((f) => `| \`${where(f)}\` | ${RULE_TEXT[f.rule]} | \`${shorten(f.match, 120).replaceAll('|', '\\|')}\` |`);
  return (
    `### Remote code check\n\n\`${target}\`: **${findings.length}** reference(s) to remotely hosted code, ` +
    `which Manifest V3 forbids.\n\n| Where | What | Found |\n| --- | --- | --- |\n${rows.join('\n')}\n`
  );
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
