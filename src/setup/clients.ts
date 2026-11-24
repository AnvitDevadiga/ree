/**
 * The AI agents `ree setup` knows how to connect, and where each keeps its MCP
 * configuration. Only formats confirmed from each client's documentation (or, for
 * Claude Code, its own CLI) are configured automatically; anything else gets
 * copy-paste instructions from `ree setup --print`.
 */
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type ClientId = "claude-code" | "claude-desktop" | "vscode" | "cursor";

export interface SetupEnv {
  home: string;
  platform: NodeJS.Platform;
  /** %APPDATA% on Windows. */
  appData?: string;
  /** $XDG_CONFIG_HOME, falling back to ~/.config. */
  xdgConfig?: string;
  copilotHome?: string;
  /** $CLAUDE_CONFIG_DIR: when set, Claude Code keeps its state and skills there. */
  claudeConfigDir?: string;
  /** Is a CLI on PATH? */
  which: (bin: string) => boolean;
  exists: (p: string) => boolean;
}

export interface JsonClient {
  id: Exclude<ClientId, "claude-code">;
  label: string;
  /** The config file REE edits. */
  file: string;
  /** Top-level object holding servers. */
  key: "mcpServers";
  /** Extra fields for a stdio entry (VS Code wants "type"). */
  extra: Record<string, unknown>;
  installed: boolean;
  /** How confident we are in the documented format. */
  verified: boolean;
  restartHint: string;
}

export interface ClaudeCodeClient {
  id: "claude-code";
  label: string;
  installed: boolean;
  /** Where Claude Code stores user-scope servers (read-only for REE; writes go through `claude mcp`). */
  stateFile: string;
  /** Claude Code skills folder. */
  skillDir: string;
  verified: true;
  restartHint: string;
}

export type Client = JsonClient | ClaudeCodeClient;

export function defaultSetupEnv(env: NodeJS.ProcessEnv = process.env, which: (b: string) => boolean = () => false): SetupEnv {
  return {
    home: homedir(),
    platform: process.platform,
    appData: env.APPDATA,
    xdgConfig: env.XDG_CONFIG_HOME,
    copilotHome: env.COPILOT_HOME,
    claudeConfigDir: env.CLAUDE_CONFIG_DIR,
    which,
    exists: existsSync,
  };
}

function claudeDesktopDir(e: SetupEnv): string {
  if (e.platform === "darwin") return join(e.home, "Library", "Application Support", "Claude");
  if (e.platform === "win32") return join(e.appData ?? join(e.home, "AppData", "Roaming"), "Claude");
  return join(e.xdgConfig ?? join(e.home, ".config"), "Claude");
}

function vscodeUserDir(e: SetupEnv): string {
  if (e.platform === "darwin") return join(e.home, "Library", "Application Support", "Code", "User");
  if (e.platform === "win32") return join(e.appData ?? join(e.home, "AppData", "Roaming"), "Code", "User");
  return join(e.xdgConfig ?? join(e.home, ".config"), "Code", "User");
}

export function knownClients(e: SetupEnv): Client[] {
  const desktopDir = claudeDesktopDir(e);
  const copilot = e.copilotHome ?? join(e.home, ".copilot");
  const cursorDir = join(e.home, ".cursor");
  return [
    {
      id: "claude-code",
      label: "Claude Code",
      installed: e.which("claude"),
      stateFile: e.claudeConfigDir ? join(e.claudeConfigDir, ".claude.json") : join(e.home, ".claude.json"),
      skillDir: join(e.claudeConfigDir ?? join(e.home, ".claude"), "skills", "ree"),
      verified: true,
      restartHint: "Start a new Claude Code session.",
    },
    {
      id: "claude-desktop",
      label: "Claude Desktop",
      file: join(desktopDir, "claude_desktop_config.json"),
      key: "mcpServers",
      extra: {},
      installed: e.exists(desktopDir),
      verified: true,
      restartHint: "Quit and reopen Claude Desktop.",
    },
    {
      // VS Code's current docs: the Copilot user config is $COPILOT_HOME/mcp-config.json
      // (default ~/.copilot), top-level "mcpServers", stdio entries with "type": "stdio".
      id: "vscode",
      label: "VS Code (Copilot)",
      file: join(copilot, "mcp-config.json"),
      key: "mcpServers",
      extra: { type: "stdio", tools: ["*"] },
      installed: e.exists(copilot) || e.exists(vscodeUserDir(e)) || e.which("code"),
      verified: true,
      restartHint: "Reload the VS Code window.",
    },
    {
      // Cursor's long-standing global file. Its docs page could not be fetched to
      // re-confirm the format, so setup labels it as unverified.
      id: "cursor",
      label: "Cursor",
      file: join(cursorDir, "mcp.json"),
      key: "mcpServers",
      extra: {},
      installed: e.exists(cursorDir) || e.which("cursor"),
      verified: false,
      restartHint: "Restart Cursor.",
    },
  ];
}
