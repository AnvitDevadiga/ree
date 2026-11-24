/**
 * `ree setup`: connect REE's MCP server (and, for Claude Code, its skill) to the
 * AI agents installed on this machine.
 *
 * Safety rules — these files belong to other apps and to the user:
 *   • plan first, show it, apply only after confirmation (or --yes);
 *   • only the "ree" entry is ever added, changed or removed — never anything else;
 *   • a file that isn't valid JSON (e.g. has comments) is never rewritten; the user
 *     gets the exact entry to paste instead;
 *   • every existing file is backed up before it changes, written atomically,
 *     keeps its permissions, and a symlinked config is written through to its
 *     target (dotfile managers keep working);
 *   • Claude Code is configured through its own `claude mcp` CLI, never by editing
 *     its state file;
 *   • a skill file REE didn't install is never overwritten or deleted.
 */
import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, rmdirSync, readdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { knownClients, type Client, type ClientId, type JsonClient, type SetupEnv } from "./clients.js";

export const PACKAGE = "ree-reverse-engineer-everything";
export const SERVER_NAME = "ree";
export const SKILL_MARKER = "<!-- installed by ree setup -->";
const MAX_CONFIG_BYTES = 5 * 1024 * 1024;
const MAX_STATE_BYTES = 64 * 1024 * 1024;

export interface Launch {
  command: string;
  args: string[];
}

/**
 * How agents should start REE's MCP server: the same REE that is running setup.
 * A run from npx's temporary cache would vanish, so that case registers `npx`.
 */
export interface LaunchOptions {
  npx?: boolean;
  scriptPath?: string;
  execPath?: string;
  nodeOnPath?: string | null;
  platform?: NodeJS.Platform;
}

export function launchCommand(opts: LaunchOptions = {}): Launch {
  const execPath = opts.execPath ?? process.execPath;
  const platform = opts.platform ?? process.platform;
  const npx = npxLaunch(execPath, platform);
  if (opts.npx) return npx;
  let script = opts.scriptPath ?? fileURLToPath(new URL("../cli/index.js", import.meta.url));
  if (script.split(/[/\\]/).includes("_npx")) return npx;
  if (/\.tsx?$/.test(script) || !existsSync(script)) {
    // Running from source (tsx resolves src/cli/index.js to index.ts): use the built CLI.
    const built = resolve(dirname(script), "..", "..", "dist", "cli", "index.js");
    if (!existsSync(built)) return npx;
    script = built;
  }
  return { command: stableNode(execPath, opts.nodeOnPath), args: [script, "mcp"] };
}

/**
 * `npx` for agents: an absolute path (GUI apps such as Claude Desktop start
 * without the shell's PATH, so a bare `npx` from nvm/Homebrew isn't found), and
 * on Windows through `cmd /c` because `npx` is a .cmd script there.
 */
export function npxLaunch(execPath: string, platform: NodeJS.Platform): Launch {
  const args = ["-y", PACKAGE, "mcp"];
  if (platform === "win32") return { command: "cmd", args: ["/c", "npx", ...args] };
  const beside = join(dirname(execPath), "npx");
  return { command: existsSync(beside) ? beside : "npx", args };
}

/** Is this an npx-based entry for REE (what `ree setup --npx` writes)? */
export function isNpxEntry(entry: unknown): boolean {
  if (!entry || typeof entry !== "object") return false;
  const e = entry as { command?: unknown; args?: unknown };
  const all = [e.command, ...(Array.isArray(e.args) ? e.args : [])].map(String);
  return all.some((a) => /(^|[/\\])npx(\.cmd)?$/.test(a)) && all.includes(PACKAGE) && all.includes("mcp");
}

/**
 * Prefer the `node` on PATH (e.g. /opt/homebrew/bin/node, a stable symlink) over
 * the running binary's versioned path (…/Cellar/node/26.7.0/bin/node), which a
 * routine upgrade deletes. An absolute path is kept: GUI apps such as Claude
 * Desktop often start without the user's shell PATH.
 */
