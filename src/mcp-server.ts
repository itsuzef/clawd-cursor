/**
 * MCP Server — the single point of construction for clawdcursor's MCP
 * surface. Used by both the stdio transport (editor integrations like
 * Claude Code, Cursor, Windsurf) and the streamable-HTTP transport
 * (the long-running `clawdcursor agent` daemon).
 *
 * Why this module exists
 * ----------------------
 * Up to v0.8.x clawdcursor had two transports:
 *   - REST API in src/server.ts   (the daemon's /task /favorites /etc)
 *   - MCP stdio    in src/index.ts (the `mcp` subcommand, inline-built)
 *
 * v0.9 PR7 collapses those into a single MCP server with two transport
 * flavors. createMcpServer() is the registry-to-MCP adapter; the
 * transports are independent and either or both can be active.
 *
 * The HTTP transport is mounted on the existing Express app at /mcp,
 * with the same Bearer-token requireAuth middleware the REST routes used.
 * That keeps localhost-only auth invariants identical across transports.
 */

import type express from 'express';
import { VERSION } from './version';
import type { ToolContext, ToolDefinition } from './tools';
import { getAllTools, getCompactSurface } from './tools';
import { evaluateToolCall } from './tools/safety-gate';

/** Options for createMcpServer. */
export interface CreateMcpServerOptions {
  /** When true, expose the 6-compound surface instead of granular. */
  compact?: boolean;
  /** Subsystem context every tool handler receives. */
  ctx: ToolContext;
}

/** A constructed MCP server with its registered tool count. */
export interface McpServerHandle {
  /** The configured McpServer instance — connect a transport via .connect(). */
  server: any;
  /** Number of tools registered (mirrors the surface size). */
  toolCount: number;
  /** Snapshot of the tools that were registered (in registration order). */
  tools: ToolDefinition[];
}

/**
 * Build a configured McpServer with all clawdcursor tools registered.
 *
 * The caller is responsible for connecting a transport via `server.connect(...)`.
 * Use `startMcpStdio` for editor integrations and `startMcpHttp` for the daemon.
 */
export async function createMcpServer(options: CreateMcpServerOptions): Promise<McpServerHandle> {
  const { compact, ctx } = options;
  // Dynamic import: the SDK is ESM and our build is CJS.
  const { McpServer } = await import('@modelcontextprotocol/sdk/server/mcp.js' as any);
  const { z } = await import('zod');

  const server = new McpServer({ name: 'clawdcursor', version: VERSION });
  const tools = compact ? getCompactSurface() : getAllTools();

  for (const tool of tools) {
    // Convert parameter defs to a Zod schema map. The MCP SDK uses zod
    // shape objects (Record<string, ZodType>) — not full ZodObjects.
    const zodParams: Record<string, any> = {};
    for (const [key, def] of Object.entries(tool.parameters)) {
      let schema: any;
      if (def.type === 'number') schema = z.number();
      else if (def.type === 'boolean') schema = z.boolean();
      else schema = z.string();
      if (def.enum) schema = z.enum(def.enum as [string, ...string[]]);
      schema = schema.describe(def.description);
      if (def.required === false) schema = schema.optional();
      zodParams[key] = schema;
    }

    // MCP SDK 1.29 arg parsing breaks if schema is undefined (shifts callback
    // position). Always pass a schema — use empty object for parameterless tools.
    const hasParams = Object.keys(zodParams).length > 0;
    server.tool(
      tool.name,
      tool.description,
      hasParams ? zodParams : {},
      async (params: any) => {
        const safetyError = evaluateToolCall(tool, params ?? {});
        if (safetyError) {
          return { content: [{ type: 'text', text: safetyError.text }], isError: true };
        }
        const result = await tool.handler(params, ctx);
        const content: any[] = [];
        if (result.image) {
          content.push({ type: 'image', data: result.image.data, mimeType: result.image.mimeType });
        }
        content.push({ type: 'text', text: result.text });
        return { content, isError: result.isError };
      },
    );
  }

  return { server, toolCount: tools.length, tools };
}

/**
 * Start the stdio MCP transport. Used by `clawdcursor mcp` for editor
 * integrations (Claude Code, Cursor, Windsurf, Zed). Stdout becomes the
 * protocol channel; logs must already be redirected to stderr by the
 * caller.
 */
export async function startMcpStdio(server: any): Promise<void> {
  const { StdioServerTransport } = await import('@modelcontextprotocol/sdk/server/stdio.js' as any);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

/**
 * Mount the streamable HTTP MCP transport on an Express app at /mcp.
 *
 * Mounts both POST (JSON-RPC requests) and GET (SSE notifications), plus
 * DELETE for session termination. Returns the underlying transport so the
 * caller can close it on shutdown.
 *
 * Auth — the caller must apply Bearer-token middleware before this route
 * (mirrors the REST surface's requireAuth). We don't apply auth here so
 * tests and agent-mode can share the same mount with their own gate.
 */
export async function startMcpHttp(
  server: any,
  app: express.Express,
  mountPath: string = '/mcp',
): Promise<{ close: () => Promise<void> }> {
  const { StreamableHTTPServerTransport } = await import(
    '@modelcontextprotocol/sdk/server/streamableHttp.js' as any
  );
  const { randomUUID } = await import('crypto');

  // Stateful mode: the SDK manages a single transport for this server, and
  // session-id headers identify connection state. For the daemon this is
  // fine — there's only ever one process serving /mcp. If we ever shard
  // across nodes we'll need per-session transports keyed off Mcp-Session-Id.
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
  });

  // Connect the server to the transport BEFORE mounting routes so any
  // initialize request lands on a live message handler.
  await server.connect(transport);

  // POST /mcp — JSON-RPC requests. Express has already parsed the body
  // via express.json(); pass it through so the SDK doesn't re-read req.
  app.post(mountPath, async (req, res) => {
    try {
      await transport.handleRequest(req as any, res as any, req.body);
    } catch (err) {
      // Defensive — handleRequest writes the response itself, but if it
      // throws synchronously (shouldn't happen) we surface a 500.
      if (!res.headersSent) {
        res.status(500).json({ error: `MCP transport error: ${(err as Error).message}` });
      }
    }
  });

  // GET /mcp — SSE channel for server-initiated notifications.
  app.get(mountPath, async (req, res) => {
    try {
      await transport.handleRequest(req as any, res as any);
    } catch (err) {
      if (!res.headersSent) {
        res.status(500).json({ error: `MCP transport error: ${(err as Error).message}` });
      }
    }
  });

  // DELETE /mcp — explicit session termination.
  app.delete(mountPath, async (req, res) => {
    try {
      await transport.handleRequest(req as any, res as any);
    } catch (err) {
      if (!res.headersSent) {
        res.status(500).json({ error: `MCP transport error: ${(err as Error).message}` });
      }
    }
  });

  return {
    close: async () => {
      try { await transport.close(); } catch { /* best-effort */ }
    },
  };
}
