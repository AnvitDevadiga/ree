import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { knownClients, type SetupEnv } from "../src/setup/clients.js";
import { applyPlan, claudeInvocation, isNpxEntry, launchCommand, npxLaunch, planSetup, printableConfig, readJsonConfig, stableNode, SKILL_MARKER, type RunResult, type SetupDeps } from "../src/setup/setup.js";
import { compareVersions, installKind, latestVersion, updateAdvice, type Fetcher } from "../src/setup/update.js";

const SKILL = resolve("skills/ree/SKILL.md");
const LAUNCH = { command: "/usr/bin/node", args: ["/opt/ree/dist/cli/index.js", "mcp"] };
const win = process.platform === "win32";

function home(platform: NodeJS.Platform = "linux") {
  const h = mkdtempSync(join(tmpdir(), "ree-setup-"));
  const env: SetupEnv = { home: h, platform, which: () => false, exists: existsSync };
  return { h, env };
}

function deps(env: SetupEnv, calls: string[][] = [], status = 0): SetupDeps {
  return {
    env,
    skillSource: SKILL,
    now: () => new Date("2026-11-24T10:00:00Z"),
    runClaude: (args: string[]): RunResult => {
      calls.push(args);
      return { status, stdout: "", stderr: status ? "boom" : "" };
    },
  };
}

const action = (plan: ReturnType<typeof planSetup>, client: string, kind = "mcp") => plan.find((p) => p.client === client && p.kind === kind)?.action;

test("setup: only installed clients are configured; others are skipped, not created", () => {
  const { h, env } = home();
  mkdirSync(join(h, ".cursor"));
  const plan = planSetup(deps(env), LAUNCH);
  assert.equal(action(plan, "cursor"), "add");
  assert.equal(action(plan, "claude-desktop"), "skip");
  assert.equal(action(plan, "vscode"), "skip");
  assert.equal(action(plan, "claude-code"), "skip");
  applyPlan(deps(env), LAUNCH, plan);
  assert.ok(existsSync(join(h, ".cursor", "mcp.json")));
  assert.ok(!existsSync(join(h, ".config", "Claude")), "never creates folders for apps that aren't installed");
});

test("setup: adds REE beside existing servers, keeps every other key, backs up, is idempotent", () => {
  const { h, env } = home("darwin");
  const dir = join(h, "Library", "Application Support", "Claude");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "claude_desktop_config.json");
  const original = { theme: "dark", mcpServers: { other: { command: "x", args: ["y"] } }, nested: { keep: [1, 2] } };
  writeFileSync(file, JSON.stringify(original));
  if (!win) chmodSync(file, 0o600);
  const plan = planSetup(deps(env), LAUNCH);
  assert.equal(action(plan, "claude-desktop"), "add");
  const res = applyPlan(deps(env), LAUNCH, plan);
  const r = res.find((x) => x.item.client === "claude-desktop")!;
  assert.ok(r.ok, r.message);
  const after = JSON.parse(readFileSync(file, "utf8"));
  assert.deepEqual(after.mcpServers.other, original.mcpServers.other);
  assert.equal(after.theme, "dark");
  assert.deepEqual(after.nested, original.nested);
  assert.deepEqual(after.mcpServers.ree, { command: LAUNCH.command, args: LAUNCH.args });
  assert.ok(r.backup && JSON.parse(readFileSync(r.backup, "utf8")).theme === "dark", "backup holds the original");
  if (!win) assert.equal(statSync(file).mode & 0o777, 0o600, "permissions preserved");
  assert.equal(readdirSync(dir).filter((f) => f.includes(".ree-tmp-")).length, 0, "no temp files left");
  assert.equal(action(planSetup(deps(env), LAUNCH), "claude-desktop"), "ok", "second run changes nothing");
  assert.equal(action(planSetup(deps(env), { ...LAUNCH, args: ["/new/path.js", "mcp"] }), "claude-desktop"), "update");
});

test("setup: VS Code entries carry type stdio; COPILOT_HOME is honored", () => {
  const { h, env } = home();
  const copilot = join(h, "copilot-home");
  mkdirSync(copilot);
  env.copilotHome = copilot;
  applyPlan(deps(env), LAUNCH, planSetup(deps(env), LAUNCH));
  const cfg = JSON.parse(readFileSync(join(copilot, "mcp-config.json"), "utf8"));
  assert.equal(cfg.mcpServers.ree.type, "stdio");
  assert.equal(cfg.mcpServers.ree.command, LAUNCH.command);
});