export function stableNode(execPath: string, nodeOnPath?: string | null): string {
  if (!nodeOnPath) return execPath;
  try {
    return realpathSync(nodeOnPath) === realpathSync(execPath) ? nodeOnPath : execPath;
  } catch {
    return execPath;
  }
}

export type Action = "add" | "update" | "ok" | "remove" | "absent" | "skip" | "error";

export interface PlanItem {
  client: ClientId;
  label: string;
  kind: "mcp" | "skill";
  target: string;
  action: Action;
  detail?: string;
  verified: boolean;
  restartHint: string;
  /** Claude Code: the entry being replaced, so a failed re-register can restore it. */
  previous?: { command: string; args: string[]; env?: Record<string, string> };
  /** Claude Code's state couldn't be read, so REE can't tell what's registered. */
  unknownState?: boolean;
}

export interface RunResult {
  status: number;
  stdout: string;
  stderr: string;
}

export interface SetupDeps {
  env: SetupEnv;
  /** Run the `claude` CLI with these arguments. */
  runClaude: (args: string[]) => RunResult;
  /** The skill file shipped with REE. */
  skillSource: string;
  now?: () => Date;
}

export interface PlanOptions {
  clients?: ClientId[];
  remove?: boolean;
}

// ─── JSON config helpers ───────────────────────────────────────────────────

type ReadResult = { status: "missing" } | { status: "ok"; data: Record<string, unknown> } | { status: "invalid"; error: string };

export function readJsonConfig(file: string, max = MAX_CONFIG_BYTES): ReadResult {
  if (!existsSync(file)) return { status: "missing" };
  try {
    const st = statSync(file);
    if (!st.isFile()) return { status: "invalid", error: "is not a regular file" };
    if (st.size > max) return { status: "invalid", error: `is larger than ${Math.round(max / 1024 / 1024)} MB` };
    const text = readFileSync(file, "utf8");
    if (!text.trim()) return { status: "ok", data: {} };
    const data = JSON.parse(text) as unknown;
    if (!data || typeof data !== "object" || Array.isArray(data)) return { status: "invalid", error: "does not contain a JSON object" };
    return { status: "ok", data: data as Record<string, unknown> };
  } catch (e) {
    return { status: "invalid", error: `is not valid JSON (${(e as Error).message.split("\n")[0]}); it may contain comments` };
  }
}

export function entryFor(client: JsonClient, launch: Launch): Record<string, unknown> {
  return { ...client.extra, command: launch.command, args: launch.args };
}

function sameEntry(a: unknown, b: Record<string, unknown>): boolean {
  if (!a || typeof a !== "object") return false;
  const x = a as Record<string, unknown>;
  return Object.keys(b).every((k) => JSON.stringify(x[k]) === JSON.stringify(b[k]));
}

function stamp(d: Date): string {
  return d.toISOString().replace(/[-:]/g, "").replace(/\..+$/, "").replace("T", "-");
}

/** Back up, then atomically write `content` to `file` (through a symlink, keeping its mode). */
export function writeFileSafely(file: string, content: string, now: Date, opts: { backup?: boolean } = {}): { backup?: string; written: string } {
  let target = file;
  let mode: number | undefined;
  let backup: string | undefined;
  if (existsSync(file)) {
    if (lstatSync(file).isSymbolicLink()) target = realpathSync(file);
    mode = statSync(target).mode & 0o777;
    if (opts.backup !== false) {
      backup = `${target}.ree-backup-${stamp(now)}`;
      for (let i = 2; existsSync(backup); i++) backup = `${target}.ree-backup-${stamp(now)}-${i}`;
      copyFileSync(target, backup);
    }
  } else {
    mkdirSync(dirname(target), { recursive: true });
  }
  const tmp = `${target}.ree-tmp-${process.pid}`;
  writeFileSync(tmp, content, { mode: mode ?? 0o600 });
  if (mode !== undefined) chmodSync(tmp, mode);
  renameSync(tmp, target);
  return { backup, written: target };
}

