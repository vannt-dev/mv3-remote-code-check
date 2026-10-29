import fs from 'node:fs';
import path from 'node:path';

/** The config file the command line looks for. */
export const CONFIG_FILE = 'mv3-remote-code-check.config.json';
/** The key in package.json that holds the same settings. */
export const PACKAGE_KEY = 'mv3RemoteCodeCheck';

export const FORMATS = ['text', 'json', 'github', 'sarif'] as const;
export type Format = (typeof FORMATS)[number];

export interface Config {
  /** Folders, .zip or .crx files to check, relative to the config file's folder. */
  paths?: string[];
  allow?: string[];
  exclude?: string[];
  format?: Format;
  failOnDynamicCode?: boolean;
}

export interface LoadedConfig {
  file: string;
  config: Config;
  /** Keys that were not understood and are ignored. */
  unknown: string[];
}

/** A config file that cannot be read or has a value of the wrong type. */
export class ConfigError extends Error {}

const KNOWN = new Set(['$schema', 'paths', 'allow', 'exclude', 'format', 'failOnDynamicCode']);

function readJson(file: string): unknown {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (e) {
    throw new ConfigError(`${file}: ${(e as Error).message}`);
  }
  try {
    return JSON.parse(text) as unknown;
  } catch (e) {
    throw new ConfigError(`${file}: invalid JSON: ${(e as Error).message}`);
  }
}

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

function validate(file: string, value: unknown): LoadedConfig {
  if (!isObject(value)) throw new ConfigError(`${file}: the config must be a JSON object`);
  const config: Config = {};
  for (const key of ['paths', 'allow', 'exclude'] as const) {
    const list = value[key];
    if (list === undefined) continue;
    if (!Array.isArray(list) || !list.every((item) => typeof item === 'string')) {
      throw new ConfigError(`${file}: "${key}" must be an array of strings`);
    }
    config[key] = list;
  }
  if (value.format !== undefined) {
    if (!FORMATS.includes(value.format as Format)) throw new ConfigError(`${file}: "format" must be text, json, github or sarif`);
    config.format = value.format as Format;
  }
  if (value.failOnDynamicCode !== undefined) {
    if (typeof value.failOnDynamicCode !== 'boolean') throw new ConfigError(`${file}: "failOnDynamicCode" must be true or false`);
    config.failOnDynamicCode = value.failOnDynamicCode;
  }
  return { file, config, unknown: Object.keys(value).filter((key) => !KNOWN.has(key)) };
}

/**
 * Reads a config file: a whole `mv3-remote-code-check.config.json`-style file, or the
 * `mv3RemoteCodeCheck` key of a package.json. Throws a ConfigError when it cannot be used.
 */
export function loadConfig(file: string): LoadedConfig {
  const json = readJson(file);
  if (path.basename(file) !== 'package.json') return validate(file, json);
  if (!isObject(json) || json[PACKAGE_KEY] === undefined) throw new ConfigError(`${file}: no "${PACKAGE_KEY}" key`);
  return validate(file, json[PACKAGE_KEY]);
}

/**
 * Looks for the config from `dir` upwards: in each folder `mv3-remote-code-check.config.json`
 * first, then a package.json with a `mv3RemoteCodeCheck` key. The search stops at the first one
 * found, or after the folder that holds `.git` (the repository root), or at the filesystem root.
 * A package.json that cannot be read as an object is not a config: it is passed to `warn` and
 * the search goes on. A config file, or a `mv3RemoteCodeCheck` key, that is invalid throws.
 */
export function findConfig(dir: string, warn: (message: string) => void = () => {}): LoadedConfig | null {
  let current = path.resolve(dir);
  for (;;) {
    const file = path.join(current, CONFIG_FILE);
    if (fs.existsSync(file)) return loadConfig(file);
    const pkg = path.join(current, 'package.json');
    if (fs.existsSync(pkg)) {
      let json: unknown;
      try {
        json = readJson(pkg);
      } catch (e) {
        if (!(e instanceof ConfigError)) throw e;
        warn(e.message.replace(`${pkg}: `, `${pkg}: skipped, `));
      }
      if (json !== undefined && !isObject(json)) warn(`${pkg}: skipped, not a JSON object`);
      if (isObject(json) && json[PACKAGE_KEY] !== undefined) return validate(pkg, json[PACKAGE_KEY]);
    }
    const parent = path.dirname(current);
    if (fs.existsSync(path.join(current, '.git')) || parent === current) return null;
    current = parent;
  }
}
