/** A tiny bounds-checked little/big-endian byte reader for the binary parsers. */
export class ByteReader {
  private readonly view: DataView;
  pos = 0;

  constructor(public readonly bytes: Uint8Array) {
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }

  get length(): number {
    return this.bytes.byteLength;
  }

  remaining(): number {
    return this.length - this.pos;
  }

  private ensure(n: number): void {
    if (this.pos + n > this.length) {
      throw new RangeError(`read out of bounds: need ${n} at ${this.pos}/${this.length}`);
    }
  }

  u8(): number {
    this.ensure(1);
    return this.view.getUint8(this.pos++);
  }

  u16(le = true): number {
    this.ensure(2);
    const v = this.view.getUint16(this.pos, le);
    this.pos += 2;
    return v;
  }

  u32(le = true): number {
    this.ensure(4);
    const v = this.view.getUint32(this.pos, le);
    this.pos += 4;
    return v;
  }

  u64(le = true): bigint {
    this.ensure(8);
    const v = this.view.getBigUint64(this.pos, le);
    this.pos += 8;
    return v;
  }

  bytesSlice(n: number): Uint8Array {
    this.ensure(n);
    const out = this.bytes.subarray(this.pos, this.pos + n);
    this.pos += n;
    return out;
  }

  /** LEB128 unsigned (used by WebAssembly). */
  uleb(): number {
    let result = 0;
    let shift = 0;
    for (;;) {
      const b = this.u8();
      result |= (b & 0x7f) << shift;
      if ((b & 0x80) === 0) break;
      shift += 7;
      if (shift > 35) throw new RangeError("uleb128 too long");
    }
    return result >>> 0;
  }

  seek(pos: number): void {
    if (pos < 0 || pos > this.length) throw new RangeError("seek out of bounds");
    this.pos = pos;
  }
}

/** Extract printable ASCII/UTF-8-ish runs of a minimum length from a buffer. */
export function extractStrings(bytes: Uint8Array, minLen = 4, cap = 50000): string[] {
  const out: string[] = [];
  let cur: number[] = [];
  const flush = () => {
    if (cur.length >= minLen) out.push(String.fromCharCode(...cur));
    cur = [];
  };
  for (let i = 0; i < bytes.length && out.length < cap; i++) {
    const b = bytes[i]!;
    if (b >= 0x20 && b <= 0x7e) {
      cur.push(b);
    } else {
      flush();
    }
  }
  flush();
  return out;
}