test("setup: invalid JSON (e.g. comments) and odd shapes are never rewritten", () => {
  const { h, env } = home();
  mkdirSync(join(h, ".cursor"));
  const file = join(h, ".cursor", "mcp.json");
  const text = '{\n  // my servers\n  "mcpServers": {}\n}\n';
  writeFileSync(file, text);
  const plan = planSetup(deps(env), LAUNCH);
  assert.equal(action(plan, "cursor"), "error");
  assert.match(plan.find((p) => p.client === "cursor")!.detail!, /won't rewrite it/);
  applyPlan(deps(env), LAUNCH, plan);
  assert.equal(readFileSync(file, "utf8"), text, "untouched");
  writeFileSync(file, '{"mcpServers": ["not", "an", "object"]}');
  assert.equal(action(planSetup(deps(env), LAUNCH), "cursor"), "error");
  writeFileSync(file, "x".repeat(10));
  assert.equal(readJsonConfig(file).status, "invalid");
});

test("setup: a symlinked config is written through to its target", { skip: win && "symlinks need privileges on Windows" }, () => {
  const { h, env } = home();
  mkdirSync(join(h, ".cursor"));
  const real = join(h, "dotfiles-cursor.json");
  writeFileSync(real, JSON.stringify({ mcpServers: { a: { command: "a" } } }));
  symlinkSync(real, join(h, ".cursor", "mcp.json"));
  applyPlan(deps(env), LAUNCH, planSetup(deps(env), LAUNCH));
  assert.ok(statSync(join(h, ".cursor", "mcp.json")).isFile());
  assert.ok(readdirSync(join(h, ".cursor")).length === 1, "the link itself is kept");
  const cfg = JSON.parse(readFileSync(real, "utf8"));
  assert.ok(cfg.mcpServers.ree && cfg.mcpServers.a, "target updated, other server kept");
});

test("setup --remove deletes only REE's entry and leaves everything else", () => {
  const { h, env } = home();
  mkdirSync(join(h, ".cursor"));
  const file = join(h, ".cursor", "mcp.json");
  writeFileSync(file, JSON.stringify({ mcpServers: { other: { command: "o" } } }));
  applyPlan(deps(env), LAUNCH, planSetup(deps(env), LAUNCH));
  const rm = planSetup(deps(env), LAUNCH, { remove: true });
  assert.equal(action(rm, "cursor"), "remove");
  applyPlan(deps(env), LAUNCH, rm);
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), { mcpServers: { other: { command: "o" } } });
  assert.equal(action(planSetup(deps(env), LAUNCH, { remove: true }), "cursor"), "absent");
});

test("setup: Claude Code goes through its CLI, skill install respects files REE didn't create", () => {
  const { h, env } = home();
  env.which = (b) => b === "claude";
  const calls: string[][] = [];
  let plan = planSetup(deps(env, calls), LAUNCH);
  assert.equal(action(plan, "claude-code"), "add");
  assert.equal(action(plan, "claude-code", "skill"), "add");
  const res = applyPlan(deps(env, calls), LAUNCH, plan);
  assert.ok(res.every((r) => r.ok), JSON.stringify(res));
  assert.deepEqual(calls[0], ["mcp", "add", "--scope", "user", "ree", "--", LAUNCH.command, ...LAUNCH.args]);
  const skill = join(h, ".claude", "skills", "ree", "SKILL.md");
  assert.ok(readFileSync(skill, "utf8").includes(SKILL_MARKER));

  // Claude Code recorded the server (simulate its state file): the next plan is a no-op.
  writeFileSync(join(h, ".claude.json"), JSON.stringify({ mcpServers: { ree: { type: "stdio", command: LAUNCH.command, args: LAUNCH.args, env: {} } } }));
  plan = planSetup(deps(env, calls), LAUNCH);
  assert.equal(action(plan, "claude-code"), "ok");
  assert.equal(action(plan, "claude-code", "skill"), "ok");

  // A user's own skill named "ree" is never touched.
  writeFileSync(skill, "---\nname: ree\n---\nmy own notes\n");
  assert.equal(action(planSetup(deps(env, calls), LAUNCH), "claude-code", "skill"), "skip");
  assert.equal(action(planSetup(deps(env, calls), LAUNCH, { remove: true }), "claude-code", "skill"), "skip");

  // CLI failures are reported, not swallowed.
  const failing = applyPlan(deps(env, [], 1), LAUNCH, [{ ...plan[0]!, action: "add" }]);
  assert.equal(failing[0]!.ok, false);
  assert.match(failing[0]!.message, /boom/);
});

