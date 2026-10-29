/**
 * Manifest V3's content security policy for extension pages has no 'unsafe-eval', and an
 * extension cannot add it: `eval`, `new Function` and a string given to `setTimeout` /
 * `setInterval` throw when they run. This is not remotely hosted code, so it is reported as a
 * warning of its own.
 *
 * The text is read with string, comment and regular expression contents blanked out, so words
 * in them are not taken for code. That pass is a small tokenizer, not a parser: it tells a
 * regular expression from a division by the token before the slash, which is right for the code
 * bundlers and minifiers write, and can be wrong in rare hand-written cases.
 */
import { lineStartsOf, position, type Located } from './patterns.ts';

// After these words a slash starts a regular expression; after any other word it divides.
const BEFORE_REGEX = new Set([
  'return',
  'typeof',
  'instanceof',
  'in',
  'of',
  'new',
  'delete',
  'void',
  'throw',
  'case',
  'do',
  'else',
  'yield',
  'await',
]);

const isWordChar = (c: number) => (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 36 || c === 95 || c > 127;

/**
 * The code with the contents of strings, template text, regular expressions and comments turned
 * into spaces. Quotes, `${`, `}` and line breaks stay, so offsets and lines are those of the code.
 */
export function maskStringsAndComments(code: string): string {
  const parts: string[] = [];
  let kept = 0;
  const blank = (from: number, to: number) => {
    if (to <= from) return;
    parts.push(code.slice(kept, from), code.slice(from, to).replace(/[^\n]/g, ' '));
    kept = to;
  };
  // For each template literal whose `${` we are inside, the depth of braces opened since.
  const braces: number[] = [];
  const n = code.length;

  // From the start of template text to the closing backtick or the next `${`.
  const template = (start: number): number => {
    let j = start;
    while (j < n) {
      const c = code[j];
      if (c === '\\') j += 2;
      else if (c === '`') {
        blank(start, j);
        return j + 1;
      } else if (c === '$' && code[j + 1] === '{') {
        blank(start, j);
        braces.push(0);
        return j + 2;
      } else j++;
    }
    blank(start, n);
    return n;
  };

  let regexOk = true;
  let i = 0;
  while (i < n) {
    const c = code[i] as string;
    const next = code[i + 1];
    if (c === '/' && next === '/') {
      const end = code.indexOf('\n', i);
      const to = end === -1 ? n : end;
      blank(i, to);
      i = to;
    } else if (c === '/' && next === '*') {
      const end = code.indexOf('*/', i + 2);
      const to = end === -1 ? n : end + 2;
      blank(i, to);
      i = to;
    } else if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < n && code[j] !== c && code[j] !== '\n') j += code[j] === '\\' ? 2 : 1;
      blank(i + 1, Math.min(j, n));
      i = j + 1;
      regexOk = false;
    } else if (c === '`') {
      i = template(i + 1);
      regexOk = false;
    } else if (c === '/' && regexOk) {
      let j = i + 1;
      let inClass = false;
      while (j < n && code[j] !== '\n') {
        const r = code[j];
        if (r === '\\') j++;
        else if (r === '[') inClass = true;
        else if (r === ']') inClass = false;
        else if (r === '/' && !inClass) break;
        j++;
      }
      if (code[j] === '/') {
        blank(i + 1, j);
        i = j + 1;
        regexOk = false;
      } else {
        i++;
      }
    } else if (isWordChar(c.charCodeAt(0))) {
      let j = i + 1;
      while (j < n && isWordChar(code.charCodeAt(j))) j++;
      regexOk = BEFORE_REGEX.has(code.slice(i, j));
      i = j;
    } else if (c === '{' || c === '}') {
      const depth = braces.length ? (braces[braces.length - 1] as number) : -1;
      if (c === '}' && depth === 0) {
        braces.pop();
        i = template(i + 1);
        regexOk = false;
        continue;
      }
      if (depth >= 0) braces[braces.length - 1] = depth + (c === '{' ? 1 : -1);
      regexOk = true;
      i++;
    } else {
      if (c === ')' || c === ']') regexOk = false;
      else if (!/\s/.test(c)) regexOk = true;
      i++;
    }
  }
  parts.push(code.slice(kept));
  return parts.join('');
}

// `eval` and the timers count bare or on window / self / globalThis, never on another object.
const GLOBAL = '(?:(?:window|self|globalThis)\\s*\\.\\s*)?';
const DYNAMIC_CODE = new RegExp(
  `(?<![\\w$.])(?:${GLOBAL}(eval)\\s*\\(|new\\s+Function\\s*\\(|${GLOBAL}set(?:Timeout|Interval)\\s*\\(\\s*["'\`])`,
  'g'
);

// How far to look for the closing parenthesis of a call when quoting it.
const CALL_LENGTH = 200;

/** Every `eval(…)`, `new Function(…)` and `setTimeout` / `setInterval` given a string, in order. */
export function locateDynamicCode(code: string): Located[] {
  const masked = maskStringsAndComments(code);
  const found: Located[] = [];
  let lineStarts: number[] | undefined;
  for (const m of masked.matchAll(DYNAMIC_CODE)) {
    const open = masked.indexOf('(', m.index);
    const close = closingParen(masked, open);
    // `eval(x) {` is a method or function named eval, not a call.
    if (m[1] && close !== -1 && /^\s*\{/.test(masked.slice(close + 1, close + 1 + CALL_LENGTH))) continue;
    const end = close !== -1 && close - m.index < CALL_LENGTH ? close + 1 : m.index + m[0].length;
    lineStarts ??= lineStartsOf(code);
    const { line, column } = position(lineStarts, m.index);
    found.push({ match: code.slice(m.index, end), rule: 'dynamic-code', index: m.index, line, column });
  }
  return found;
}

function closingParen(masked: string, open: number): number {
  let depth = 0;
  const stop = Math.min(masked.length, open + CALL_LENGTH * 10);
  for (let i = open; i < stop; i++) {
    const c = masked[i];
    if (c === '(') depth++;
    else if (c === ')' && --depth === 0) return i;
  }
  return -1;
}