function serialize(data: Record<string, unknown>): string {
  return `${JSON.stringify(data, null, 2)}\n`;
}

// ─── planning ──────────────────────────────────────────────────────────────

function claudeCodeEntry(stateFile: string): { known: boolean; entry?: unknown } {
  const r = readJsonConfig(stateFile, MAX_STATE_BYTES);
  if (r.status === "missing") return { known: true };
  if (r.status === "invalid") return { known: false };
  const servers = r.data.mcpServers as Record<string, unknown> | undefined;
  return { known: true, entry: servers && typeof servers === "object" ? servers[SERVER_NAME] : undefined };
}

function skillPlan(c: Extract<Client, { id: "claude-code" }>, deps: SetupDeps, remove: boolean): PlanItem {
  const file = join(c.skillDir, "SKILL.md");
  const base = { client: c.id, label: c.label, kind: "skill" as const, target: file, verified: true, restartHint: c.restartHint };
  const exists = existsSync(file);
  const current = exists ? safeRead(file) : undefined;
  const ours = current?.includes(SKILL_MARKER) ?? false;
  if (remove) {
    if (!exists) return { ...base, action: "absent" };
    return ours ? { ...base, action: "remove" } : { ...base, action: "skip", detail: "this skill file wasn't installed by REE; left alone" };
  }
  const source = safeRead(deps.skillSource);
  if (source === undefined) return { ...base, action: "error", detail: `REE's skill file is missing from the package (${deps.skillSource})` };
  if (!exists) return { ...base, action: "add", detail: "teaches Claude how to use REE's tools" };
  if (!ours) return { ...base, action: "skip", detail: "a skill named 'ree' exists and wasn't installed by REE; left alone" };
  return current === source ? { ...base, action: "ok" } : { ...base, action: "update" };
}

function safeRead(file: string): string | undefined {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return undefined;
  }
}

export function planSetup(deps: SetupDeps, launch: Launch, opts: PlanOptions = {}): PlanItem[] {
  const items: PlanItem[] = [];
  const wanted = (id: ClientId) => !opts.clients || opts.clients.includes(id);
  for (const c of knownClients(deps.env)) {
    if (!wanted(c.id)) continue;
    const explicit = !!opts.clients?.includes(c.id);
    if (c.id === "claude-code") {
      const base = { client: c.id, label: c.label, kind: "mcp" as const, target: "claude mcp (user scope)", verified: true, restartHint: c.restartHint };
      if (!c.installed) {
        items.push({ ...base, action: "skip", detail: "the `claude` command isn't on PATH" });
        continue;
      }
      const cur = claudeCodeEntry(c.stateFile);
      const want = { command: launch.command, args: launch.args };
      const previous = asPrevious(cur.entry);
      if (opts.remove) items.push({ ...base, action: !cur.known || cur.entry ? "remove" : "absent" });
      else if (!cur.known) items.push({ ...base, action: "update", unknownState: true, detail: "couldn't read Claude Code's state; REE will (re)register itself" });
      else if (!cur.entry) items.push({ ...base, action: "add" });
      else if (sameEntry(cur.entry, want)) items.push({ ...base, action: "ok" });
      else if (keepNpx(cur.entry, launch)) items.push({ ...base, action: "ok", detail: "registered via npx (ree setup --remove, then ree setup, to switch)" });
      else items.push({ ...base, action: "update", previous });
      items.push(skillPlan(c, deps, !!opts.remove));
      continue;
    }
    const base = { client: c.id, label: c.label, kind: "mcp" as const, target: c.file, verified: c.verified, restartHint: c.restartHint };
    if (!c.installed && !explicit) {
      items.push({ ...base, action: "skip", detail: "not installed" });
      continue;
    }
    const r = readJsonConfig(c.file);
    if (r.status === "invalid") {
      items.push({ ...base, action: "error", detail: `${c.file} ${r.error} — REE won't rewrite it. Add the entry by hand (ree setup --print).` });
      continue;
    }
    const servers = r.status === "ok" ? r.data[c.key] : undefined;
    if (servers !== undefined && (typeof servers !== "object" || servers === null || Array.isArray(servers))) {
      items.push({ ...base, action: "error", detail: `"${c.key}" in ${c.file} is not an object — REE won't rewrite it` });
      continue;
    }
    const entry = (servers as Record<string, unknown> | undefined)?.[SERVER_NAME];
    if (opts.remove) items.push({ ...base, action: entry ? "remove" : "absent" });
    else if (!entry) items.push({ ...base, action: "add", detail: r.status === "missing" ? "creates the file" : undefined });
    else if (sameEntry(entry, entryFor(c, launch))) items.push({ ...base, action: "ok" });
    else if (keepNpx(entry, launch)) items.push({ ...base, action: "ok", detail: "registered via npx (ree setup --remove, then ree setup, to switch)" });
    else items.push({ ...base, action: "update" });
  }
  return items;
}

