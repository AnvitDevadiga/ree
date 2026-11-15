/** Small, dependency-free terminal formatting helpers for the CLI. */
const useColor = process.stdout.isTTY && !process.env.NO_COLOR;

const wrap = (code: number) => (s: string) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : s);
export const bold = wrap(1);
export const dim = wrap(2);
export const red = wrap(31);
export const green = wrap(32);
export const yellow = wrap(33);
export const cyan = wrap(36);

export function severityColor(sev: string): (s: string) => string {
  return sev === "malicious" ? red : sev === "suspicious" ? yellow : dim;
}

export function table(rows: Array<Array<string | number>>, header?: string[]): string {
  const all = header ? [header, ...rows] : rows;
  const widths: number[] = [];
  for (const r of all) r.forEach((c, i) => (widths[i] = Math.max(widths[i] ?? 0, String(c).length)));
  const fmt = (r: Array<string | number>) => r.map((c, i) => String(c).padEnd(widths[i]!)).join("  ");
  const lines = all.map(fmt);
  if (header) lines.splice(1, 0, widths.map((w) => "─".repeat(w)).join("  "));
  return lines.join("\n");
}

export function pct(before: number, after: number): string {
  if (before === 0) return "0%";
  return `${(((before - after) / before) * 100).toFixed(1)}%`;
}
