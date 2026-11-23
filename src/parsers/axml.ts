/**
 * Minimal Android binary XML (AXML) reader for AndroidManifest.xml.
 *
 * Recovers only what REE needs to find an app's own code and entry points: the
 * package name, the application class, declared components (activities,
 * services, receivers, providers — with the launcher activity marked) and
 * requested permissions. Every loop and table is capped; strings are data.
 */
export interface ManifestInfo {
  package?: string;
  versionName?: string;
  application?: string;
  components: Array<{ kind: "activity" | "service" | "receiver" | "provider"; name: string; exported?: boolean; launcher?: boolean }>;
  permissions: string[];
}

const MAX_STRINGS = 200_000;
const MAX_CHUNKS = 500_000;
const MAX_STRING_CHARS = 4096;

export class AxmlError extends Error {}

export function parseManifest(bytes: Uint8Array): ManifestInfo {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length < 8 || dv.getUint16(0, true) !== 0x0003) throw new AxmlError("not Android binary XML");
  const info: ManifestInfo = { components: [], permissions: [] };
  let strings: string[] = [];
  const stack: Array<{ tag: string; comp?: ManifestInfo["components"][number] }> = [];
  let pendingAction: string | undefined;
  let pendingCategory: string | undefined;

  let p = dv.getUint16(2, true); // first chunk after the file header
  for (let n = 0; p + 8 <= bytes.length && n < MAX_CHUNKS; n++) {
    const type = dv.getUint16(p, true);
    const headerSize = dv.getUint16(p + 2, true);
    const size = dv.getUint32(p + 4, true);
    if (size < 8 || p + size > bytes.length) break;

    if (type === 0x0001) strings = readStringPool(bytes, dv, p);
    else if (type === 0x0102) {
      const tag = strings[dv.getUint32(p + 20, true)] ?? "";
      const attrStart = dv.getUint16(p + 24, true);
      const attrSize = dv.getUint16(p + 26, true) || 20;
      const attrCount = Math.min(dv.getUint16(p + 28, true), 256);
      const attrs: Record<string, string> = {};
      for (let i = 0; i < attrCount; i++) {
        const a = p + headerSize + attrStart + i * attrSize;
        if (a + 20 > p + size) break;
        const name = strings[dv.getUint32(a + 4, true)] ?? "";
        const raw = dv.getUint32(a + 8, true);
        const dataType = dv.getUint8(a + 15);
        const data = dv.getUint32(a + 16, true);
        let value: string;
        if (raw !== 0xffffffff) value = strings[raw] ?? "";
        else if (dataType === 0x03) value = strings[data] ?? "";
        else if (dataType === 0x12) value = data !== 0 ? "true" : "false";
        else value = String(data);
        if (name) attrs[name] = value;
      }
      const comp = elementOpened(tag, attrs, info);
      if (tag === "action") pendingAction = attrs.name;
      if (tag === "category") pendingCategory = attrs.name;
      stack.push({ tag, comp: comp ?? stack[stack.length - 1]?.comp });
    } else if (type === 0x0103) {
      const top = stack.pop();
      if (top?.tag === "intent-filter" && top.comp && pendingAction === "android.intent.action.MAIN" && pendingCategory === "android.intent.category.LAUNCHER") {
        top.comp.launcher = true;
      }
      if (top?.tag === "intent-filter") pendingAction = pendingCategory = undefined;
    } else if (type === 0x0003) {
      p += headerSize;
      continue;
    }
    p += size;
  }
  if (info.application && info.package && info.application.startsWith(".")) info.application = info.package + info.application;
  for (const c of info.components) if (info.package && c.name.startsWith(".")) c.name = info.package + c.name;
  return info;
}

function elementOpened(tag: string, a: Record<string, string>, info: ManifestInfo): ManifestInfo["components"][number] | undefined {
  if (tag === "manifest") {
    info.package = a.package;
    info.versionName = a.versionName;
  } else if (tag === "application") {
    if (a.name) info.application = a.name;
  } else if (tag === "uses-permission" && a.name && info.permissions.length < 1000) {
    info.permissions.push(a.name);
  } else if ((tag === "activity" || tag === "activity-alias" || tag === "service" || tag === "receiver" || tag === "provider") && a.name && info.components.length < 5000) {
    const kind = tag === "activity-alias" ? "activity" : (tag as "activity" | "service" | "receiver" | "provider");
    const comp = { kind, name: a.name, exported: a.exported === undefined ? undefined : a.exported === "true" };
    info.components.push(comp);
    return comp;
  }
  return undefined;
}

function readStringPool(bytes: Uint8Array, dv: DataView, p: number): string[] {
  const count = Math.min(dv.getUint32(p + 8, true), MAX_STRINGS);
  const flags = dv.getUint32(p + 16, true);
  const utf8 = (flags & 0x100) !== 0;
  const stringsStart = p + dv.getUint32(p + 20, true);
  const offsetsAt = p + dv.getUint16(p + 2, true);
  const out: string[] = [];
  const dec8 = new TextDecoder("utf-8");
  for (let i = 0; i < count; i++) {
    const oPos = offsetsAt + i * 4;
    if (oPos + 4 > bytes.length) break;
    let s = stringsStart + dv.getUint32(oPos, true);
    if (s >= bytes.length) {
      out.push("");
      continue;
    }
    if (utf8) {
      // utf16 length (1-2 bytes), then utf8 byte length (1-2 bytes), then bytes.
      s += bytes[s]! & 0x80 ? 2 : 1;
      let len = bytes[s]!;
      if (len & 0x80) (len = ((len & 0x7f) << 8) | bytes[s + 1]!), (s += 2);
      else s += 1;
      out.push(dec8.decode(bytes.subarray(s, Math.min(s + Math.min(len, MAX_STRING_CHARS * 4), bytes.length))));
    } else {
      let len = dv.getUint16(s, true);
      if (len & 0x8000) (len = ((len & 0x7fff) << 16) | dv.getUint16(s + 2, true)), (s += 4);
      else s += 2;
      len = Math.min(len, MAX_STRING_CHARS);
      let str = "";
      for (let k = 0; k < len && s + k * 2 + 2 <= bytes.length; k++) str += String.fromCharCode(dv.getUint16(s + k * 2, true));
      out.push(str);
    }
  }
  return out;
}