/** An existing npx registration stays unless the user asked for npx-vs-local explicitly. */
function keepNpx(existing: unknown, launch: Launch): boolean {
  return isNpxEntry(existing) && !isNpxEntry(launch);
}

function asPrevious(entry: unknown): PlanItem["previous"] {
  if (!entry || typeof entry !== "object") return undefined;
  const e = entry as { command?: unknown; args?: unknown; env?: unknown };
  if (typeof e.command !== "string") return undefined;
  const args = Array.isArray(e.args) ? e.args.map(String) : [];
  const env = e.env && typeof e.env === "object" ? Object.fromEntries(Object.entries(e.env as Record<string, unknown>).map(([k, v]) => [k, String(v)])) : undefined;
  return { command: e.command, args, env };
}

// ─── applying ──────────────────────────────────────────────────────────────

export interface ApplyResult {
  item: PlanItem;
  ok: boolean;
  message: string;
  backup?: string;
}

export function applyPlan(deps: SetupDeps, launch: Launch, plan: PlanItem[]): ApplyResult[] {
  const now = (deps.now ?? (() => new Date()))();
  const clients = new Map(knownClients(deps.env).map((c) => [c.id, c]));
  const out: ApplyResult[] = [];
  for (const item of plan) {
    if (!["add", "update", "remove"].includes(item.action)) continue;
    const c = clients.get(item.client)!;
    try {
      if (c.id === "claude-code" && item.kind === "mcp") {
        // Name before -e: `-e` is variadic in `claude mcp add` and would swallow the name.
        const addArgs = (cmd: string, args: string[], env?: Record<string, string>) => [
          "mcp", "add", "--scope", "user", SERVER_NAME,
          ...Object.entries(env ?? {}).flatMap(([k, v]) => ["-e", `${k}=${v}`]),
          "--", cmd, ...args,
        ];
        if (item.action !== "add") {
          const rm = deps.runClaude(["mcp", "remove", "--scope", "user", SERVER_NAME]);
          if (item.action === "remove" && rm.status !== 0 && !/not found|no .*server/i.test(rm.stderr + rm.stdout)) throw new Error(firstLine(rm.stderr || rm.stdout));
        }
        if (item.action !== "remove") {
          // Keep any environment the user gave REE's entry (e.g. provider keys).
          const add = deps.runClaude(addArgs(launch.command, launch.args, item.previous?.env));
          if (add.status !== 0) {
            const why = firstLine(add.stderr || add.stdout) || `claude exited with ${add.status}`;
            if (item.previous) {
              // The old entry is already removed: put it back rather than leave REE disconnected.
              const back = deps.runClaude(addArgs(item.previous.command, item.previous.args, item.previous.env));
              throw new Error(back.status === 0 ? `${why} — your previous REE entry was restored` : `${why} — and restoring the previous entry also failed; run 'ree setup' again`);
            }
            throw new Error(why);
          }
        }
        out.push({ item, ok: true, message: item.action === "remove" ? "removed from Claude Code" : "registered with Claude Code" });
      } else if (c.id === "claude-code" && item.kind === "skill") {
        const file = item.target;
        if (item.action === "remove") {
          unlinkSync(file);
          try {
            if (readdirSync(dirname(file)).length === 0) rmdirSync(dirname(file));
          } catch {
            /* leave a non-empty folder */
          }
          out.push({ item, ok: true, message: "skill removed" });
        } else {
          // REE's own file, reproducible from the package: no backup (it would stop
          // `--remove` from cleaning up the skill folder).
          const r = writeFileSafely(file, readFileSync(deps.skillSource, "utf8"), now, { backup: false });
          out.push({ item, ok: true, message: item.action === "add" ? "skill installed" : "skill updated", backup: r.backup });
        }
      } else if (c.id !== "claude-code") {
        // Re-read right before writing: never act on a stale view of someone else's file.
        const r = readJsonConfig(c.file);
        if (r.status === "invalid") throw new Error(`${c.file} ${r.error}`);
        const data = r.status === "ok" ? r.data : {};
        const existing = data[c.key];
        if (existing !== undefined && (typeof existing !== "object" || existing === null || Array.isArray(existing))) throw new Error(`"${c.key}" in ${c.file} is not an object — REE won't rewrite it`);
        const servers = { ...((existing as Record<string, unknown> | undefined) ?? {}) };
        const old = servers[SERVER_NAME];
        if (item.action === "remove") delete servers[SERVER_NAME];
        // Merge: keep fields the user added to REE's entry (env with provider keys, disabled…).
        else servers[SERVER_NAME] = { ...(old && typeof old === "object" ? (old as Record<string, unknown>) : {}), ...entryFor(c, launch) };
        const next = { ...data, [c.key]: servers };
        const w = writeFileSafely(c.file, serialize(next), now);
        out.push({ item, ok: true, message: item.action === "remove" ? "entry removed" : item.action === "add" ? "entry added" : "entry updated", backup: w.backup });
      }
    } catch (e) {
      out.push({ item, ok: false, message: (e as Error).message });
    }
  }
  return out;
}

