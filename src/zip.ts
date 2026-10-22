import { inflateRawSync } from 'node:zlib';

const END_OF_CENTRAL_DIRECTORY = 0x06054b50;
const CENTRAL_FILE_HEADER = 0x02014b50;
const LOCAL_FILE_HEADER = 0x04034b50;

/** A file of a package: a '/'-separated name and a way to read it. */
export interface PackageFile {
  name: string;
  read: () => Buffer | string;
}

/**
 * The files of a ZIP archive, without a dependency. Handles the stored and deflated entries every
 * extension packer writes; ZIP64 and encrypted archives are refused.
 */
export function zipEntries(zip: Buffer): PackageFile[] {
  const end = findEndOfCentralDirectory(zip);
  const count = zip.readUInt16LE(end + 10);
  const directoryOffset = zip.readUInt32LE(end + 16);
  if (count === 0xffff || directoryOffset === 0xffffffff) throw new Error('ZIP64 archives are not supported');

  const entries: PackageFile[] = [];
  let at = directoryOffset;
  for (let i = 0; i < count; i++) {
    if (zip.readUInt32LE(at) !== CENTRAL_FILE_HEADER) throw new Error('Damaged ZIP: bad central directory');
    const flags = zip.readUInt16LE(at + 8);
    const method = zip.readUInt16LE(at + 10);
    const compressedSize = zip.readUInt32LE(at + 20);
    const nameLength = zip.readUInt16LE(at + 28);
    const extraLength = zip.readUInt16LE(at + 30);
    const commentLength = zip.readUInt16LE(at + 32);
    const localOffset = zip.readUInt32LE(at + 42);
    const name = zip.toString(flags & 0x800 ? 'utf8' : 'latin1', at + 46, at + 46 + nameLength);
    at += 46 + nameLength + extraLength + commentLength;
    if (name.endsWith('/')) continue;
    if (flags & 0x1) throw new Error(`Encrypted ZIP entry: ${name}`);
    entries.push({
      name,
      read: () => {
        if (zip.readUInt32LE(localOffset) !== LOCAL_FILE_HEADER) throw new Error(`Damaged ZIP entry: ${name}`);
        const start = localOffset + 30 + zip.readUInt16LE(localOffset + 26) + zip.readUInt16LE(localOffset + 28);
        const data = zip.subarray(start, start + compressedSize);
        if (method === 0) return data;
        if (method === 8) return inflateRawSync(data);
        throw new Error(`Unsupported compression method ${method}: ${name}`);
      },
    });
  }
  return entries;
}

function findEndOfCentralDirectory(zip: Buffer): number {
  // The record is 22 bytes plus a comment of at most 65535.
  const lowest = Math.max(0, zip.length - 22 - 0xffff);
  for (let at = zip.length - 22; at >= lowest; at--) {
    if (zip.readUInt32LE(at) === END_OF_CENTRAL_DIRECTORY) return at;
  }
  throw new Error('Not a ZIP archive');
}
