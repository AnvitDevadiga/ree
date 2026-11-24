/**
 * Start the interactive app. Needs a real terminal; in a pipe or CI it explains
 * the non-interactive commands instead of hanging.
 */
import { render } from "ink";
import { ReeApp } from "./app.js";

export function canRunInteractive(stdin = process.stdin, stdout = process.stdout): boolean {
  return !!(stdin.isTTY && stdout.isTTY) && process.env.CI !== "true";
}

export async function runTui(initialTarget?: string): Promise<void> {
  const app = render(<ReeApp initialTarget={initialTarget} />, { alternateScreen: true, exitOnCtrlC: false, patchConsole: true });
  // If input ends (terminal closed, piped input exhausted), exit instead of waiting forever.
  const onEnd = () => app.unmount();
  process.stdin.once("end", onEnd);
  try {
    await app.waitUntilExit();
  } finally {
    process.stdin.off("end", onEnd);
  }
  // An in-flight analysis or model request must not keep `ree` alive after quit.
  process.exit(process.exitCode ?? 0);
}
