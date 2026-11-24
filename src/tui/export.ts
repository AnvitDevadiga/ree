/**
 * Export a parts map as a workspace folder: a README map of the app, one Markdown
 * file per part (cleaned code, connections, a space for notes) and a JSON index.
 *
 * It's for studying how something is built and designing your own version. It
 * contains REE's cleaned, read-only view: nothing here can be rebuilt into, or
 * repackaged as, the original app.
 *
 * Every file name comes from the artifact, so names are reduced to a safe
 * character set, Windows-reserved names are avoided, collisions are numbered, and
 * every write is checked to stay inside the output folder. The export never
 * overwrites or deletes: an existing non-empty folder gets a numbered sibling.
 */
import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { CATEGORY_INFO, CATEGORY_ORDER, categoryCounts, partsIn, type Part, type PartCategory, type PartsMap } from "./parts.js";

export interface ExportOptions {
  maxParts?: number;
  maxPartBytes?: number;
  /** Generated-on date, injectable for deterministic tests. */
  date?: string;
}

export interface ExportResult {
  dir: string;
  files: number;
  partsWritten: number;
  partsSkipped: number;
}

const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/i;

/** Reduce a name to a portable file-name segment. */
export function safeSegment(raw: string, max = 60): string {
  let s = raw
    .normalize("NFKD")
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/\.{2,}/g, ".")
    .replace(/-{2,}/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "");
  if (s.length > max) s = s.slice(0, max).replace(/[-.]+$/g, "");
  if (!s) s = "part";
  if (WINDOWS_RESERVED.test(s.split(".")[0]!)) s = `_${s}`;
  return s;
}

