import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { main } from '../src/cli.ts';
import { KNOWN_SDKS, findRemoteCode, hintFor, scanPath, type NpmPackage, type ScanResult } from '../src/index.ts';

// test/fixtures/sdks holds esbuild output of one small project whose src/background.js imports
// stand-ins named and laid out like the real packages, each with the address the real one names:
// @amplitude/plugin-autocapture-browser (lib/esm), @firebase/auth (dist/esm), mixpanel-browser
// (dist/mixpanel.module.js, the 2.52 recorder address) and captcha-wrapper (a reCAPTCHA address
// that is not Firebase's), then an address of its own. popup.html loads gtag.js. Made with esbuild 0.25:
//   esbuild src/background.js --bundle --format=iife --minify --sourcemap --outfile=map/background.js
//   esbuild src/background.js --bundle --format=iife --outfile=plain/background.js
const SDKS = path.join(import.meta.dirname, 'fixtures', 'sdks');

const pkg = (name: string, source = `../../node_modules/${name}/index.js`): NpmPackage => ({ name, via: 'source-map', source });

function run(args: string[]) {
  let out = '';
  const code = main(args, { out: (s) => (out += s), err: () => {} });
  return { code, out };
}

/** Each finding's address (cut to its host and path start) and the SDK its hint names. */
function hints(dir: string) {
  return scanPath(dir).findings.map((f) => [f.match.replace(/^.*?\/\/([^/]+\/[^/?]*).*$/, '$1'), f.hint?.sdk]);
}

test('hintFor: an address of a known SDK from its own package', () => {
  const amplitude = 'https://cdn.amplitude.com/libs/visual-tagging-selector-1.0.0-alpha.js.gz';
  assert.equal(hintFor(amplitude, pkg('@amplitude/plugin-autocapture-browser'))?.sdk, 'Amplitude Browser SDK');
  assert.equal(
    hintFor('https://cdn.amplitude.com/libs/background-capture-1.1.0.js.gz', pkg('@amplitude/analytics-core'))?.sdk,
    'Amplitude Browser SDK'
  );
  assert.equal(hintFor('https://apis.google.com/js/api.js', pkg('@firebase/auth'))?.sdk, 'Firebase Authentication');
  assert.equal(hintFor('https://www.google.com/recaptcha/enterprise.js?render=', pkg('@firebase/app'))?.sdk, 'Firebase Authentication');
  assert.equal(hintFor('https://cdn.mxpnl.com/libs/mixpanel-recorder.min.js', pkg('mixpanel-browser'))?.sdk, 'Mixpanel');
  const gtag = '<script async src="https://www.googletagmanager.com/gtag/js?id=G-1';
  assert.equal(hintFor(gtag)?.sdk, 'Google Analytics');
  assert.equal(hintFor('https://www.google-analytics.com/analytics.js', pkg('some-ga-wrapper'))?.sdk, 'Google Analytics');
});

test('hintFor: no hint where the advice would not fit', () => {
  // the address is the SDK's own, but another package names it
  const tagging = 'https://cdn.amplitude.com/libs/visual-tagging-selector-1.0.0-alpha.js.gz';
  assert.equal(hintFor(tagging, pkg('amplitude-wrapper')), undefined);
  // an Amplitude package or script the lite build was not checked to leave out
  assert.equal(hintFor(tagging, pkg('@amplitude/plugin-session-replay-browser')), undefined);
  assert.equal(hintFor('https://cdn.amplitude.com/libs/analytics-browser-2.50.0-min.js.gz'), undefined);
  assert.equal(hintFor(tagging)?.sdk, 'Amplitude Browser SDK');
  // reCAPTCHA and gapi are used by more than Firebase: without the package, no guess
  assert.equal(hintFor('https://www.google.com/recaptcha/api.js'), undefined);
  assert.equal(hintFor('https://www.google.com/recaptcha/api.js', pkg('captcha-wrapper')), undefined);
  // from Firebase's web-extension build already
  const ext = pkg('@firebase/auth', '../../node_modules/@firebase/auth/dist/web-extension-esm/internal.js');
  assert.equal(hintFor('https://apis.google.com/js/api.js', ext), undefined);
  // an address of Amplitude or Mixpanel names the SDK by itself
  assert.equal(hintFor('https://cdn.mxpnl.com/libs/mixpanel-2-latest.min.js')?.sdk, 'Mixpanel');
  assert.equal(hintFor('https://example.com/lib.js'), undefined);
});

