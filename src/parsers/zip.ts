/**
 * Bounded ZIP reader (APK, AAB, JAR, IPA are all ZIP containers).
 *
 * Hostile archives are the norm here, so every dimension is capped: entry
 * count, central-directory size, per-entry and total decompressed bytes, and
 * the compression ratio (zip-bomb guard). Only STORED and DEFLATE entries are
 * read; names are treated as data and never used as file-system paths.
 */
import { inflateRawSync } from "node:zlib";

export interface ZipLimits {
  maxEntries: number;
  /** Max decompressed bytes for one entry. */
  maxEntryBytes: number;
  /** Max decompressed bytes across all entries read in one archive. */
  maxTotalBytes: number;
  /** Max decompressed/compressed ratio before an entry is treated as a bomb. */
  maxRatio: number;
}

export const DEFAULT_ZIP_LIMITS: ZipLimits = {
  maxEntries: 100_000,
  maxEntryBytes: 64 * 1024 * 1024,
  maxTotalBytes: 512 * 1024 * 1024,
  maxRatio: 200,
};

export interface ZipEntry {
  name: string;
  method: number;
  compressedSize: number;
  size: number;
  localHeaderOffset: number;
  /** Bit 0 of the general-purpose flags: entry is encrypted. */
  encrypted: boolean;
}

export class ZipError extends Error {}

export class ZipReader {
  readonly entries: ZipEntry[] = [];
  readonly warnings: string[] = [];
  private readonly byName = new Map<string, ZipEntry>();
  private totalRead = 0;

  constructor(
    private readonly buf: Uint8Array,
    private readonly limits: ZipLimits = DEFAULT_ZIP_LIMITS,
  ) {
    const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    // End of central directory: last 22 bytes + up to 64 KiB comment.
    let eocd = -1;
    for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65_535); i--) {
      if (dv.getUint32(i, true) === 0x06054b50) {
        eocd = i;
        break;
      }
    }
    if (eocd < 0) throw new ZipError("not a ZIP archive (no end-of-central-directory record)");
    let count = dv.getUint16(eocd + 10, true);
    let cdSize = dv.getUint32(eocd + 12, true);
    let cdOffset = dv.getUint32(eocd + 16, true);
    // ZIP64 locator sits just before the EOCD.
    if ((count === 0xffff || cdOffset === 0xffffffff) && eocd >= 20 && dv.getUint32(eocd - 20, true) === 0x07064b50) {
      const z64 = Number(dv.getBigUint64(eocd - 12, true));
      if (z64 + 56 <= buf.length && dv.getUint32(z64, true) === 0x06064b50) {
        count = Number(dv.getBigUint64(z64 + 32, true));
        cdSize = Number(dv.getBigUint64(z64 + 40, true));
        cdOffset = Number(dv.getBigUint64(z64 + 48, true));
      }
    }
    if (cdOffset + cdSize > buf.length) throw new ZipError("central directory lies outside the file");
    if (count > limits.maxEntries) {
      this.warnings.push(`[anti-exhaust] ${count} entries; only the first ${limits.maxEntries} are read`);
      count = limits.maxEntries;
    }
    let p = cdOffset;
    const dec = new TextDecoder();
    for (let i = 0; i < count && p + 46 <= cdOffset + cdSize; i++) {
      if (dv.getUint32(p, true) !== 0x02014b50) {
        this.warnings.push("central directory is corrupt; stopped reading entries");
        break;
      }
      const flags = dv.getUint16(p + 8, true);
      const method = dv.getUint16(p + 10, true);
      let compressedSize = dv.getUint32(p + 20, true);
      let size = dv.getUint32(p + 24, true);
      const nameLen = dv.getUint16(p + 28, true);
      const extraLen = dv.getUint16(p + 30, true);
      const commentLen = dv.getUint16(p + 32, true);
      let localHeaderOffset = dv.getUint32(p + 42, true);
      const name = dec.decode(buf.subarray(p + 46, p + 46 + nameLen));
      // ZIP64 extra field.
      let q = p + 46 + nameLen;
      const qEnd = q + extraLen;
      while (q + 4 <= qEnd) {
        const id = dv.getUint16(q, true);
        const len = dv.getUint16(q + 2, true);
        if (id === 0x0001) {
          let r = q + 4;
          if (size === 0xffffffff && r + 8 <= q + 4 + len) (size = Number(dv.getBigUint64(r, true))), (r += 8);
          if (compressedSize === 0xffffffff && r + 8 <= q + 4 + len) (compressedSize = Number(dv.getBigUint64(r, true))), (r += 8);
          if (localHeaderOffset === 0xffffffff && r + 8 <= q + 4 + len) localHeaderOffset = Number(dv.getBigUint64(r, true));
        }
        q += 4 + len;
      }
      const e: ZipEntry = { name, method, compressedSize, size, localHeaderOffset, encrypted: (flags & 1) === 1 };
      this.entries.push(e);
      if (!this.byName.has(name)) this.byName.set(name, e);
      p += 46 + nameLen + extraLen + commentLen;
    }
  }

  get(name: string): ZipEntry | undefined {
    return this.byName.get(name);
  }

  /** Decompress one entry, enforcing size, ratio and total-bytes caps. */
  read(e: ZipEntry, maxBytes = this.limits.maxEntryBytes): Uint8Array {
    if (e.encrypted) throw new ZipError(`${e.name} is encrypted`);
    if (e.size > maxBytes) throw new ZipError(`${e.name} is ${e.size} bytes, above the ${maxBytes}-byte limit`);
    if (e.compressedSize > 0 && e.size / e.compressedSize > this.limits.maxRatio) {
      throw new ZipError(`${e.name} expands ${Math.round(e.size / e.compressedSize)}x — treated as a zip bomb`);
    }
    if (this.totalRead + e.size > this.limits.maxTotalBytes) throw new ZipError("archive read budget exhausted");
    const dv = new DataView(this.buf.buffer, this.buf.byteOffset, this.buf.byteLength);
    const h = e.localHeaderOffset;
    if (h + 30 > this.buf.length || dv.getUint32(h, true) !== 0x04034b50) throw new ZipError(`${e.name}: bad local header`);
    const start = h + 30 + dv.getUint16(h + 26, true) + dv.getUint16(h + 28, true);
    const raw = this.buf.subarray(start, start + e.compressedSize);
    let out: Uint8Array;
    if (e.method === 0) out = raw;
    else if (e.method === 8) {
      // maxOutputLength bounds memory even if the header lied about the size.
      out = inflateRawSync(raw, { maxOutputLength: Math.max(1, Math.min(maxBytes, e.size || maxBytes)) });
    } else throw new ZipError(`${e.name}: unsupported compression method ${e.method}`);
    this.totalRead += out.length;
    return out;
  }
}