function firstLine(s: string): string {
  return s.trim().split("\n")[0] ?? "";
}

/** Copy-paste configuration for every client, including ones setup doesn't edit. */
export function printableConfig(launch: Launch): string {
  const std = { command: launch.command, args: launch.args };
  const block = (o: unknown) => JSON.stringify(o, null, 2);
  const quote = (a: string) => (/[\s"']/.test(a) ? JSON.stringify(a) : a);
  return [
    "Claude Code:",
    `  claude mcp add --scope user ${SERVER_NAME} -- ${[launch.command, ...launch.args].map(quote).join(" ")}`,
    "",
    "Claude Desktop, Cursor, Windsurf and most other MCP clients (mcpServers format):",
    block({ mcpServers: { [SERVER_NAME]: std } }),
    "",
    "VS Code (Copilot) — ~/.copilot/mcp-config.json:",
    block({ mcpServers: { [SERVER_NAME]: { type: "stdio", ...std, tools: ["*"] } } }),
  ].join("\n");
}

/**
 * How to run the `claude` CLI with these arguments, safely on every OS. On Windows
 * `claude` is usually a .cmd shim, which needs cmd.exe — and cmd.exe needs each
 * argument quoted, or a path such as C:\Program Files\nodejs\node.exe splits.
 */
export function claudeInvocation(claudePath: string, args: string[], platform: NodeJS.Platform = process.platform): { file: string; args: string[]; verbatim: boolean } {
  if (platform !== "win32" || !/\.(cmd|bat)$/i.test(claudePath)) return { file: claudePath, args, verbatim: false };
  const q = (a: string) => (a === "" || /[\s"&|<>^()%!]/.test(a) ? `"${a.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, "$1$1")}"` : a);
  return { file: "cmd.exe", args: ["/d", "/s", "/c", `"${[claudePath, ...args].map(q).join(" ")}"`], verbatim: true };
}