test("setup: CLAUDE_CONFIG_DIR moves Claude Code's state file and skills folder", () => {
  const { h, env } = home();
  env.claudeConfigDir = join(h, "cc");
  const cc = knownClients(env).find((c) => c.id === "claude-code") as { stateFile: string; skillDir: string };
  assert.equal(cc.stateFile, join(h, "cc", ".claude.json"));
  assert.equal(cc.skillDir, join(h, "cc", "skills", "ree"));
});

test("setup: launch command — this installation, npx when run from npx's cache, built CLI in dev", () => {
  // Windows registers `cmd /c npx …`, elsewhere an absolute npx: both are npx entries.
  assert.ok(isNpxEntry(launchCommand({ npx: true })));
  assert.ok(isNpxEntry(launchCommand({ scriptPath: "/home/u/.npm/_npx/abc/node_modules/ree/dist/cli/index.js" })));
  const { script } = fakeInstall();
  const l = launchCommand({ scriptPath: script, execPath: "/usr/bin/node" });
  assert.deepEqual(l, { command: "/usr/bin/node", args: [script, "mcp"] });
  assert.equal(stableNode(process.execPath, null), process.execPath);
  assert.equal(stableNode(process.execPath, process.execPath), process.execPath);
  assert.equal(stableNode(process.execPath, "/no/such/node"), process.execPath);
  const printed = printableConfig({ command: "/a b/node", args: ["/x/index.js", "mcp"] });
  assert.match(printed, /claude mcp add --scope user ree -- "\/a b\/node" \/x\/index\.js mcp/);
  assert.match(printed, /"type": "stdio"/);
});

test("cli: setup --dry-run and --json change nothing; bad clients are rejected", async () => {
  const { spawnSync } = await import("node:child_process");
  const { h } = home();
  mkdirSync(join(h, ".cursor"));
  const run = (args: string[]) =>
    spawnSync(process.execPath, ["--import", "tsx", resolve("src/cli/index.ts"), "setup", ...args], {
      encoding: "utf8",
      env: { ...process.env, HOME: h, USERPROFILE: h, APPDATA: join(h, "AppData"), XDG_CONFIG_HOME: join(h, ".config"), COPILOT_HOME: join(h, ".copilot"), PATH: "", CI: "true" },
      timeout: 120_000,
    });
  const dry = run(["--dry-run"]);
  assert.equal(dry.status, 0, dry.stderr);
  assert.match(dry.stdout, /\+ add\s+Cursor/);
  assert.ok(!existsSync(join(h, ".cursor", "mcp.json")));
  const json = JSON.parse(run(["--json"]).stdout);
  assert.equal(json.plan.find((p: { client: string }) => p.client === "cursor").action, "add");
  assert.ok(!existsSync(join(h, ".cursor", "mcp.json")), "--json without --yes only plans");
  const noTty = run([]);
  assert.match(noTty.stdout, /Re-run with --yes/);
  assert.ok(!existsSync(join(h, ".cursor", "mcp.json")));
  const yes = run(["--yes", "--client", "cursor"]);
  assert.equal(yes.status, 0, yes.stderr);
  assert.ok(JSON.parse(readFileSync(join(h, ".cursor", "mcp.json"), "utf8")).mcpServers.ree);
  assert.equal(run(["--client", "nope"]).status, 2);
});

// ─── update ───────────────────────────────────────────────────────────────

test("update: version comparison", () => {
  assert.equal(compareVersions("2.0.1", "2.0.0"), 1);
  assert.equal(compareVersions("2.0.0", "2.0.0"), 0);
  assert.equal(compareVersions("1.9.9", "2.0.0"), -1);
  assert.equal(compareVersions("2.0.0-beta.1", "2.0.0"), -1);
  assert.equal(compareVersions("v2.10.0", "2.9.9"), 1);
});

