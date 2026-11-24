/**
 * `ree` — the interactive terminal app.
 *
 *   pick an app  →  see its parts  →  open a part  →  export / explain
 *
 * Everything here renders REE's cleaned, terminal-safe output (see parts.ts);
 * nothing analyzed is ever executed.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { Box, Text, useApp, useInput, useWindowSize, type Key } from "ink";
import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { discoverCandidates, filterCandidates, humanSize, type Candidate } from "./discover.js";
import { CATEGORY_INFO, CATEGORY_ORDER, partsIn, terminalSafe, type Part, type PartCategory, type PartsMap } from "./parts.js";
import { openTarget as defaultOpen } from "./load.js";
import { defaultExportDir, exportWorkspace, type ExportResult } from "./export.js";
import { explainPart } from "./explain.js";
import { resolveProvider, type ResolvedProvider } from "../agents/providers.js";

type Screen =
  | { name: "picker" }
  | { name: "loading"; path: string }
  | { name: "error"; message: string }
  | { name: "parts" }
  | { name: "detail"; key: string }
  | { name: "connections"; key: string }
  | { name: "removed" }
  | { name: "limits" }
  | { name: "export" }
  | { name: "explain"; key: string }
  | { name: "help" };

export interface AppProps {
  initialTarget?: string;
  discover?: () => { candidates: Candidate[]; truncated: boolean };
  open?: (path: string, onStep: (msg: string) => void) => Promise<PartsMap>;
  provider?: () => ResolvedProvider;
  cwd?: string;
}

const ACCENT = "cyan";

/** Text from outside REE's cleaned model (file names, paths, errors) — one safe line. */
const safe1 = (s: string) => terminalSafe(s, false);
/** Multi-line text from outside (error bodies, model replies). */
const safeN = (s: string) => terminalSafe(s, true);

// ─── small building blocks ────────────────────────────────────────────────

function useSpinner(active: boolean): string {
  const frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
  const [i, setI] = useState(0);
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => setI((n) => (n + 1) % frames.length), 90);
    return () => clearInterval(t);
  }, [active]);
  return frames[i]!;
}

/** Keep `index` visible inside a window of `size` rows. */
export function windowStart(index: number, size: number, total: number, current: number): number {
  if (total <= size) return 0;
  let start = current;
  if (index < start) start = index;
  if (index >= start + size) start = index - size + 1;
  return Math.max(0, Math.min(start, total - size));
}

function Header({ title, subtitle }: { title: string; subtitle?: string }) {
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text>
        <Text color={ACCENT} bold>
          REE
        </Text>
        <Text dimColor> · </Text>
        <Text bold>{title}</Text>
      </Text>
      {subtitle ? <Text dimColor wrap="truncate-end">{subtitle}</Text> : null}
    </Box>
  );
}

function Keys({ items }: { items: [string, string][] }) {
  return (
    <Box marginTop={1}>
      <Text wrap="truncate-end">
        {items.map(([k, label], i) => (
          <Text key={k + label}>
            {i ? <Text dimColor>  </Text> : null}
            <Text color={ACCENT}>{k}</Text>
            <Text dimColor> {label}</Text>
          </Text>
        ))}
      </Text>
    </Box>
  );
}

function ScrollText({ lines, offset, height, numbered }: { lines: string[]; offset: number; height: number; numbered?: boolean }) {
  const view = lines.slice(offset, offset + height);
  const width = String(lines.length).length;
  return (
    <Box flexDirection="column">
      {view.map((l, i) => (
        <Text key={offset + i} wrap="truncate-end">
          {numbered ? <Text dimColor>{String(offset + i + 1).padStart(width)} │ </Text> : null}
          {l.replace(/\t/g, "  ") || " "}
        </Text>
      ))}
      {lines.length > height ? (
        <Text dimColor>
          {"  "}lines {offset + 1}–{Math.min(lines.length, offset + height)} of {lines.length}
        </Text>
      ) : null}
    </Box>
  );
}

