/**
 * A Manifest V3 extension's pages may only run scripts from the package: the content security
 * policy of `extension_pages` cannot name another host. Chrome refuses such a manifest, and an
 * MV2 manifest's policy is read the same way here.
 */

// Sources a script-src of an extension page may hold.
const ALLOWED = new Set(["'self'", "'none'", "'wasm-unsafe-eval'", "'wasm-eval'", "'inline-speculation-rules'"]);
const LOCAL = /^(?:https?:\/\/)?(?:localhost|127\.0\.0\.1)(?::\d+|:\*)?\/?$/i;

/**
 * Script sources in a manifest's content security policy that point outside the package.
 * @param {string} text the manifest.json text
 * @returns {{ match: string, rule: string, detail: string }[]}
 */
export function checkManifest(text) {
  let manifest;
  try {
    manifest = JSON.parse(text);
  } catch {
    return [];
  }
  const csp = manifest?.content_security_policy;
  const policy = typeof csp === 'string' ? csp : csp?.extension_pages;
  if (typeof policy !== 'string') return [];

  const directives = new Map(
    policy
      .split(';')
      .map((part) => part.trim().split(/\s+/))
      .filter(([name]) => name)
      .map(([name, ...sources]) => [name.toLowerCase(), sources])
  );
  const name = ['script-src', 'script-src-elem', 'default-src'].find((n) => directives.has(n));
  if (!name) return [];

  return directives
    .get(name)
    .filter((source) => !ALLOWED.has(source.toLowerCase()) && !LOCAL.test(source))
    .map((source) => ({
      match: source,
      rule: 'manifest-csp',
      detail: `${name} of content_security_policy allows ${source}; extension pages may only run their own scripts`,
    }));
}