/** A Markdown fence longer than any backtick run inside the text. */
export function fenceFor(text: string): string {
  let longest = 0;
  for (const m of text.matchAll(/`+/g)) longest = Math.max(longest, m[0].length);
  return "`".repeat(Math.max(3, longest + 1));
}

/** Drop omitted (null) lines, then collapse runs of blank lines. */
function tidy(lines: (string | null)[]): string {
  const kept = lines.filter((l): l is string => l !== null);
  return kept.filter((l, i) => l !== "" || (i > 0 && kept[i - 1] !== "")).join("\n") + "\n";
}

function langOf(p: Part): string {
  const f = (p.file ?? p.name).toLowerCase();
  if (/\.(m?js|cjs)$/.test(f)) return "js";
  if (/\.tsx?$/.test(f)) return "ts";
  if (/\.html?$/.test(f)) return "html";
  if (/\.css$/.test(f)) return "css";
  if (/\.json$/.test(f)) return "json";
  if (/\.(java|class)$/.test(f)) return "java";
  if (/\.cs$/.test(f)) return "csharp";
  if (/\.py[c]?$/.test(f)) return "python";
  return "";
}

/** Inline text for Markdown: no newlines, no link/HTML syntax that could hide content. */
function mdInline(s: string): string {
  return s.replace(/[\r\n]+/g, " ").replace(/([\\`*_[\]<>|])/g, "\\$1");
}

/** A Mermaid-safe label. */
function mermaidLabel(s: string): string {
  return s.replace(/[^A-Za-z0-9 _./#:-]/g, "").slice(0, 40) || "part";
}

function pickOutDir(requested: string): string {
  const base = resolve(requested);
  // Free = missing, or an empty directory. An existing *file* is never free.
  const free = (d: string) => !existsSync(d) || (statSync(d).isDirectory() && readdirSync(d).length === 0);
  if (free(base)) return base;
  for (let i = 2; i < 1000; i++) {
    const d = `${base}-${i}`;
    if (free(d)) return d;
  }
  throw new Error(`no free folder name next to ${base}`);
}

export function defaultExportDir(map: PartsMap, cwd = process.cwd()): string {
  return join(cwd, `${safeSegment(map.title, 40)}-parts`);
}

export function exportWorkspace(map: PartsMap, requestedDir: string, opts: ExportOptions = {}): ExportResult {
  const maxParts = opts.maxParts ?? 5000;
  const maxPartBytes = opts.maxPartBytes ?? 512 * 1024;
  const date = opts.date ?? new Date().toISOString().slice(0, 10);
  const dir = pickOutDir(requestedDir);
  let files = 0;

  const write = (rel: string, content: string) => {
    const target = resolve(dir, rel);
    const r = relative(dir, target);
    if (r.startsWith("..") || r.includes(`..${sep}`) || resolve(target) === dir) throw new Error(`refusing to write outside the export folder: ${rel}`);
    mkdirSync(resolve(target, ".."), { recursive: true });
    writeFileSync(target, content, { flag: "wx" }); // never overwrite
    files++;
  };

  // Assign each part a unique file path.
  const pathOf = new Map<string, string>();
  const used = new Set<string>();
  const ordered = CATEGORY_ORDER.filter((c) => c !== "entry").flatMap((c) => partsIn(map, c));
  const toWrite = ordered.slice(0, maxParts);
  for (const p of toWrite) {
    const folder = safeSegment(CATEGORY_INFO[p.category].label.toLowerCase(), 30);
    const stem = safeSegment(p.file && p.name !== p.file ? `${p.file}-${p.name}` : p.name);
    let rel = `parts/${folder}/${stem}.md`;
    for (let i = 2; used.has(rel.toLowerCase()); i++) rel = `parts/${folder}/${stem}-${i}.md`;
    used.add(rel.toLowerCase());
    pathOf.set(p.key, rel);
  }
  const byKey = new Map(map.parts.map((p) => [p.key, p]));
  const link = (fromRel: string, key: string): string => {
    const p = byKey.get(key);
    if (!p) return "";
    const to = pathOf.get(key);
    if (!to) return mdInline(p.name);
    const up = fromRel.split("/").length - 1;
    return `[${mdInline(p.name)}](${"../".repeat(up)}${to})`;
  };

  // One file per part.
  for (const p of toWrite) {
    const rel = pathOf.get(p.key)!;
    let code = p.text;
    if (Buffer.byteLength(code) > maxPartBytes) {
      // Cut by bytes; drop a trailing partial character rather than write U+FFFD.
      code = `${Buffer.from(code).subarray(0, maxPartBytes).toString("utf8").replace(/\uFFFD$/, "")}\n// [ree] truncated in this export`;
    }
    const fence = fenceFor(code);
    const lines: (string | null)[] = [
      `# ${mdInline(p.name)}`,
      "",
      `**Group:** ${CATEGORY_INFO[p.category].label}${p.tags.length > 1 ? ` (also: ${p.tags.slice(1).map((t) => CATEGORY_INFO[t].label).join(", ")})` : ""}  `,
      p.artifact ? `**Inside:** ${mdInline(p.artifact)}  ` : null,
      p.file ? `**File:** \`${p.file.replace(/`/g, "'")}\`  ` : null,
      `**Kind:** ${p.kind} · about ${p.tokens} tokens  `,
      p.isEntry ? `**Starting point:** ${mdInline(p.entryReason ?? "yes")}  ` : null,
      p.signals.length ? `**Evidence:** ${p.signals.map(mdInline).join(", ")}` : null,
      "",
      "## Connections",
      "",
      `- **Uses:** ${p.uses.map((k) => link(rel, k)).filter(Boolean).join(", ") || "nothing REE could resolve"}`,
      `- **Used by:** ${p.usedBy.map((k) => link(rel, k)).filter(Boolean).join(", ") || "nothing REE could resolve"}`,
      "",
      "## Code (cleaned by REE)",
      "",
      `${fence}${langOf(p)}`,
      code,
      fence,
      "",
      "## Your notes",
      "",
      "- What does this part do?",
      "- What would you do differently in your own version?",
      "",
    ];
    write(rel, tidy(lines));
  }

  // The map.
  const counts = categoryCounts(map);
  const entries = partsIn(map, "entry");
  const graphParts = [...toWrite].sort((a, b) => b.uses.length + b.usedBy.length - (a.uses.length + a.usedBy.length)).slice(0, 30);
  const gIds = new Map(graphParts.map((p, i) => [p.key, `p${i}`]));
  const edges: string[] = [];
  for (const p of graphParts) for (const k of p.uses) if (gIds.has(k) && edges.length < 80) edges.push(`  ${gIds.get(p.key)} --> ${gIds.get(k)}`);
  const readme: (string | null)[] = [
    `# Parts of ${mdInline(map.title)}`,
    "",
    `An exploded view of \`${map.title.replace(/`/g, "'")}\`, generated by [REE](https://github.com/AnvitDevadiga/ree) on ${date}.`,
    "REE read it statically (nothing was run), removed decoys and planted instructions, and grouped what's left by what each part does.",
    "",
    "> **Use this to learn how it's built, then write your own code.** The recovered code still belongs to its authors:",
    "> reuse open-source code only under its license (keep attribution for MIT/Apache, honor copyleft for GPL), and don't copy",
    "> proprietary code into your product.",
    "",
    "## At a glance",
    "",
    `| | |`,
    `|---|---|`,
    `| Format | ${map.formats.join(", ")} |`,
    map.artifacts.length > 1 ? `| Pieces inside | ${map.artifacts.length} |` : null,
    `| Parts | ${map.parts.length}${toWrite.length < ordered.length ? ` (first ${toWrite.length} exported)` : ""} |`,
    `| Decoys / filler removed | ${map.stats.removed} |`,
    `| Planted AI instructions removed | ${map.stats.instructionsRedacted} |`,
    "",
    "## Groups",
    "",
    ...counts.map(({ cat, count }) => `- **${CATEGORY_INFO[cat].icon} ${CATEGORY_INFO[cat].label}** (${count}) — ${CATEGORY_INFO[cat].blurb}`),
    "",
    entries.length ? "## Start here" : null,
    entries.length ? "" : null,
    ...entries.slice(0, 50).map((p) => `- ${link("README.md", p.key)}${p.entryReason ? ` — ${mdInline(p.entryReason)}` : ""}`),
    "",
    edges.length ? "## How the main parts connect" : null,
    edges.length ? "" : null,
    edges.length ? "```mermaid" : null,
    edges.length ? "flowchart LR" : null,
    ...(edges.length ? graphParts.map((p) => `  ${gIds.get(p.key)}["${mermaidLabel(p.name)}"]`) : []),
    ...edges,
    edges.length ? "```" : null,
    "",
    "## All parts",
    "",
    ...(CATEGORY_ORDER.filter((c) => c !== "entry") as PartCategory[]).flatMap((cat) => {
      const list = toWrite.filter((p) => p.category === cat);
      if (!list.length) return [];
      return [`### ${CATEGORY_INFO[cat].label}`, "", ...list.slice(0, 500).map((p) => `- ${link("README.md", p.key)}`), list.length > 500 ? `- … and ${list.length - 500} more in \`parts/\`` : null, ""];
    }),
    "## What REE could not determine",
    "",
    ...(map.limitations.length ? map.limitations.map((l) => `- ${mdInline(l)}`) : ["- Nothing reported."]),
    "",
  ];
  write("README.md", tidy(readme));

  write(
    "parts.json",
    JSON.stringify(
      {
        generatedBy: "ree",
        date,
        source: map.title,
        formats: map.formats,
        stats: map.stats,
        limitations: map.limitations,
        removed: { total: map.removedTotal, sample: map.removed.slice(0, 100) },
        parts: toWrite.map((p) => ({
          key: p.key,
          name: p.name,
          file: p.file,
          artifact: p.artifact || undefined,
          kind: p.kind,
          group: p.category,
          tags: p.tags,
          evidence: p.signals,
          entry: p.isEntry ? p.entryReason ?? true : undefined,
          uses: p.uses.filter((k) => pathOf.has(k)),
          usedBy: p.usedBy.filter((k) => pathOf.has(k)),
          doc: pathOf.get(p.key),
        })),
      },
      null,
      2,
    ),
  );

  return { dir, files, partsWritten: toWrite.length, partsSkipped: ordered.length - toWrite.length };
}
