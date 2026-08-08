import { inflateRawSync } from "node:zlib";

/**
 * The ZIP handling Yori owns: deterministic stored-method writing for Yomitan
 * packs, and in-process reading of pinned source archives. Reading runs in
 * process on purpose, so a rebuild from pinned sources needs no external
 * `unzip` binary and cannot stall on a subprocess.
 */
export function createStoredZip(files: Array<{ name: string; content: string }>): Uint8Array {
  const encoder = new TextEncoder();
  const localParts: Uint8Array[] = [];
  const centralParts: Uint8Array[] = [];
  let offset = 0;

  for (const file of files) {
    const name = encoder.encode(file.name);
    const data = encoder.encode(file.content);
    const crc = crc32(data);
    const local = header(30 + name.length, (view) => {
      view.setUint32(0, 0x04034b50, true);
      view.setUint16(4, 20, true);
      view.setUint16(6, 0, true);
      view.setUint16(8, 0, true);
      view.setUint16(10, 0, true);
      view.setUint16(12, 0, true);
      view.setUint32(14, crc, true);
      view.setUint32(18, data.length, true);
      view.setUint32(22, data.length, true);
      view.setUint16(26, name.length, true);
      view.setUint16(28, 0, true);
    });
    local.set(name, 30);
    localParts.push(local, data);

    const central = header(46 + name.length, (view) => {
      view.setUint32(0, 0x02014b50, true);
      view.setUint16(4, 20, true);
      view.setUint16(6, 20, true);
      view.setUint16(8, 0, true);
      view.setUint16(10, 0, true);
      view.setUint16(12, 0, true);
      view.setUint16(14, 0, true);
      view.setUint32(16, crc, true);
      view.setUint32(20, data.length, true);
      view.setUint32(24, data.length, true);
      view.setUint16(28, name.length, true);
      view.setUint16(30, 0, true);
      view.setUint16(32, 0, true);
      view.setUint16(34, 0, true);
      view.setUint16(36, 0, true);
      view.setUint32(38, 0, true);
      view.setUint32(42, offset, true);
    });
    central.set(name, 46);
    centralParts.push(central);
    offset += local.length + data.length;
  }

  const centralSize = centralParts.reduce((sum, part) => sum + part.length, 0);
  const end = header(22, (view) => {
    view.setUint32(0, 0x06054b50, true);
    view.setUint16(4, 0, true);
    view.setUint16(6, 0, true);
    view.setUint16(8, files.length, true);
    view.setUint16(10, files.length, true);
    view.setUint32(12, centralSize, true);
    view.setUint32(16, offset, true);
    view.setUint16(20, 0, true);
  });
  return concatenate([...localParts, ...centralParts, end]);
}

type ZipEntry = { name: string; method: number; compressedSize: number; localHeaderOffset: number };

/** One opened archive: its entry names, and its entries decoded on demand. */
export type ZipArchive = {
  names: string[];
  /** Reads one entry as UTF-8 text. Throws when the archive has no such name. */
  text(name: string): string;
};

export async function openZipFile(path: string): Promise<ZipArchive> {
  return openZipArchive(new Uint8Array(await Bun.file(path).arrayBuffer()));
}

export function openZipArchive(bytes: Uint8Array): ZipArchive {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const entries = new Map<string, ZipEntry>();
  for (const entry of readCentralDirectory(bytes, view)) entries.set(entry.name, entry);
  return {
    names: Array.from(entries.keys()),
    text(name) {
      const entry = entries.get(name);
      if (!entry) throw new Error(`Archive has no entry named ${name}`);
      return new TextDecoder().decode(readEntry(bytes, view, entry));
    }
  };
}

function readCentralDirectory(bytes: Uint8Array, view: DataView): ZipEntry[] {
  const end = findEndOfCentralDirectory(view, bytes.length);
  const count = view.getUint16(end + 10, true);
  let offset = view.getUint32(end + 16, true);
  const entries: ZipEntry[] = [];
  for (let index = 0; index < count; index += 1) {
    if (view.getUint32(offset, true) !== 0x02014b50) {
      throw new Error("Malformed archive: expected a central directory record");
    }
    const nameLength = view.getUint16(offset + 28, true);
    entries.push({
      name: new TextDecoder().decode(bytes.subarray(offset + 46, offset + 46 + nameLength)),
      method: view.getUint16(offset + 10, true),
      compressedSize: view.getUint32(offset + 20, true),
      localHeaderOffset: view.getUint32(offset + 42, true)
    });
    offset += 46 + nameLength + view.getUint16(offset + 30, true) + view.getUint16(offset + 32, true);
  }
  return entries;
}

function findEndOfCentralDirectory(view: DataView, length: number): number {
  // The record is last, followed only by an optional comment of at most 65535 bytes.
  for (let offset = length - 22; offset >= 0 && offset >= length - 22 - 0xffff; offset -= 1) {
    if (view.getUint32(offset, true) === 0x06054b50) return offset;
  }
  throw new Error("Malformed archive: no end of central directory record");
}

function readEntry(bytes: Uint8Array, view: DataView, entry: ZipEntry): Uint8Array {
  const local = entry.localHeaderOffset;
  if (view.getUint32(local, true) !== 0x04034b50) {
    throw new Error(`Malformed archive: no local header for ${entry.name}`);
  }
  const start = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
  const data = bytes.subarray(start, start + entry.compressedSize);
  if (entry.method === 0) return data;
  if (entry.method === 8) return inflateRawSync(data);
  throw new Error(`Unsupported compression method ${entry.method} for ${entry.name}`);
}

function header(length: number, write: (view: DataView) => void): Uint8Array {
  const bytes = new Uint8Array(length);
  write(new DataView(bytes.buffer));
  return bytes;
}

function concatenate(parts: Uint8Array[]): Uint8Array {
  const output = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.length;
  }
  return output;
}

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}