test('every hint links a page to read, and the list itself names no remote code', () => {
  for (const { sdk, text, url } of KNOWN_SDKS) {
    assert.match(url, /^https:\/\/[^/]+\/\S*$/, sdk);
    assert.doesNotMatch(url, /\.m?js(?:[?#]|$)/, sdk);
    assert.deepEqual(findRemoteCode(`${text} ${url}`), [], sdk);
  }
  // the built package is scanned by its users too
  assert.deepEqual(findRemoteCode(fs.readFileSync(path.join(import.meta.dirname, '..', 'src', 'known-sdks.ts'), 'utf8')), []);
});

test('a bundle with known SDKs: a hint on each of their findings, by source map or bundler comment', () => {
  const expected = [
    ['cdn.amplitude.com/libs', 'Amplitude Browser SDK'],
    ['apis.google.com/js', 'Firebase Authentication'],
    ['www.google.com/recaptcha', 'Firebase Authentication'],
    ['www.google.com/recaptcha', 'Firebase Authentication'],
    ['cdn.mxpnl.com/libs', 'Mixpanel'],
    ['www.google.com/recaptcha', undefined],
    ['example.com/own.js', undefined],
    ['www.googletagmanager.com/gtag', 'Google Analytics'],
  ];
  assert.deepEqual(hints(path.join(SDKS, 'map')), expected);
  assert.deepEqual(hints(path.join(SDKS, 'plain')), expected);
});

test('the hint in text, json, github, markdown and sarif; the exit code stays the same', () => {
  const dir = path.join(SDKS, 'map');
  const text = run([dir]);
  assert.equal(text.code, 1);
  assert.match(
    text.out,
    /alpha\.js\.gz {2}\(script file on another host\)\n {6}from npm package @amplitude\/plugin-autocapture-browser via source map\n {6}fix: Amplitude Browser SDK: Import from '@amplitude\/analytics-browser\/lite' [^\n]+ See https:\/\/amplitude\.com\/docs\/\S+\n/
  );
  assert.match(text.out, /own\.js {2}\(script file on another host\)\n {2}popup/);

  const json = JSON.parse(run([dir, '--format', 'json']).out) as ScanResult;
  assert.deepEqual(json.findings[1]?.hint, {
    sdk: 'Firebase Authentication',
    text:
      "Import from 'firebase/auth/web-extension' instead of 'firebase/auth' (Firebase 10.8.0 or later). " +
      'Popup, redirect and reCAPTCHA sign-in then need an offscreen document.',
    url: 'https://firebase.google.com/docs/auth/web/chrome-extension',
  });
  assert.equal(json.findings[5]?.hint, undefined);

  assert.match(
    run([dir, '--format', 'github']).out,
    /^::error [^\n]*::[^\n]*mixpanel-recorder\.min\.js \(from npm package mixpanel-browser\)\. Fix: Mixpanel: [^\n]+$/m
  );

  const summary = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mv3rc-sdk-')), 'summary.md');
  run([dir, '--summary', summary]);
  assert.match(
    fs.readFileSync(summary, 'utf8'),
    /\| script tag naming another host<br>\*\*Fix \(Google Analytics\):\*\* Send events [^|]+ \[Docs\]\(https:\/\/developer\.chrome\.com\/\S+\) \| `<script/
  );

  const sarif = JSON.parse(run([dir, '--format', 'sarif']).out) as {
    runs: { results: { message: { text: string }; properties?: Record<string, string> }[] }[];
  };
  const results = sarif.runs[0]?.results ?? [];
  assert.equal(results[4]?.properties?.npmPackage, 'mixpanel-browser');
  assert.equal(results[4]?.properties?.fixSdk, 'Mixpanel');
  assert.equal(results[4]?.properties?.fixUrl, 'https://github.com/mixpanel/mixpanel-js#readme');
  assert.deepEqual(Object.keys(results[7]?.properties ?? {}), ['fixSdk', 'fixHint', 'fixUrl']);
  assert.match(results[7]?.message.text ?? '', /\. Fix: Google Analytics: /);
  assert.equal(results[6]?.properties, undefined);
});
