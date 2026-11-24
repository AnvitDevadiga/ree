/**
 * Open any target REE supports and turn it into a parts map. Single files go
 * through `analyze()`; `.dmg`, `.app` and directories through whole-app analysis,
 * with one group of parts per inner artifact.
 */
import { analyze } from "../core/analyze.js";
import { analyzeApp } from "../apps/dmg.js";
import { detectFormat, unsupportedMessage } from "../core/detect.js";
import { buildParts, type ArtifactInput, type PartsMap } from "./parts.js";

export class OpenError extends Error {}

export async function openTarget(path: string, onStep: (msg: string) => void = () => {}): Promise<PartsMap> {
  let detected;
  try {
    detected = await detectFormat(path);
  } catch {
    throw new OpenError(`Can't read ${path} — check that it exists and you have permission to read it.`);
  }
  if (detected.route === "unsupported") throw new OpenError(unsupportedMessage(path, detected));
  if (detected.route === "app") {
    onStep("Walking the app bundle (read-only)…");
    const app = await analyzeApp(path);
    const inputs: ArtifactInput[] = app.artifacts
      .filter((a) => a.result)
      .map((a) => ({ label: `${a.roleLabel}: ${a.path.split(/[/\\]/).slice(-2).join("/")}`, result: a.result! }));
    if (!inputs.length) {
      const why = app.artifacts.map((a) => a.error).filter(Boolean)[0] ?? app.warnings[0] ?? "no analyzable pieces were found inside";
      throw new OpenError(`Nothing inside ${path} could be analyzed: ${why}`);
    }
    const map = buildParts(inputs, path);
    for (const w of app.warnings) map.limitations.unshift(w);
    for (const a of app.artifacts) if (a.error) map.limitations.push(`${a.roleLabel} ${a.path}: ${a.error}`);
    return map;
  }
  onStep(`Reading the ${detected.label} and cleaning decoys (nothing is run)…`);
  const result = await analyze(path);
  return buildParts([{ label: "", result }], path);
}