/** Shared scrolling keys; returns the new offset or null when the key isn't a scroll key. */
function scrollKey(key: Key, input: string, offset: number, height: number, total: number): number | null {
  const max = Math.max(0, total - height);
  if (key.downArrow || input === "j") return Math.min(max, offset + 1);
  if (key.upArrow || input === "k") return Math.max(0, offset - 1);
  if (key.pageDown || input === " ") return Math.min(max, offset + height);
  if (key.pageUp) return Math.max(0, offset - height);
  if (key.home || input === "g") return 0;
  if (key.end || input === "G") return max;
  return null;
}

function expandPath(q: string, cwd: string): string {
  const t = q.trim().replace(/^["']|["']$/g, "");
  if (t === "~" || t.startsWith("~/") || t.startsWith("~\\")) return resolve(homedir(), t.slice(2));
  return resolve(cwd, t);
}

function looksLikePath(q: string): boolean {
  return /^(~|\.{1,2}[/\\]|[/\\]|[A-Za-z]:[/\\])/.test(q.trim()) || /[/\\]/.test(q);
}

// ─── the app ──────────────────────────────────────────────────────────────

export function ReeApp(props: AppProps) {
  const { exit } = useApp();
  const { rows, columns } = useWindowSize();
  const cwd = props.cwd ?? process.cwd();
  const open = props.open ?? defaultOpen;

  const [stack, setStack] = useState<Screen[]>([props.initialTarget ? { name: "loading", path: props.initialTarget } : { name: "picker" }]);
  const screen = stack[stack.length - 1]!;
  const push = (s: Screen) => setStack((st) => [...st, s]);
  const replace = (s: Screen) => setStack((st) => [...st.slice(0, -1), s]);
  const back = () => setStack((st) => (st.length > 1 ? st.slice(0, -1) : st));

  // picker state
  const [candidates, setCandidates] = useState<Candidate[] | null>(null);
  const [truncated, setTruncated] = useState(false);
  const [query, setQuery] = useState("");
  const [pick, setPick] = useState(0);
  const pickTop = useRef(0);

  // analysis state
  const [map, setMap] = useState<PartsMap | null>(null);
  const [step, setStep] = useState("");
  const [cat, setCat] = useState(0);
  const [focus, setFocus] = useState<"groups" | "parts">("groups");
  const [partIdx, setPartIdx] = useState(0);
  const partTop = useRef(0);
  const [partFilter, setPartFilter] = useState("");
  const [filtering, setFiltering] = useState(false);
  const [offset, setOffset] = useState(0);
  const [connIdx, setConnIdx] = useState(0);

  // export / explain
  const [exportDir, setExportDir] = useState("");
  const [exported, setExported] = useState<ExportResult | null>(null);
  const [exportError, setExportError] = useState("");
  const [explanations, setExplanations] = useState<Record<string, { text?: string; error?: string; note?: string }>>({});
  // Bumped whenever a new app is opened; late replies from an earlier app are dropped.
  const generation = useRef(0);

  const spin = useSpinner(screen.name === "loading" || (screen.name === "explain" && !explanations[screen.key]?.text && !explanations[screen.key]?.error) || candidates === null);

  // Discover candidates once, after the first frame.
  useEffect(() => {
    if (screen.name !== "picker" || candidates !== null) return;
    const t = setTimeout(() => {
      const r = (props.discover ?? (() => discoverCandidates({ roots: undefined })))();
      setCandidates(r.candidates);
      setTruncated(r.truncated);
    }, 10);
    return () => clearTimeout(t);
  }, [screen.name, candidates]);

  // Run the analysis when a loading screen appears.
  useEffect(() => {
    if (screen.name !== "loading") return;
    let alive = true;
    setStep("Detecting the format from the file's content…");
    open(screen.path, (m) => alive && setStep(m))
      .then((m) => {
        if (!alive) return;
        generation.current++;
        setMap(m);
        setCat(0);
        setFocus("groups");
        setPartIdx(0);
        partTop.current = 0;
        setPartFilter("");
        setExported(null);
        setExplanations({});
        setExportDir(defaultExportDir(m, cwd));
        replace({ name: "parts" });
      })
      .catch((e: unknown) => alive && replace({ name: "error", message: e instanceof Error ? e.message : String(e) }));
    return () => {
      alive = false;
    };
  }, [screen.name === "loading" ? screen.path : null]);

  // Fetch an explanation when the explain screen opens.
  useEffect(() => {
    if (screen.name !== "explain" || !map) return;
    const key = screen.key;
    if (explanations[key]) return;
    const part = map.parts.find((p) => p.key === key);
    if (!part) return;
    let provider: ResolvedProvider;
    try {
      provider = (props.provider ?? resolveProvider)();
    } catch (e) {
      setExplanations((x) => ({ ...x, [key]: { error: safeN(e instanceof Error ? e.message : String(e)) } }));
      return;
    }
    if (!provider.client) {
      setExplanations((x) => ({
        ...x,
        [key]: {
          error:
            "No AI model is configured, so REE is running fully offline (everything else works).\n\n" +
            "To get plain-language explanations, set one of these and run ree again:\n\n" +
            "  Local model (free):  REE_OPENAI_BASE_URL=http://localhost:11434/v1  REE_MODEL_WORKHORSE=<model>\n" +
            "  Anthropic:           ANTHROPIC_API_KEY=…  plus a spending cap:\n" +
            "                       REE_MAX_SPEND_USD=1  REE_PRICE_INPUT_PER_MTOK=…  REE_PRICE_OUTPUT_PER_MTOK=…\n\n" +
            "Run `ree doctor` to check your setup.",
        },
      }));
      return;
    }
    setExplanations((x) => ({ ...x, [key]: { note: provider.note } }));
    const gen = generation.current;
    const settle = (v: { text?: string; error?: string }) => {
      if (gen !== generation.current) return; // the user opened another app meanwhile
      setExplanations((x) => ({ ...x, [key]: { ...v, note: provider.note } }));
    };
    explainPart(part, map, provider.client)
      .then((text) => settle({ text }))
      .catch((e: unknown) => settle({ error: safeN(e instanceof Error ? e.message : String(e)) }));
  }, [screen.name === "explain" ? screen.key : null]);

  // ── derived data
  const filtered = useMemo(() => (candidates ? filterCandidates(candidates, query) : []), [candidates, query]);
  const pathRow = useMemo(() => {
    if (!looksLikePath(query)) return null;
    const p = expandPath(query, cwd);
    try {
      return existsSync(p) && (statSync(p).isFile() || statSync(p).isDirectory()) ? p : null;
    } catch {
      return null;
    }
  }, [query, cwd]);
  const pickRows: { label: string; path: string; detail: string }[] = [
    ...(pathRow ? [{ label: `Open this path`, path: pathRow, detail: safe1(pathRow) }] : []),
    // File names on disk are attacker-controllable (a downloaded file can be named anything).
    ...filtered.map((c) => ({ label: safe1(c.name), path: c.path, detail: `${c.kind} · ${safe1(c.where)}${c.isDir ? "" : ` · ${humanSize(c.size)}`}` })),
  ];

  // Sorted once per app: on large APKs/.NET assemblies re-sorting on every key press stalls.
  const byCategory = useMemo(() => {
    const m = new Map<PartCategory, Part[]>();
    if (map) for (const c of CATEGORY_ORDER) m.set(c, partsIn(map, c));
    return m;
  }, [map]);
  const keyIndex = useMemo(() => new Map((map?.parts ?? []).map((p) => [p.key, p])), [map]);
  const groups = CATEGORY_ORDER.map((c) => ({ cat: c, count: byCategory.get(c)?.length ?? 0 })).filter((g) => g.count > 0);
  const extraRows = map ? [{ id: "removed" as const, label: `Removed by REE`, count: map.removedTotal }, { id: "limits" as const, label: `What REE couldn't tell`, count: map.limitations.length }] : [];
  const groupRowCount = groups.length + extraRows.length;
  const activeCat: PartCategory | null = cat < groups.length ? groups[cat]!.cat : null;
  const catParts = useMemo(() => {
    if (!map || !activeCat) return [];
    const list = byCategory.get(activeCat) ?? [];
    const f = partFilter.trim().toLowerCase();
    return f ? list.filter((p) => p.name.toLowerCase().includes(f) || (p.file ?? "").toLowerCase().includes(f)) : list;
  }, [map, activeCat, partFilter, byCategory]);
  const partByKey = (k: string) => keyIndex.get(k);
  const removedLines = useMemo(
    () =>
      map
        ? [
            `${map.removedTotal} item(s) were set aside. They never reach an AI and don't appear in the parts list.`,
            "",
            ...map.removed.map((r) => `${r.action === "pruned" ? "✂ pruned     " : "⊘ quarantined"}  ${r.artifact ? `[${r.artifact}] ` : ""}${r.message}`),
            ...(map.removedTotal > map.removed.length ? ["", `… and ${map.removedTotal - map.removed.length} more (export the parts to see the full summary).`] : []),
          ]
        : [],
    [map],
  );

  const bodyHeight = Math.max(5, rows - 9);

  // ── input
  useInput((input, key) => {
    if (key.ctrl && (input === "c" || input === "d")) {
      exit();
      return;
    }
    switch (screen.name) {
      case "picker": {
        if (key.escape) {
          if (query) {
            setQuery("");
            setPick(0);
          } else exit();
          return;
        }
        if (key.upArrow) return setPick((i) => Math.max(0, i - 1));
        if (key.downArrow) return setPick((i) => Math.min(pickRows.length - 1, i + 1));
        if (key.pageDown) return setPick((i) => Math.min(pickRows.length - 1, i + bodyHeight));
        if (key.pageUp) return setPick((i) => Math.max(0, i - bodyHeight));
        if (key.return) {
          const row = pickRows[pick];
          if (row) push({ name: "loading", path: row.path });
          return;
        }
        if (key.backspace || key.delete) {
          setQuery((q) => q.slice(0, -1));
          setPick(0);
          return;
        }
        if (input && !key.ctrl && !key.meta && !key.tab) {
          setQuery((q) => q + input.replace(/[\r\n]/g, ""));
          setPick(0);
        }
        return;
      }
      case "error":
        if (key.return || key.escape || input === "b") {
          setStack([{ name: "picker" }]);
        }
        if (input === "q") exit();
        return;
      case "loading":
        if (key.escape) setStack([{ name: "picker" }]);
        return;
      case "parts": {
        if (filtering) {
          if (key.escape) {
            setFiltering(false);
            setPartFilter("");
          } else if (key.return) setFiltering(false);
          else if (key.backspace || key.delete) setPartFilter((f) => f.slice(0, -1));
          else if (input && !key.ctrl && !key.meta) setPartFilter((f) => f + input);
          setPartIdx(0);
          partTop.current = 0;
          return;
        }
        if (input === "q") return exit();
        if (input === "?") return push({ name: "help" });
        if (input === "e") return push({ name: "export" });
        if (input === "o" || input === "b") {
          setStack([{ name: "picker" }]);
          return;
        }
        if (focus === "groups") {
          if (key.upArrow || input === "k") return setCat((c) => Math.max(0, c - 1)), setPartIdx(0), partTop.current = 0;
          if (key.downArrow || input === "j") return setCat((c) => Math.min(groupRowCount - 1, c + 1)), setPartIdx(0), partTop.current = 0;
          if (key.return || key.rightArrow || input === "l") {
            if (cat >= groups.length) {
              const extra = extraRows[cat - groups.length]!;
              push({ name: extra.id });
              setOffset(0);
            } else if (catParts.length) setFocus("parts");
          }
          if (key.escape) setStack([{ name: "picker" }]);
          return;
        }
        // parts focus
        if (key.leftArrow || key.escape || input === "h") return setFocus("groups");
        if (input === "/") {
          setFiltering(true);
          return;
        }
        if (key.upArrow || input === "k") return setPartIdx((i) => Math.max(0, i - 1));
        if (key.downArrow || input === "j") return setPartIdx((i) => Math.min(catParts.length - 1, i + 1));
        if (key.pageDown) return setPartIdx((i) => Math.min(catParts.length - 1, i + bodyHeight));
        if (key.pageUp) return setPartIdx((i) => Math.max(0, i - bodyHeight));
        if (key.return || key.rightArrow) {
          const p = catParts[partIdx];
          if (p) {
            setOffset(0);
            push({ name: "detail", key: p.key });
          }
        }
        return;
      }
      case "detail": {
        const p = partByKey(screen.key);
        if (!p) return back();
        const lines = p.text.split("\n");
        const next = scrollKey(key, input, offset, bodyHeight - 6, lines.length);
        if (next !== null) return setOffset(next);
        if (key.escape || key.leftArrow || input === "b") return back();
        if (input === "c") return setConnIdx(0), push({ name: "connections", key: p.key });
        if (input === "x") return setOffset(0), push({ name: "explain", key: p.key });
        if (input === "e") return push({ name: "export" });
        if (input === "q") return exit();
        return;
      }
      case "connections": {
        const p = partByKey(screen.key);
        if (!p) return back();
        const rowsList = [...p.uses, ...p.usedBy];
        if (key.escape || key.leftArrow || input === "b") return back();
        if (key.upArrow || input === "k") return setConnIdx((i) => Math.max(0, i - 1));
        if (key.downArrow || input === "j") return setConnIdx((i) => Math.min(rowsList.length - 1, i + 1));
        if (key.return) {
          const k = rowsList[connIdx];
          if (k) {
            setOffset(0);
            push({ name: "detail", key: k });
          }
        }
        return;
      }
      case "removed":
      case "limits":
      case "help": {
        const total = screen.name === "removed" ? removedLines.length : screen.name === "limits" ? (map?.limitations.length ?? 0) : 30;
        const next = scrollKey(key, input, offset, bodyHeight, total);
        if (next !== null) return setOffset(next);
        if (key.escape || key.leftArrow || key.return || input === "b" || input === "?") return back();
        if (input === "q") return exit();
        return;
      }
      case "explain": {
        const ex = explanations[screen.key];
        const lines = (ex?.text ?? ex?.error ?? "").split("\n");
        const next = scrollKey(key, input, offset, bodyHeight - 2, lines.length);
        if (next !== null) return setOffset(next);
        if (key.escape || key.leftArrow || input === "b") return back();
        if (input === "q") return exit();
        return;
      }
      case "export": {
        if (exported || exportError) {
          if (key.return || key.escape || input === "b") {
            setExported(null);
            setExportError("");
            back();
          }
          return;
        }
        if (key.escape) return back();
        if (key.return) {
          if (!map) return;
          try {
            setExported(exportWorkspace(map, expandPath(exportDir, cwd)));
          } catch (e) {
            setExportError(e instanceof Error ? e.message : String(e));
          }
          return;
        }
        if (key.backspace || key.delete) return setExportDir((d) => d.slice(0, -1));
        if (input && !key.ctrl && !key.meta) setExportDir((d) => d + input.replace(/[\r\n]/g, ""));
        return;
      }
    }
  });

  // keep list windows following the selection
  const pickStart = windowStart(pick, bodyHeight, pickRows.length, pickTop.current);
  pickTop.current = pickStart;
  const listHeight = Math.max(3, bodyHeight - 4);
  const partStart = windowStart(partIdx, listHeight, catParts.length, partTop.current);
  partTop.current = partStart;

  // ── render
  switch (screen.name) {
    case "picker":
      return (
        <Box flexDirection="column">
          <Header title="Open an app to see its parts" subtitle="Static only — REE reads files and never runs them." />
          <Text>
            <Text color={ACCENT}>› </Text>
            {query ? <Text>{safe1(query)}</Text> : <Text dimColor>type to search, or paste a path…</Text>}
            <Text inverse> </Text>
          </Text>
          <Box flexDirection="column" marginTop={1}>
            {candidates === null ? (
              <Text>
                <Text color={ACCENT}>{spin}</Text> Looking for apps in this folder, Downloads, Desktop{process.platform === "darwin" ? " and Applications" : ""}…
              </Text>
            ) : pickRows.length === 0 ? (
              <Text dimColor>
                {query ? "Nothing matches. Paste a full path to any file or folder." : "No apps found nearby. Paste a path to any file, .app, .dmg, .apk, .jar, .dll, .exe or binary."}
              </Text>
            ) : (
              pickRows.slice(pickStart, pickStart + bodyHeight).map((r, i) => {
                const sel = pickStart + i === pick;
                return (
                  <Text key={r.path + i} wrap="truncate-end">
                    <Text color={sel ? ACCENT : undefined}>{sel ? "❯ " : "  "}</Text>
                    <Text bold={sel} color={sel ? ACCENT : undefined}>
                      {r.label}
                    </Text>
                    <Text dimColor>  {r.detail}</Text>
                  </Text>
                );
              })
            )}
            {truncated ? <Text dimColor>  (search stopped early — paste a path if yours isn't listed)</Text> : null}
          </Box>
          <Keys items={[["↑↓", "choose"], ["enter", "open"], ["type", "search"], ["esc", query ? "clear" : "quit"]]} />
        </Box>
      );

    case "loading":
      return (
        <Box flexDirection="column">
          <Header title={safe1(screen.path.split(/[/\\]/).pop() ?? screen.path)} subtitle={safe1(screen.path)} />
          <Text>
            <Text color={ACCENT}>{spin}</Text> {safe1(step)}
          </Text>
          <Keys items={[["esc", "cancel"]]} />
        </Box>
      );

    case "error":
      return (
        <Box flexDirection="column">
          <Header title="Couldn't open that" />
          <Text color="yellow">{safeN(screen.message)}</Text>
          <Keys items={[["enter", "pick something else"], ["q", "quit"]]} />
        </Box>
      );

    case "parts": {
      if (!map) return null;
      const sel = catParts[partIdx];
      const groupWidth = Math.min(34, Math.max(26, Math.floor(columns * 0.32)));
      return (
        <Box flexDirection="column">
          <Header
            title={`Parts of ${map.title}`}
            subtitle={`${map.formats.join(", ")} · ${map.parts.length} parts · ${map.stats.removed} decoy/filler removed · ${map.stats.instructionsRedacted} planted AI instruction(s) removed`}
          />
          <Box>
            <Box flexDirection="column" width={groupWidth} marginRight={2}>
              {groups.map((g, i) => {
                const on = i === cat;
                const info = CATEGORY_INFO[g.cat];
                return (
                  <Text key={g.cat} wrap="truncate-end">
                    <Text color={on ? ACCENT : undefined}>{on ? (focus === "groups" ? "❯ " : "› ") : "  "}</Text>
                    <Text bold={on} color={on ? ACCENT : undefined}>
                      {info.icon} {info.label}
                    </Text>
                    <Text dimColor> {g.count}</Text>
                  </Text>
                );
              })}
              <Text> </Text>
              {extraRows.map((x, j) => {
                const on = groups.length + j === cat;
                return (
                  <Text key={x.id} wrap="truncate-end">
                    <Text color={on ? ACCENT : undefined}>{on ? "❯ " : "  "}</Text>
                    <Text bold={on} color={on ? ACCENT : "gray"}>
                      {x.label}
                    </Text>
                    <Text dimColor> {x.count}</Text>
                  </Text>
                );
              })}
            </Box>
            <Box flexDirection="column" flexGrow={1}>
              {activeCat ? (
                <>
                  <Text dimColor wrap="truncate-end">
                    {CATEGORY_INFO[activeCat].blurb}
                    {partFilter || filtering ? ` · filter: ${partFilter}${filtering ? "▏" : ""}` : ""}
                  </Text>
                  {catParts.slice(partStart, partStart + listHeight).map((p, i) => {
                    const on = focus === "parts" && partStart + i === partIdx;
                    return (
                      <Text key={p.key} wrap="truncate-end">
                        <Text color={on ? ACCENT : undefined}>{on ? "❯ " : "  "}</Text>
                        {p.isEntry ? <Text color="green">▶ </Text> : null}
                        <Text bold={on} color={on ? ACCENT : undefined}>
                          {p.name}
                        </Text>
                        <Text dimColor>
                          {"  "}
                          {p.artifact ? `${p.artifact} · ` : ""}uses {p.uses.length} · used by {p.usedBy.length}
                        </Text>
                      </Text>
                    );
                  })}
                  {catParts.length === 0 ? <Text dimColor>  no parts match</Text> : null}
                  {catParts.length > listHeight ? <Text dimColor>  {catParts.length} parts — ↑↓ to scroll</Text> : null}
                </>
              ) : (
                <Text dimColor>
                  {cat - groups.length === 0
                    ? "Decoys, filler and unreachable code REE set aside so they can't mislead you or an AI. Press enter to see them."
                    : "Honest list of what REE could not determine about this app. Press enter to read it."}
                </Text>
              )}
            </Box>
          </Box>
          {focus === "parts" && sel ? (
            <Box marginTop={1}>
              <Text dimColor wrap="truncate-end">
                {sel.file ? `${sel.file} · ` : ""}
                {sel.signals.length ? `evidence: ${sel.signals.join(", ")}` : sel.kind}
                {sel.isEntry ? ` · starts here: ${sel.entryReason ?? ""}` : ""}
              </Text>
            </Box>
          ) : null}
          <Keys
            items={
              filtering
                ? [["type", "filter"], ["enter", "keep"], ["esc", "clear"]]
                : focus === "groups"
                  ? [["↑↓", "group"], ["→/enter", "open group"], ["e", "export parts"], ["o", "open another"], ["?", "help"], ["q", "quit"]]
                  : [["↑↓", "part"], ["enter", "look inside"], ["/", "filter"], ["←", "groups"], ["e", "export"], ["q", "quit"]]
            }
          />
        </Box>
      );
    }

    case "detail": {
      const p = partByKey(screen.key);
      if (!p) return null;
      const lines = p.text.split("\n");
      return (
        <Box flexDirection="column">
          <Header title={p.name} subtitle={[p.artifact, p.file, `${CATEGORY_INFO[p.category].label}`, p.isEntry ? `starts here (${p.entryReason ?? ""})` : ""].filter(Boolean).join(" · ")} />
          <Text dimColor wrap="truncate-end">
            evidence: {p.signals.join(", ") || "—"} · uses {p.uses.length} · used by {p.usedBy.length} · ~{p.tokens} tokens
          </Text>
          <Box marginTop={1} flexDirection="column">
            <ScrollText lines={lines} offset={offset} height={bodyHeight - 6} numbered />
          </Box>
          <Keys items={[["↑↓ space", "scroll"], ["c", "connections"], ["x", "explain with AI"], ["e", "export"], ["esc", "back"]]} />
        </Box>
      );
    }

    case "connections": {
      const p = partByKey(screen.key);
      if (!p) return null;
      const rowsList = [...p.uses.map((k) => ({ k, dir: "uses" })), ...p.usedBy.map((k) => ({ k, dir: "used by" }))];
      const start = windowStart(connIdx, bodyHeight - 2, rowsList.length, 0);
      return (
        <Box flexDirection="column">
          <Header title={`Connections of ${p.name}`} subtitle="→ parts it uses   ← parts that use it" />
          {rowsList.length === 0 ? <Text dimColor>REE found no connections it could resolve for this part.</Text> : null}
          {rowsList.slice(start, start + bodyHeight - 2).map((r, i) => {
            const on = start + i === connIdx;
            const q = partByKey(r.k);
            return (
              <Text key={r.k + r.dir} wrap="truncate-end">
                <Text color={on ? ACCENT : undefined}>{on ? "❯ " : "  "}</Text>
                <Text color={r.dir === "uses" ? "green" : "magenta"}>{r.dir === "uses" ? "→ " : "← "}</Text>
                <Text bold={on}>{q?.name ?? r.k}</Text>
                <Text dimColor>  {q ? CATEGORY_INFO[q.category].label : ""}</Text>
              </Text>
            );
          })}
          <Keys items={[["↑↓", "choose"], ["enter", "go there"], ["esc", "back"]]} />
        </Box>
      );
    }

    case "removed": {
      if (!map) return null;
      const lines = removedLines;
      return (
        <Box flexDirection="column">
          <Header title="Removed by REE" subtitle="Decoys, filler and unreachable code" />
          <ScrollText lines={lines} offset={offset} height={bodyHeight} />
          <Keys items={[["↑↓", "scroll"], ["esc", "back"]]} />
        </Box>
      );
    }

    case "limits": {
      if (!map) return null;
      const lines = map.limitations.length ? map.limitations.map((l) => `• ${l}`) : ["REE did not report any limitations for this artifact."];
      return (
        <Box flexDirection="column">
          <Header title="What REE couldn't tell" subtitle="REE never presents a guess as a fact" />
          <ScrollText lines={lines} offset={offset} height={bodyHeight} />
          <Keys items={[["↑↓", "scroll"], ["esc", "back"]]} />
        </Box>
      );
    }

    case "explain": {
      const p = partByKey(screen.key);
      const ex = explanations[screen.key];
      return (
        <Box flexDirection="column">
          <Header title={`Explain: ${p?.name ?? ""}`} subtitle={ex?.note ? `model: ${ex.note}` : "Uses your configured AI model (optional)"} />
          {!ex || (!ex.text && !ex.error) ? (
            <Text>
              <Text color={ACCENT}>{spin}</Text> Asking the model to explain this part…
            </Text>
          ) : (
            <ScrollText lines={(ex.text ?? ex.error ?? "").split("\n")} offset={offset} height={bodyHeight - 2} />
          )}
          {ex?.text ? <Text dimColor>AI-generated — check it against the code before relying on it.</Text> : null}
          <Keys items={[["↑↓", "scroll"], ["esc", "back"]]} />
        </Box>
      );
    }

    case "export":
      return (
        <Box flexDirection="column">
          <Header title="Export the parts" subtitle="A folder with a map of the app and one note per part — for studying and designing your own version." />
          {exported ? (
            <>
              <Text color="green">✓ Exported {exported.partsWritten} parts ({exported.files} files)</Text>
              <Text>  {safe1(exported.dir)}</Text>
              <Text dimColor>  Start with README.md — it has the map, the starting points and links to every part.</Text>
              {exported.partsSkipped ? <Text color="yellow">  {exported.partsSkipped} parts beyond the export limit were left out.</Text> : null}
              <Keys items={[["enter", "back"]]} />
            </>
          ) : exportError ? (
            <>
              <Text color="red">✗ {safeN(exportError)}</Text>
              <Keys items={[["enter", "back"]]} />
            </>
          ) : (
            <>
              <Text>Folder (an existing non-empty folder is never overwritten — a numbered one is created instead):</Text>
              <Text>
                <Text color={ACCENT}>› </Text>
                {safe1(exportDir)}
                <Text inverse> </Text>
              </Text>
              <Keys items={[["enter", "export"], ["type", "edit path"], ["esc", "cancel"]]} />
            </>
          )}
        </Box>
      );

    case "help":
      return (
        <Box flexDirection="column">
          <Header title="How to use REE" />
          <Text>REE takes an app apart — like opening a fridge to see every part — without ever running it.</Text>
          <Text> </Text>
          <Text bold>Parts screen</Text>
          <Text>  Left: groups (Screens & UI, Network, Files & storage…). Right: the parts in that group.</Text>
          <Text>  <Text color="green">▶</Text> marks where the app starts. "uses / used by" shows how parts connect.</Text>
          <Text>  Enter opens a part: its cleaned code, connections (c) and an AI explanation (x).</Text>
          <Text> </Text>
          <Text bold>Export (e)</Text>
          <Text>  Writes a folder: README.md with the map, one note per part, parts.json for tools.</Text>
          <Text> </Text>
          <Text bold>What was removed</Text>
          <Text>  Apps can hide decoy code and messages meant to trick AI tools. REE sets those aside</Text>
          <Text>  and lists them under "Removed by REE", so you see the real app.</Text>
          <Text> </Text>
          <Text bold>Use it responsibly</Text>
          <Text>  Learn how things are built, then write your own code. Reuse open-source code only under</Text>
          <Text>  its license, and follow the laws and terms that apply to what you analyze.</Text>
          <Keys items={[["esc", "back"]]} />
        </Box>
      );
  }
}
