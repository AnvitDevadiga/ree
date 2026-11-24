/**
 * The "exploded view": turn one or more cleaned analyses into a map of parts —
 * what an app is made of, grouped by what each piece does, with the connections
 * between them.
 *
 * Built only from REE's *cleaned* output (decoys removed, planted instructions
 * redacted). Everything shown comes from the artifact, so every name and every
 * line of text is also stripped of terminal control sequences before display: a
 * hostile function name must not be able to move the cursor, rewrite the screen,
 * or change the terminal title.
 */
import type { AnalyzeResult } from "../core/analyze.js";
import type { CodeUnit } from "../core/types.js";
import { renderUnit } from "../anti-bla/engine.js";
import { redactInjections } from "../anti-bla/sanitizer.js";
import { estimateTokens } from "../core/tokens.js";

export type PartCategory = "entry" | "ui" | "network" | "storage" | "system" | "logic" | "data" | "library";

export const CATEGORY_INFO: Record<PartCategory, { label: string; icon: string; blurb: string }> = {
  entry: { label: "Start here", icon: "▶", blurb: "Where the app begins running" },
  ui: { label: "Screens & UI", icon: "▣", blurb: "Windows, pages, views and what the user sees" },
  network: { label: "Network", icon: "⇄", blurb: "Talks to servers, sockets or the web" },
  storage: { label: "Files & storage", icon: "▤", blurb: "Reads or writes files, settings or databases" },
  system: { label: "System & processes", icon: "⚙", blurb: "Runs programs, native code, or crosses process boundaries" },
  logic: { label: "Core logic", icon: "◆", blurb: "The app's own behavior" },
  data: { label: "Config & data", icon: "≡", blurb: "Manifests, settings files and embedded data" },
  library: { label: "Libraries", icon: "▧", blurb: "Third-party code the app bundles" },
};

/** Display order; "entry" is a view over parts, not a primary category. */
export const CATEGORY_ORDER: PartCategory[] = ["entry", "ui", "logic", "network", "storage", "system", "data", "library"];

export interface Part {
  /** Stable id: `<artifact index>:<unit id>`. */
  key: string;
  unitId: string;
  /** Safe display name (control characters removed, injections redacted, bounded). */
  name: string;
  /** Which artifact inside an app bundle this came from ("" for a single file). */
  artifact: string;
  /** File inside the artifact, when the unit belongs to one. */
  file?: string;
  kind: CodeUnit["kind"];
  category: Exclude<PartCategory, "entry">;
  /** Every category whose signals matched, primary first. */
  tags: Exclude<PartCategory, "entry">[];
  /** Why it was tagged — the evidence, e.g. "fetch(", "ipcMain". */
  signals: string[];
  isEntry: boolean;
  entryReason?: string;
  /** Keys of parts this one uses / that use it. */
  uses: string[];
  usedBy: string[];
  /** Cleaned, terminal-safe text: source, decompiled code or a structural summary. */
  text: string;
  tokens: number;
}

export interface RemovedItem {
  artifact: string;
  action: string;
  pass: string;
  message: string;
}

export interface PartsMap {
  source: string;
  title: string;
  formats: string[];
  artifacts: string[];
  parts: Part[];
  removed: RemovedItem[];
  removedTotal: number;
  limitations: string[];
  stats: { unitsIn: number; kept: number; removed: number; tokensBefore: number; tokensAfter: number; instructionsRedacted: number };
}

export interface ArtifactInput {
  /** Label for the artifact inside a bundle ("" for a single file). */
  label: string;
  result: AnalyzeResult;
}

const MAX_NAME = 120;
const MAX_TEXT_CHARS = 400_000;
const MAX_REMOVED = 500;

/**
 * Replace C0/C1 control characters (ESC, BEL, CSI, backspace, carriage return …)
 * with visible escapes. Tabs and newlines are kept when `multiline` is set.
 */
export function terminalSafe(text: string, multiline = true): string {
  const re = multiline
    ? /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g
    : /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g;
  return text.replace(re, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);
}

