export {
  SCRIPT_CDN_HOSTS,
  findRemoteCode,
  locateRemoteCode,
  stripRemoteCode,
  type Located,
  type Rule,
  type StripOptions,
} from './patterns.ts';
export { locateDynamicCode } from './dynamic.ts';
export { checkManifest, type ManifestFinding } from './manifest.ts';
export { scanPath, scanFiles, findRemoteCodeInDir, type Finding, type ScanOptions, type ScanResult } from './scan.ts';
export { zipEntries, type PackageFile } from './zip.ts';
export { type NpmPackage } from './origin.ts';
export { remoteCodeGuard, type RemoteCodeGuardOptions, type RemoteCodeGuardPlugin } from './vite.ts';