test("update: install kind and advice", () => {
  assert.equal(installKind("/Users/u/.npm/_npx/123/node_modules/ree-reverse-engineer-everything/dist/setup/update.js"), "npx");
  assert.equal(installKind("/usr/local/lib/node_modules/ree-reverse-engineer-everything/dist/setup/update.js"), "global");
  assert.equal(installKind("C:\\Users\\u\\AppData\\Roaming\\npm\\node_modules\\ree-reverse-engineer-everything\\dist\\setup\\update.js"), "global");
  assert.equal(installKind(resolve("src/setup/update.ts")), "checkout");
  assert.equal(installKind("/work/app/node_modules/ree-reverse-engineer-everything/dist/setup/update.js"), "project");
  assert.deepEqual(updateAdvice("global", "2.1.0").run, ["npm", "install", "--global", "ree-reverse-engineer-everything@2.1.0"]);
  assert.equal(updateAdvice("npx", "2.1.0").run, undefined, "never runs anything for npx");
  assert.match(updateAdvice("checkout", "2.1.0").message, /git pull/);
});

test("update: registry answers, 404, garbage and timeouts", async () => {
  const reply = (status: number, body: unknown): Fetcher => async () => ({ ok: status === 200, status, json: async () => body });
  assert.deepEqual(await latestVersion(reply(200, { version: "2.3.4" })), { latest: "2.3.4" });
  assert.match((await latestVersion(reply(404, {}))).error!, /isn't published/);
  assert.match((await latestVersion(reply(500, {}))).error!, /HTTP 500/);
  assert.match((await latestVersion(reply(200, { version: "<script>" }))).error!, /unexpected/);
  const hang: Fetcher = (_u, init) => new Promise((_r, rej) => init.signal.addEventListener("abort", () => rej(new Error("aborted"))));
  assert.match((await latestVersion(hang, 50)).error!, /didn't answer/);
});

// ─── regressions from the Phase 7 review ─────────────────────────────────

test("review: Windows .cmd shims get every argument quoted for cmd.exe", () => {
  const inv = claudeInvocation("C:\\Users\\me\\AppData\\Roaming\\npm\\claude.cmd", ["mcp", "add", "--", "C:\\Program Files\\nodejs\\node.exe", "C:\\a b\\index.js", "mcp"], "win32");
  assert.equal(inv.file, "cmd.exe");
  assert.equal(inv.verbatim, true);
  assert.deepEqual(inv.args.slice(0, 3), ["/d", "/s", "/c"]);
  assert.match(inv.args[3]!, /"C:\\Program Files\\nodejs\\node\.exe"/);
  assert.match(inv.args[3]!, /"C:\\a b\\index\.js"/);
  assert.deepEqual(claudeInvocation("/usr/local/bin/claude", ["a b"], "darwin"), { file: "/usr/local/bin/claude", args: ["a b"], verbatim: false });
  assert.equal(claudeInvocation("C:\\x\\claude.exe", ["x"], "win32").file, "C:\\x\\claude.exe", ".exe needs no shell");
});

test("review: npx is registered absolutely (GUI apps lack PATH) and via cmd on Windows", () => {
  assert.deepEqual(npxLaunch("C:\\node\\node.exe", "win32"), { command: "cmd", args: ["/c", "npx", "-y", "ree-reverse-engineer-everything", "mcp"] });
  const nx = npxLaunch(process.execPath, process.platform === "win32" ? "linux" : process.platform);
  assert.ok(nx.command === "npx" || nx.command.endsWith("npx"));
  assert.ok(isNpxEntry(nx));
  assert.ok(!isNpxEntry(LAUNCH));
});

test("review: running from source registers the built CLI, never a missing src/cli/index.js", () => {
  // Self-contained layout: tests must not depend on `npm run build` having run.
  const { root, script } = fakeInstall();
  const l = launchCommand({ scriptPath: join(root, "src", "cli", "index.js"), execPath: "/usr/bin/node" });
  assert.deepEqual(l.args, [script, "mcp"]);
  // No build at all: fall back to npx rather than register a missing file.
  const bare = mkdtempSync(join(tmpdir(), "ree-nobuild-"));
  assert.ok(isNpxEntry(launchCommand({ scriptPath: join(bare, "src", "cli", "index.js"), execPath: "/usr/bin/node" })));
});

function fakeInstall(): { root: string; script: string } {
  const root = mkdtempSync(join(tmpdir(), "ree-install-"));
  mkdirSync(join(root, "dist", "cli"), { recursive: true });
  const script = join(root, "dist", "cli", "index.js");
  writeFileSync(script, "// built CLI");
  return { root, script };
}

test("review: a failed Claude Code re-register restores the previous entry, keeping its env", () => {
  const { h, env } = home();
  env.which = (b) => b === "claude";
  writeFileSync(join(h, ".claude.json"), JSON.stringify({ mcpServers: { ree: { command: "/old/node", args: ["/old/index.js", "mcp"], env: { GROQ_API_KEY: "k" } } } }));
  const calls: string[][] = [];
  const d: SetupDeps = {
    ...deps(env),
    runClaude: (args) => {
      calls.push(args);
      const isNewAdd = args[1] === "add" && args.includes(LAUNCH.command);
      return { status: isNewAdd ? 1 : 0, stdout: "", stderr: isNewAdd ? "spawn timeout" : "" };
    },
  };
  const plan = planSetup(d, LAUNCH).filter((p) => p.kind === "mcp");
  assert.equal(plan[0]!.action, "update");
  const [res] = applyPlan(d, LAUNCH, plan);
  assert.equal(res!.ok, false);
  assert.match(res!.message, /previous REE entry was restored/);
  assert.deepEqual(calls.map((c) => c[1]), ["remove", "add", "add"]);
  assert.ok(calls[1]!.includes("GROQ_API_KEY=k"), "the new entry keeps the user's env");
  assert.ok(calls[1]!.indexOf("ree") < calls[1]!.indexOf("-e"), "server name precedes the variadic -e option");
  assert.ok(calls[2]!.includes("/old/node") && calls[2]!.includes("GROQ_API_KEY=k"), "the old entry is restored with its env");
});

test("review: updating a JSON entry keeps fields the user added (env keys)", () => {
  const { h, env } = home();
  mkdirSync(join(h, ".cursor"));
  const file = join(h, ".cursor", "mcp.json");
  writeFileSync(file, JSON.stringify({ mcpServers: { ree: { command: "/old", args: ["x"], env: { ANTHROPIC_API_KEY: "secret" }, disabled: false } } }));
  applyPlan(deps(env), LAUNCH, planSetup(deps(env), LAUNCH));
  const e = JSON.parse(readFileSync(file, "utf8")).mcpServers.ree;
  assert.equal(e.command, LAUNCH.command);
  assert.deepEqual(e.env, { ANTHROPIC_API_KEY: "secret" });
  assert.equal(e.disabled, false);
});

test("review: an existing npx registration is respected, not flagged or replaced", () => {
  const { h, env } = home();
  mkdirSync(join(h, ".cursor"));
  writeFileSync(join(h, ".cursor", "mcp.json"), JSON.stringify({ mcpServers: { ree: { command: "/usr/local/bin/npx", args: ["-y", "ree-reverse-engineer-everything", "mcp"] } } }));
  const p = planSetup(deps(env), LAUNCH).find((x) => x.client === "cursor")!;
  assert.equal(p.action, "ok");
  assert.match(p.detail!, /via npx/);
});

test("review: skill updates leave no backups, so --remove cleans the folder", () => {
  const { h, env } = home();
  env.which = (b) => b === "claude";
  const skillDir = join(h, ".claude", "skills", "ree");
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(join(skillDir, "SKILL.md"), `old\n${SKILL_MARKER}\n`);
  applyPlan(deps(env), LAUNCH, planSetup(deps(env), LAUNCH).filter((p) => p.kind === "skill"));
  assert.deepEqual(readdirSync(skillDir), ["SKILL.md"]);
  applyPlan(deps(env), LAUNCH, planSetup(deps(env), LAUNCH, { remove: true }).filter((p) => p.kind === "skill"));
  assert.ok(!existsSync(skillDir));
});

test("review: pnpm/bun/volta installs are never updated with npm --global", () => {
  assert.equal(installKind("/work/app/node_modules/.pnpm/ree-reverse-engineer-everything@2.0.0/node_modules/ree-reverse-engineer-everything/dist/setup/update.js"), "project");
  assert.equal(installKind("/Users/u/Library/pnpm/global/5/node_modules/ree-reverse-engineer-everything/dist/setup/update.js"), "other-global");
  assert.equal(installKind("/Users/u/.bun/install/global/node_modules/ree-reverse-engineer-everything/dist/setup/update.js"), "other-global");
  assert.equal(installKind("/Users/u/.volta/tools/image/packages/ree-reverse-engineer-everything/lib/node_modules/ree-reverse-engineer-everything/dist/setup/update.js"), "other-global");
  assert.equal(updateAdvice("other-global", "2.1.0").run, undefined);
});