/** A name safe to print on one line: no control characters, injections redacted, bounded. */
export function safeName(raw: string): string {
  const one = terminalSafe(raw, false);
  const red = redactInjections(one).text;
  return red.length > MAX_NAME ? `${red.slice(0, MAX_NAME - 1)}…` : red;
}

interface Signal {
  cat: Exclude<PartCategory, "entry" | "logic" | "library" | "data">;
  label: string;
  re: RegExp;
  /** Match against the full text, string literals included (default: code only). */
  literal?: boolean;
}

// Ordered by precedence: the first category that matches becomes the primary one.
const SIGNALS: Signal[] = [
  // UI
  { cat: "ui", label: "BrowserWindow", re: /\bBrowserWindow\b/ },
  { cat: "ui", label: "DOM", re: /\bdocument\.(getElementById|querySelector|createElement|body)\b/ },
  { cat: "ui", label: "React", re: /\b(React\.createElement\b|jsx\(|useState\(|ReactDOM\b)/ },
  { cat: "ui", label: "HTML", re: /<(html|body|div|button|script)[\s>]/i, literal: true },
  { cat: "ui", label: "Android view", re: /\b(Activity|Fragment|setContentView|findViewById|LayoutInflater)\b/ },
  { cat: "ui", label: "Desktop UI", re: /\b(System\.Windows\.Forms|MessageBox\.Show|InitializeComponent|NSWindow|UIViewController|gtk_widget|CreateWindowEx)\b/ },
  // Network
  { cat: "network", label: "fetch", re: /\bfetch\s*\(/ },
  { cat: "network", label: "XMLHttpRequest", re: /\bXMLHttpRequest\b/ },
  { cat: "network", label: "http(s) module", re: /\b(https?\.(request|get|createServer)|require\(["']https?["']\))/, literal: true },
  { cat: "network", label: "WebSocket", re: /\bWebSocket\b/ },
  { cat: "network", label: "axios", re: /\baxios\b/ },
  { cat: "network", label: "socket", re: /\b(net\.(connect|createConnection|createServer)\b|socket\s*\(|connect\s*\(\s*\w+\s*,\s*\(struct sockaddr|SOCK_STREAM\b)/ },
  { cat: "network", label: "Java/Android HTTP", re: /\b(HttpURLConnection|OkHttpClient|okhttp3|Retrofit|HttpClient|WebClient|URLSession)\b/ },
  { cat: "network", label: "native networking", re: /\b(curl_easy_|WinHttp\w+|InternetOpen\w*|getaddrinfo)\b/ },
  // Storage
  { cat: "storage", label: "fs", re: /\bfs\.(readFile|writeFile|readFileSync|writeFileSync|createReadStream|createWriteStream|mkdir|unlink|readdir)\w*/ },
  { cat: "storage", label: "localStorage", re: /\b(localStorage|sessionStorage|indexedDB)\b/ },
  { cat: "storage", label: "database", re: /\b(sqlite3?|SQLiteDatabase|Realm|CoreData|NSUserDefaults|SharedPreferences|better-sqlite3)\b/i },
  { cat: "storage", label: "file I/O", re: /\b(fopen\b|CreateFile[AW]?\b|File\.(ReadAll|WriteAll)\w*|FileOutputStream\b|FileInputStream\b)/ },
  { cat: "storage", label: "file I/O", re: /\bopen\(\s*[\w"'][^)\n]*,\s*["'][rwa]b?\+?["']/, literal: true },
  { cat: "storage", label: "registry", re: /\b(RegOpenKey\w*|Registry\.(GetValue|SetValue|CurrentUser|LocalMachine))\b/ },
  // System
  { cat: "system", label: "IPC", re: /\b(ipcMain|ipcRenderer|contextBridge)\b/ },
  { cat: "system", label: "child process", re: /\b(child_process\b|execFile\b|execSync\b|spawnSync\b|spawn\s*\(|Runtime\.getRuntime\(\)\.exec\b|ProcessBuilder\b|Process\.Start\b|CreateProcess[AW]?\b|subprocess\.\w|os\.system\b)/ },
  { cat: "system", label: "child process", re: /require\(\s*["'](node:)?child_process["']\s*\)|from\s+["'](node:)?child_process["']/, literal: true },
  { cat: "system", label: "native interop", re: /\b(DllImport\b|System\.loadLibrary\b|dlopen\b|LoadLibrary[AW]?\b|ffi\.\w|ctypes\.\w)/ },
  { cat: "system", label: "shell / OS", re: /\b(shell\.openExternal|app\.(quit|relaunch)|process\.(exit|platform|env))\b/ },
];

const LIBRARY_RE =
  /(^|[/\\])node_modules[/\\]|^(androidx|android[./]support|com[./]google|kotlinx?|okhttp3|okio|retrofit2|com[./]squareup|io[./]reactivex|org[./](apache|jetbrains|json|slf4j))[./]|^(System|Microsoft|Newtonsoft)\./;
const DATA_RE = /\.(json|plist|xml|ya?ml|toml|ini|cfg|properties|txt|md)$/i;

/**
 * The file a unit belongs to. Parsers name units `path` or `path#function`
 * (ids are opaque, e.g. `asar:3`), so the file is the name before `#` when it
 * looks like a path with an extension.
 */
export function fileOf(unitName: string): string | undefined {
  const i = unitName.indexOf("#");
  const f = i >= 0 ? unitName.slice(0, i) : unitName;
  if (/^<.*>$/.test(f) || /\s/.test(f)) return undefined;
  const ext = /\.([A-Za-z0-9]{1,8})$/.exec(f)?.[1]?.toLowerCase();
  if (!ext) return undefined;
  // Without a path separator, "com.example.Main" is a class name, not a file.
  return /[/\\]/.test(f) || FILE_EXTS.has(ext) ? f : undefined;
}

const FILE_EXTS = new Set(
  "js mjs cjs jsx ts tsx json map html htm css scss svg png jpg jpeg gif webp ico txt md xml plist yml yaml toml ini cfg conf properties wasm node py pyc so dylib dll exe jar class dex kt java cs swift m h c cc cpp hpp rs go lua rb php sh bat ps1 sql db sqlite lock env asar".split(" "),
);

export function classify(u: CodeUnit, text: string): { tags: Exclude<PartCategory, "entry">[]; signals: string[] } {
  const tags: Exclude<PartCategory, "entry">[] = [];
  const signals: string[] = [];
  if (LIBRARY_RE.test(u.name)) {
    tags.push("library");
    signals.push("third-party path");
  }
  const sample = text.length > 60_000 ? text.slice(0, 60_000) : text;
  // A string that merely *mentions* "System.Windows.Forms" is not evidence of UI.
  const code = sample.replace(/"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'/g, '""');
  for (const s of SIGNALS) {
    if (s.re.test(s.literal ? sample : code)) {
      if (!tags.includes(s.cat)) tags.push(s.cat);
      if (signals.length < 12 && !signals.includes(s.label)) signals.push(s.label);
    }
  }
  const file = fileOf(u.name);
  if (/\.(html?|css)$/i.test(file ?? "") && !tags.includes("ui")) tags.unshift("ui");
  if (file && DATA_RE.test(file) && tags.length === 0) {
    tags.push("data");
    signals.push("config/data file");
  }
  if (tags.length === 0) tags.push(u.body || u.kind === "function" || u.kind === "class" ? "logic" : "data");
  // Library wins as the primary category: a bundled HTTP client is a library first.
  return { tags, signals };
}

export function buildParts(inputs: ArtifactInput[], source: string): PartsMap {
  const parts: Part[] = [];
  const removed: RemovedItem[] = [];
  let removedTotal = 0;
  const limitations: string[] = [];
  const formats: string[] = [];
  const stats = { unitsIn: 0, kept: 0, removed: 0, tokensBefore: 0, tokensAfter: 0, instructionsRedacted: 0 };

  inputs.forEach((inp, ai) => {
    const { report } = inp.result;
    const model = report.model;
    if (!formats.includes(model.format)) formats.push(model.format);
    stats.unitsIn += report.stats.unitsIn;
    stats.kept += report.stats.unitsOut;
    stats.removed += report.stats.unitsPruned + report.stats.unitsQuarantined;
    stats.tokensBefore += report.stats.estTokensBefore;
    stats.tokensAfter += report.stats.estTokensAfter;
    stats.instructionsRedacted += report.findings.filter((f) => f.pass === "sanitizer" && f.action === "sanitized").length;

    const nameById = new Map(model.units.map((u) => [u.id, u.name]));
    const entries = new Map(model.entryPoints.map((e) => [e.unitId, e.detail ?? e.reason]));
    const keyOf = (id: string) => `${ai}:${id}`;
    const live = new Set(model.units.map((u) => u.id));
    const artifact = safeName(inp.label);

    for (const u of model.units) {
      let text = terminalSafe(renderUnit(u, nameById));
      if (text.length > MAX_TEXT_CHARS) text = `${text.slice(0, MAX_TEXT_CHARS)}\n// [ree] truncated for display`;
      const { tags, signals } = classify(u, text);
      const file = fileOf(u.name);
      const entryDetail = entries.get(u.id);
      parts.push({
        key: keyOf(u.id),
        unitId: u.id,
        name: safeName(u.name),
        artifact,
        file: file ? safeName(file) : undefined,
        kind: u.kind,
        category: tags[0]!,
        tags,
        signals,
        isEntry: entries.has(u.id),
        entryReason: entryDetail !== undefined ? safeName(String(entryDetail)) : undefined,
        uses: [...new Set(u.references.filter((r) => live.has(r) && r !== u.id))].map(keyOf),
        usedBy: [],
        text,
        tokens: estimateTokens(text),
      });
    }

    // When the artifact *is* a library (Gson, Newtonsoft.Json…), "library" says
    // nothing — group its parts by what they do instead.
    const mine = parts.filter((p) => p.key.startsWith(`${ai}:`));
    const libs = mine.filter((p) => p.tags[0] === "library");
    if (mine.length >= 3 && libs.length >= mine.length * 0.9) {
      for (const p of libs) {
        p.tags = p.tags.filter((t) => t !== "library");
        if (!p.tags.length) p.tags.push(p.kind === "module" && !p.text.trim() ? "data" : "logic");
        p.category = p.tags[0]!;
        p.signals = p.signals.filter((x) => x !== "third-party path");
      }
    }

    for (const f of report.findings) {
      if (f.action !== "pruned" && f.action !== "quarantined") continue;
      removedTotal++;
      if (removed.length < MAX_REMOVED) removed.push({ artifact, action: f.action, pass: f.pass, message: safeName(f.message) });
    }
    for (const l of inp.result.limitations) {
      const line = inputs.length > 1 && artifact ? `${artifact}: ${l}` : l;
      const safe = terminalSafe(line, false);
      if (!limitations.includes(safe)) limitations.push(safe);
    }
  });

  const byKey = new Map(parts.map((p) => [p.key, p]));
  for (const p of parts) for (const k of p.uses) byKey.get(k)?.usedBy.push(p.key);

  const base = source.split(/[/\\]/).filter(Boolean).pop() ?? source;
  return {
    source,
    title: safeName(base),
    formats,
    artifacts: inputs.map((i) => safeName(i.label)).filter(Boolean),
    parts,
    removed,
    removedTotal,
    limitations,
    stats,
  };
}

/** Parts in a category; "entry" is the set of entry-point parts. */
export function partsIn(map: PartsMap, cat: PartCategory): Part[] {
  const list = cat === "entry" ? map.parts.filter((p) => p.isEntry) : map.parts.filter((p) => p.category === cat);
  return list.sort((a, b) => b.usedBy.length - a.usedBy.length || a.name.localeCompare(b.name));
}

export function categoryCounts(map: PartsMap): { cat: PartCategory; count: number }[] {
  return CATEGORY_ORDER.map((cat) => ({ cat, count: partsIn(map, cat).length })).filter((c) => c.count > 0);
}
