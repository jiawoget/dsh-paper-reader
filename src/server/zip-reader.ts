import { inflateRawSync } from 'node:zlib';
import { fail, isRecord } from './library.js';

interface ZipEntryMeta { method: number; compressed: number; uncompressed: number; localOffset: number }

export interface ZipArchive {
  names(): string[];
  read(name: string): Buffer | undefined;
  readText(name: string): string | undefined;
}

const MAX_ENTRIES = 2_000, MAX_ENTRY_BYTES = 16 * 1024 * 1024, MAX_TOTAL_BYTES = 64 * 1024 * 1024;
const RATIO_FLOOR = 65_536, MAX_RATIO = 100;
const SIG_EOCD = 0x06054b50, SIG_CD = 0x02014b50, SIG_LFH = 0x04034b50;

function findEocd(bytes: Buffer): number {
  if (bytes.length < 22) fail('This file is not a valid ZIP archive.', 400);
  const minPos = Math.max(0, bytes.length - 22 - 65_535);
  for (let pos = bytes.length - 22; pos >= minPos; pos--) {
    if (bytes.readUInt32LE(pos) === SIG_EOCD && bytes.readUInt16LE(pos + 20) === bytes.length - (pos + 22)) return pos;
  }
  fail('This file is not a valid ZIP archive.', 400);
}

function assertSafeEntryName(name: string): void {
  if (!name || name.includes('\0') || name.includes('\\') || name.startsWith('/') || /^[a-zA-Z]:/.test(name) ||
      name.split('/').some(seg => seg === '..')) fail('The archive contains an unsafe entry path.', 400);
}

export function openZip(bytes: Buffer): ZipArchive {
  const eocd = findEocd(bytes);
  const totalEntries = bytes.readUInt16LE(eocd + 10), cdSize = bytes.readUInt32LE(eocd + 12), cdOffset = bytes.readUInt32LE(eocd + 16);
  if (bytes.readUInt16LE(eocd + 4) !== 0 || bytes.readUInt16LE(eocd + 6) !== 0 || bytes.readUInt16LE(eocd + 8) !== totalEntries) {
    fail('Multi-disk ZIP archives are not supported.', 415);
  }
  if (totalEntries === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) fail('ZIP64 archives are not supported.', 415);
  if (totalEntries > MAX_ENTRIES) fail('This archive contains too many entries.', 413);
  if (cdOffset + cdSize > eocd) fail('The archive central directory is damaged.', 400);

  const entries = new Map<string, ZipEntryMeta>();
  let pos = cdOffset, declaredTotal = 0;
  const cdEnd = cdOffset + cdSize;
  for (let i = 0; i < totalEntries; i++) {
    if (pos + 46 > cdEnd || bytes.readUInt32LE(pos) !== SIG_CD) fail('The archive central directory is damaged.', 400);
    const flags = bytes.readUInt16LE(pos + 8), method = bytes.readUInt16LE(pos + 10);
    if ((flags & 1) !== 0) fail('Password-protected archives are not supported.', 415);
    if (method !== 0 && method !== 8) fail('Unsupported ZIP compression method.', 415);
    const compressed = bytes.readUInt32LE(pos + 20), uncompressed = bytes.readUInt32LE(pos + 24);
    const nameLen = bytes.readUInt16LE(pos + 28), extraLen = bytes.readUInt16LE(pos + 30), commentLen = bytes.readUInt16LE(pos + 32);
    const localOffset = bytes.readUInt32LE(pos + 42);
    if (pos + 46 + nameLen + extraLen + commentLen > cdEnd) fail('The archive entry header is truncated.', 400);
    const name = bytes.toString(flags & 0x0800 ? 'utf8' : 'latin1', pos + 46, pos + 46 + nameLen);
    assertSafeEntryName(name);
    if (uncompressed > MAX_ENTRY_BYTES) fail('An archive entry exceeds the 16 MB limit.', 413);
    declaredTotal += uncompressed;
    if (declaredTotal > MAX_TOTAL_BYTES) fail('The archive exceeds the 64 MB uncompressed limit.', 413);
    if ((method === 0 && compressed !== uncompressed) || (method === 8 && compressed === 0 && uncompressed > 0)) fail('Invalid archive entry size.', 400);
    if (uncompressed > RATIO_FLOOR && compressed > 0 && uncompressed / compressed > MAX_RATIO) fail('The archive exceeds the safe compression ratio.', 413);
    if (localOffset + 30 > eocd) fail('The archive entry offset is out of bounds.', 400);
    if (!name.endsWith('/')) {
      if (entries.has(name)) fail('The archive contains duplicate entries.', 400);
      entries.set(name, { method, compressed, uncompressed, localOffset });
    }
    pos += 46 + nameLen + extraLen + commentLen;
  }

  const cache = new Map<string, Buffer>();
  let extractedTotal = 0;

  function read(name: string): Buffer | undefined {
    const cached = cache.get(name);
    if (cached) return cached;
    const entry = entries.get(name);
    if (!entry) return;
    if (entry.localOffset + 30 > bytes.length || bytes.readUInt32LE(entry.localOffset) !== SIG_LFH) fail('The archive local header is damaged.', 400);
    const dataStart = entry.localOffset + 30 + bytes.readUInt16LE(entry.localOffset + 26) + bytes.readUInt16LE(entry.localOffset + 28);
    if (dataStart + entry.compressed > bytes.length) fail('The archive entry payload is truncated.', 400);
    if (extractedTotal + entry.uncompressed > MAX_TOTAL_BYTES) fail('The archive exceeds the 64 MB uncompressed limit.', 413);
    const raw = bytes.subarray(dataStart, dataStart + entry.compressed);
    let out: Buffer;
    if (entry.method === 0) out = Buffer.from(raw);
    else {
      const ratioCap = entry.compressed > 0 ? Math.max(RATIO_FLOOR, entry.compressed * MAX_RATIO) : 0;
      const maxOutputLength = Math.min(MAX_ENTRY_BYTES, MAX_TOTAL_BYTES - extractedTotal, ratioCap);
      try { out = inflateRawSync(raw, { maxOutputLength }); }
      catch (err) {
        if (isRecord(err) && err.code === 'ERR_BUFFER_TOO_LARGE') fail('The archive exceeds safe decompression limits.', 413);
        fail('The compressed archive entry is corrupted.', 400);
      }
    }
    if (out.length !== entry.uncompressed) fail('The archive entry size does not match its header.', 400);
    if (out.length > RATIO_FLOOR && entry.compressed > 0 && out.length / entry.compressed > MAX_RATIO) fail('The archive exceeds the safe compression ratio.', 413);
    extractedTotal += out.length;
    cache.set(name, out);
    return out;
  }

  return { names: () => [...entries.keys()], read, readText: name => { const buf = read(name); return buf ? new TextDecoder('utf-8').decode(buf) : undefined; } };
}
