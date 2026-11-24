#!/usr/bin/env node
/**
 * REE MCP server (stdio).
 *
 * Tool catalog:
 *   ree_inspect             — structural overview of an artifact (no LLM)
 *   ree_strip_decoys        — run the anti-BLA pre-pass, return findings + token savings (no LLM)
 *   ree_trace_entrypoint    — bounded call graph from a real entry point (no LLM)
 *   ree_reconstruct_module  — reconstruct one cleaned unit (LLM; supports dryRun)
 *
 * Register with any MCP-compatible agent as a stdio server: `ree mcp`.
 */
import { pathToFileURL } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { PART_GROUPS, reeInspect, reeParts, reeReconstructModule, reeStripDecoys, reeTraceEntrypoint, type PartsArgs } from "./tools.js";

export const SERVER_INFO = { name: "ree", version: "0.1.0" } as const;

function asText(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] };
}

function asError(err: unknown) {
  return { content: [{ type: "text" as const, text: `error: ${(err as Error).message ?? String(err)}` }], isError: true };
}

export function createServer(): McpServer {
  const server = new McpServer(SERVER_INFO);

  server.registerTool(
    "ree_inspect",
    {
      description:
        "Deterministically parse an artifact (Electron .asar, JS bundle, .wasm, Android APK/AAB, JAR/.class, .NET, ELF/Mach-O/PE, .pyc, iOS .ipa) and return its structure: format, units, entry points, and sample strings. No LLM call; output is bounded.",
      inputSchema: {
        path: z.string().describe("Absolute path to the artifact"),
        maxUnits: z.number().int().min(1).max(500).optional().describe("Max units to list (default 50)"),
      },
    },
    async (args) => {
      try {
        return asText(await reeInspect(args));
      } catch (e) {
        return asError(e);
      }
    },
  );

  server.registerTool(
    "ree_parts",
    {
      description:
        "Exploded view of an app: its parts grouped by what they do (groups: entry, ui, logic, network, storage, system, data = config & data, library), with the evidence for each grouping and how parts connect. Pass `part` to get one part's cleaned code and connections. Built on the cleaned model (decoys removed, planted instructions redacted). No LLM call.",
      inputSchema: {
        path: z.string().describe("Absolute path to the artifact"),
        group: z.enum(PART_GROUPS as [string, ...string[]]).optional().describe("Only list this group"),
        part: z.string().optional().describe("Part key or name from a previous listing: returns its cleaned code"),
        maxParts: z.number().int().min(1).max(300).optional().describe("Max parts to list (default 40)"),
      },
    },
    async (args) => {
      try {
        return asText(await reeParts(args as PartsArgs));
      } catch (e) {
        return asError(e);
      }
    },
  );

  server.registerTool(
    "ree_strip_decoys",
    {
      description:
        "Run the anti-BLA pre-pass: reachability pruning, context-bomb quarantine, opaque-predicate simplification, and prompt/metadata sanitization. Returns findings and the estimated token reduction. No LLM call.",
      inputSchema: {
        path: z.string().describe("Absolute path to the artifact"),
        maxFindings: z.number().int().min(1).max(1000).optional(),
      },
    },
    async (args) => {
      try {
        return asText(await reeStripDecoys(args));
      } catch (e) {
        return asError(e);
      }
    },
  );

  server.registerTool(
    "ree_trace_entrypoint",
    {
      description:
        "Trace the call/reference graph outward from a real entry point (or a named unit) over the cleaned model, with a bounded depth. No LLM call.",
      inputSchema: {
        path: z.string().describe("Absolute path to the artifact"),
        entry: z.string().optional().describe("Unit id or name to start from; defaults to the first entry point"),
        depth: z.number().int().min(1).max(12).optional().describe("Max traversal depth (default 4)"),
      },
    },
    async (args) => {
      try {
        return asText(await reeTraceEntrypoint(args));
      } catch (e) {
        return asError(e);
      }
    },
  );

  server.registerTool(
    "ree_reconstruct_module",
    {
      description:
        "Reconstruct clean source for one unit from its minimal, sanitized context slice, optionally with differential verification and one escalated retry. Calls the configured LLM unless dryRun is true.",
      inputSchema: {
        path: z.string().describe("Absolute path to the artifact"),
        unit: z.string().describe("Unit id or name (see ree_inspect / ree_trace_entrypoint)"),
        verify: z.boolean().optional().describe("Run the verification agent (default false)"),
        dryRun: z.boolean().optional().describe("Do not call the model; return the slice that would be sent"),
      },
    },
    async (args) => {
      try {
        return asText(await reeReconstructModule(args));
      } catch (e) {
        return asError(e);
      }
    },
  );

  return server;
}

export async function startStdioServer(): Promise<void> {
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write("[ree] MCP server ready on stdio\n");
}

// Run directly: `node dist/mcp/server.js`
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  startStdioServer().catch((e) => {
    process.stderr.write(`[ree] fatal: ${(e as Error).stack ?? e}\n`);
    process.exit(1);
  });
}
