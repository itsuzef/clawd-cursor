/**
 * Transport-agnostic tool definitions.
 *
 * Tools are defined once here and adapted to:
 * - HTTP REST API (GET /tools, POST /execute/:name)
 * - MCP protocol (stdio or SSE)
 * - OpenAI function-calling format (GET /tools?format=openai)
 *
 * No MCP, no Zod, no framework dependency — just plain TypeScript.
 */

/** Parameter definition for a tool (maps to JSON Schema) */
export interface ParameterDef {
  type: 'string' | 'number' | 'boolean';
  description: string;
  required?: boolean;
  enum?: string[];
  minimum?: number;
  maximum?: number;
  default?: any;
}

/** Result returned by a tool handler */
export interface ToolResult {
  /** Text output */
  text: string;
  /** Optional image (base64 encoded) */
  image?: { data: string; mimeType: string };
  /** Whether this result represents an error */
  isError?: boolean;
}

/** Shared context passed to tool handlers — initialized subsystems */
export interface ToolContext {
  /** NativeDesktop — mouse, keyboard, screenshot control */
  desktop: any;
  /** AccessibilityBridge — UI automation, windows, clipboard */
  a11y: any;
  /** CDPDriver — browser DOM interaction via Chrome DevTools Protocol */
  cdp: any;
  /**
   * PlatformAdapter — OS-agnostic primitives added in Tranche 1A
   * (mouseDown/Up, keyDown/Up, setWindowState, setWindowBounds,
   * listDisplays, waitForElement, widened invokeElement).
   * Lazy-loaded via `ensureInitialized` so tool handlers don't need
   * async dance on every call.
   */
  platform?: import('../platform/types').PlatformAdapter;
  /**
   * The autonomous Agent — present in `clawdcursor agent` (the daemon)
   * and undefined when run via stdio MCP without a running agent.
   * Used by submit_task / abort_task / agent_status / task_logs_*.
   * v0.9 PR7.2: was previously implicit on `agent.x` accesses inside
   * REST handlers; now it lives on ToolContext so MCP tools can use it.
   */
  agent?: import('../core/agent').Agent;
  /**
   * Optional log buffer accessor — populated by the daemon's createServer.
   * MCP `logs_recent` reads through this; null/missing means logs are not
   * captured (e.g. stdio MCP).
   */
  getLogBuffer?: () => Array<{ timestamp: number; level: string; message: string }>;
  /** Image-space → logical (mouse) coords. mouseCoord = imageCoord * factor */
  getMouseScaleFactor: () => number;
  /** Image-space → physical pixel coords (for screenshot region crop) */
  getScreenshotScaleFactor: () => number;
  /** Ensure subsystems are initialized (lazy init gate) */
  ensureInitialized: () => Promise<void>;
}

/** The 6 compact compound tool names */
export type CompactGroup = 'computer' | 'accessibility' | 'window' | 'system' | 'browser' | 'task';

/** A single tool definition — transport agnostic */
export interface ToolDefinition {
  /** Unique tool name (e.g. "mouse_click", "read_screen") */
  name: string;
  /** Human-readable description of what the tool does */
  description: string;
  /** Parameter schema — empty object for no-param tools */
  parameters: Record<string, ParameterDef>;
  /** Tool category for organization */
  category: 'perception' | 'mouse' | 'keyboard' | 'window' | 'clipboard' | 'browser' | 'orchestration';
  /**
   * The compact compound this granular tool belongs to.
   * Derived by reverse-engineering the ACTION_MAP in compact.ts.
   * Undefined for granular tools that are not exposed via any compound
   * (e.g. smart_read, smart_click, smart_type, minimize_window).
   */
  compactGroup?: CompactGroup;
  /**
   * Safety tier for the canonical safety gate.
   *
   *   0 — read-only (screenshot, a11y snapshot, clipboard read …)
   *   1 — neutral input (click, type, scroll — reversible, no irreversible side-effect)
   *   2 — mutation (close window, write clipboard, navigate …)
   *   3 — destructive / system (cdp_evaluate arbitrary JS, relaunch_with_cdp …)
   *
   * When omitted the gate falls back to the `TOOL_TIER` name-lookup table in
   * `pipeline/safety/layer.ts` for backward-compatibility.
   */
  safetyTier?: 0 | 1 | 2 | 3;
  /** The handler function */
  handler: (params: Record<string, any>, ctx: ToolContext) => Promise<ToolResult>;
}

// ── Schema Conversion Helpers ──

/** Convert tool parameters to JSON Schema (for REST API /tools endpoint) */
export function toJsonSchema(params: Record<string, ParameterDef>): object {
  const properties: Record<string, any> = {};
  const required: string[] = [];

  for (const [key, def] of Object.entries(params)) {
    const prop: any = { type: def.type, description: def.description };
    if (def.enum) prop.enum = def.enum;
    if (def.minimum !== undefined) prop.minimum = def.minimum;
    if (def.maximum !== undefined) prop.maximum = def.maximum;
    if (def.default !== undefined) prop.default = def.default;
    properties[key] = prop;
    if (def.required !== false) required.push(key);
  }

  return {
    type: 'object',
    properties,
    required: required.length > 0 ? required : undefined,
  };
}

/** Convert tools to OpenAI function-calling format */
export function toOpenAiFunctions(tools: ToolDefinition[]): object[] {
  return tools.map(t => ({
    type: 'function',
    function: {
      name: t.name,
      description: t.description,
      parameters: toJsonSchema(t.parameters),
    },
  }));
}

/**
 * Convert a11y coordinate to mouseClick coordinate.
 *
 * NOTE: Empirical testing shows a11y bounds and nut-js mouseClick share the
 * same coordinate system on most Windows configs (both use screen coords from
 * the same DPI-awareness level). This function may divide unnecessarily on
 * some setups. The smart tools (smart_click, invoke_element) pass coords
 * directly for this reason. Only focus_window uses this helper as a fallback.
 */
export function a11yToMouse(physicalCoord: number, ctx: ToolContext): number {
  const dpiRatio = ctx.getScreenshotScaleFactor() / ctx.getMouseScaleFactor();
  return Math.round(physicalCoord / dpiRatio);
}
