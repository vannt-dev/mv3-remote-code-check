/**
 * SDKs whose remote script addresses get extensions rejected by the Chrome Web Store, each with
 * the fix its makers document. A finding gets a hint when its address is one the SDK names and,
 * where the SDK is an npm package, when the finding comes from that package (or, for an address
 * only that SDK uses, when the scan could not tell the package).
 *
 * Each hint was checked against the SDK's own docs, README or changelog; the links are pages to
 * read, not scripts.
 */
import type { NpmPackage } from './origin.ts';

/** What to do about a finding that comes from a known SDK. */
export interface SdkHint {
  /** The SDK, as its makers name it. */
  sdk: string;
  /** The fix, in a sentence or two. */
  text: string;
  /** The page that documents the fix. */
  url: string;
}

/** One known SDK: where its addresses come from, and the fix. */
export interface KnownSdk extends SdkHint {
  /** The remote addresses the SDK names. */
  addresses: RegExp;
  /** The npm packages they come from; none for an SDK that is not installed from npm. */
  packages?: RegExp;
  /** Also give the hint when the finding names no package: the address is the SDK's own. */
  byAddress?: boolean;
  /** No hint for a finding from this source file: the fix is already in place there. */
  skipSource?: RegExp;
}

export const KNOWN_SDKS: readonly KnownSdk[] = [
  {
    sdk: 'Amplitude Browser SDK',
    // the autocapture plugin's visual tagging and background capture scripts, the SDK's own builds
    addresses: /^(?:https?:)?\/\/cdn\.amplitude\.com\//i,
    packages: /^@amplitude\//,
    byAddress: true,
    text:
      "Import from '@amplitude/analytics-browser/lite' (2.49.0 or later): the lite build leaves out " +
      'autocapture and the code that loads these scripts.',
    url: 'https://amplitude.com/docs/sdks/analytics/browser/browser-sdk-2/get-started#install-the-sdk',
  },
  {
    sdk: 'Firebase Authentication',
    // gapi and the reCAPTCHA scripts, used by popup, redirect and phone sign-in
    addresses: /^https?:\/\/(?:apis\.google\.com\/js\/api\.js|www\.google\.com\/recaptcha\/(?:api|enterprise)\.js)/i,
    packages: /^(?:firebase|@firebase\/(?:auth|app))$/,
    skipSource: /\/web-extension(?:-esm|-cjs)?\//,
    text:
      "Import from 'firebase/auth/web-extension' instead of 'firebase/auth' (Firebase 10.8.0 or " +
      'later). Popup, redirect and reCAPTCHA sign-in then need an offscreen document.',
    url: 'https://firebase.google.com/docs/auth/web/chrome-extension',
  },
  {
    sdk: 'Mixpanel',
    // the session recorder (and the snippet's copy of the library) on Mixpanel's CDN
    addresses: /^(?:https?:)?\/\/cdn\.mxpnl\.com\//i,
    packages: /^mixpanel-browser$/,
    byAddress: true,
    text:
      "Without session replay, import from 'mixpanel-browser/src/loaders/loader-module-core' " +
      '(2.54.0 or later), the build without the session recorder and without loading scripts.',
    url: 'https://github.com/mixpanel/mixpanel-js#readme',
  },
  {
    sdk: 'Google Analytics',
    // gtag.js, and analytics.js / ga.js of Universal Analytics
    addresses: /^(?:https?:)?\/\/(?:www\.googletagmanager\.com\/gtag\/js|(?:www|ssl)\.google-analytics\.com\/(?:analytics|ga)\.js)/i,
    byAddress: true,
    text: 'Send events with the GA4 Measurement Protocol (plain HTTP requests) instead of loading gtag.js.',
    url: 'https://developer.chrome.com/docs/extensions/how-to/integrate/google-analytics-4',
  },
];

// The address in a finding: a script tag's src, or the finding itself.
function addressOf(match: string): string {
  const src = /\ssrc\s*=\s*["']?(\S+)/i.exec(match);
  return src?.[1] ?? match;
}

/** The fix hint for a finding at `match`, from `pkg` when the scan knows it. */
export function hintFor(match: string, pkg?: NpmPackage): SdkHint | undefined {
  const address = addressOf(match);
  for (const known of KNOWN_SDKS) {
    if (!known.addresses.test(address)) continue;
    if (pkg ? known.packages && !known.packages.test(pkg.name) : known.packages && !known.byAddress) continue;
    if (pkg && known.skipSource?.test(pkg.source.replace(/\\/g, '/'))) continue;
    return { sdk: known.sdk, text: known.text, url: known.url };
  }
  return undefined;
}
