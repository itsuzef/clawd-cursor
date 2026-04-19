/**
 * Unified-agent tool catalog.
 *
 * ONE tool vocabulary across blind / hybrid / vision modes. The only
 * difference between modes: in `blind`, the `screenshot` tool is removed
 * from the catalog before the LLM sees it.
 *
 * Design rules:
 *   - Every mutation goes through PlatformAdapter (OS-agnostic).
 *   - NO ctx.platform call happens outside a tool's `execute()` — the agent
 *     loop never touches the adapter directly.
 *   - Terminal actions (`done` / `give_up` / `cannot_read`) just return
 *     `stop: true` with a terminalExit tag; the agent loop decides the
 *     AgentResult.
 *   - a11y-first wording. `invoke_element` and `set_field_value` are the
 *     preferred targeting tools; coord clicks are the fallback.
 *
 * Zero app-specific rules. A new LOB app works because a11y roles + the
 * rank-before-truncate sense layer surface its buttons.
 */

import type { UnifiedTool, UnifiedToolResult, AgentToolContext } from './types';
import type { Capability } from '../classify/capability';
import { paletteFor } from './palettes';
import { getCompoundTools, COMPOUND_REPLACES } from './compound';

/**
 * Build the unified tool catalog per mode + capability.
 *
 * Modes:
 *   - 'blind'  → text-LLM; no `screenshot` tool in catalog
 *   - 'hybrid' → text-LLM; `screenshot` tool available on demand
 *   - 'vision' → vision-LLM; COMPOUND TOOL FORM (mouse/keyboard/window
 *                as action-discriminated schemas à la Anthropic
 *                computer_20250124) + perception + a11y + terminals
 *
 * Capability (text modes only):
 *   - When supplied and non-'general', filter to the scoped palette
 *     defined in `palettes.ts`. Typical palette ≈ 6–10 tools.
 *   - 'general' / undefined → full text-agent catalog (back-compat).
 *
 * Terminal actions (`done`, `give_up`, `cannot_read`) are always
 * present regardless of mode/capability — the agent must always have
 * an exit door.
 */
export function buildUnifiedTools(
  mode: 'blind' | 'hybrid' | 'vision',
  capability?: Capability,
): UnifiedTool[] {
  const tools: UnifiedTool[] = [
    // ─── PERCEPTION ─────────────────────────────────────────────
    {
      name: 'read_screen',
      description: 'Refresh the accessibility snapshot of the focused window (already attached each turn — call this only if you suspect staleness).',
      inputSchema: {
        type: 'object',
        properties: {
          processId: { type: 'number', description: 'Optional: limit to a specific process' },
        },
        additionalProperties: false,
      },
      changesScreen: false,
      async execute(args, ctx) {
        const pid = typeof args.processId === 'number' ? args.processId : undefined;
        const tree = await ctx.platform.getUiTree(pid);
        if (tree.length === 0) {
          return { success: true, text: '(empty a11y tree — app may be custom-canvas)' };
        }
        const lines = tree.slice(0, 60).map(el =>
          `[${el.controlType || 'Element'}] "${el.name || ''}" @${el.bounds.x},${el.bounds.y} ${el.bounds.width}×${el.bounds.height}${el.value ? ` value="${el.value.slice(0, 40)}"` : ''}${el.focused ? ' [FOCUSED]' : ''}`,
        );
        const more = tree.length > 60 ? `\n… +${tree.length - 60} more` : '';
        return { success: true, text: `Fresh a11y (${tree.length} els):\n${lines.join('\n')}${more}` };
      },
    },

    {
      name: 'list_windows',
      description: 'List visible top-level windows with title, process, and bounds. Useful when the active window is wrong or missing.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      changesScreen: false,
      async execute(_args, ctx) {
        const windows = await ctx.platform.listWindows();
        const active = await ctx.platform.getActiveWindow();
        const lines = windows.slice(0, 20).map(w => {
          const isActive = active && w.processId === active.processId && w.title === active.title;
          return `${isActive ? '→' : ' '} [${w.processName}] "${w.title}" pid=${w.processId} ${w.bounds.width}×${w.bounds.height}`;
        });
        const more = windows.length > 20 ? `\n… +${windows.length - 20} more windows` : '';
        return { success: true, text: `Windows (${windows.length}):\n${lines.join('\n')}${more}` };
      },
    },

    // ─── A11Y ACTIONS (preferred) ───────────────────────────────
    {
      name: 'invoke_element',
      description: 'Click/activate a UI element by its accessibility name. MORE RELIABLE than coord clicks — use this when the snapshot shows a named target.',
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Accessibility name of the element' },
          controlType: { type: 'string', description: 'Optional role filter (Button, MenuItem, Tab, etc.)' },
          processId: { type: 'number', description: 'Optional: limit to a specific process' },
        },
        required: ['name'],
        additionalProperties: false,
      },
      changesScreen: true,
      async execute(args, ctx) {
        const name = String(args.name ?? '');
        const controlType = typeof args.controlType === 'string' ? args.controlType : undefined;
        const processId = typeof args.processId === 'number' ? args.processId : undefined;
        const res = await ctx.platform.invokeElement({ name, controlType, processId, action: 'click' });
        await sleep(150);
        return {
          success: res.success,
          text: res.success ? `Invoked "${name}" via a11y.` : `a11y invoke "${name}" missed — element not found.`,
          targetLabel: name,
        };
      },
    },

    {
      name: 'set_field_value',
      description: 'Set an editable field\'s value directly via accessibility (more reliable than click+type for forms).',
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Accessibility name of the field' },
          value: { type: 'string' },
          processId: { type: 'number' },
        },
        required: ['name', 'value'],
        additionalProperties: false,
      },
      changesScreen: true,
      async execute(args, ctx) {
        const name = String(args.name ?? '');
        const value = String(args.value ?? '');
        const processId = typeof args.processId === 'number' ? args.processId : undefined;
        const res = await ctx.platform.invokeElement({ name, processId, action: 'set-value', value });
        await sleep(150);
        return {
          success: res.success,
          text: res.success ? `Set "${name}" = ${value.length} chars` : `Set "${name}" failed.`,
          targetLabel: name,
        };
      },
    },

    // ─── INPUT (mouse) ──────────────────────────────────────────
    {
      name: 'click',
      description: 'Click at logical-pixel (x,y). Use coords from the a11y snapshot. Falls back from invoke_element when an element has no a11y name.',
      inputSchema: {
        type: 'object',
        properties: {
          x: { type: 'number' },
          y: { type: 'number' },
          button: { type: 'string', enum: ['left', 'right'] },
          count: { type: 'number', description: '1=single, 2=double' },
        },
        required: ['x', 'y'],
        additionalProperties: false,
      },
      changesScreen: true,
      async execute(args, ctx) {
        const x = Number(args.x ?? 0);
        const y = Number(args.y ?? 0);
        const button = args.button === 'right' ? 'right' : 'left';
        const count = args.count === 2 ? 2 : 1;
        await ctx.platform.mouseClick(x, y, { button, count });
        await sleep(150);
        return { success: true, text: `Clicked ${button} x${count} at (${x},${y})` };
      },
    },

    {
      name: 'drag',
      description: 'Drag the mouse from (startX,startY) to (endX,endY). Used for selecting text, drawing, resizing.',
      inputSchema: {
        type: 'object',
        properties: {
          startX: { type: 'number' },
          startY: { type: 'number' },
          endX: { type: 'number' },
          endY: { type: 'number' },
        },
        required: ['startX', 'startY', 'endX', 'endY'],
        additionalProperties: false,
      },
      changesScreen: true,
      async execute(args, ctx) {
        const sx = Number(args.startX ?? 0);
        const sy = Number(args.startY ?? 0);
        const ex = Number(args.endX ?? 0);
        const ey = Number(args.endY ?? 0);
        await ctx.platform.mouseDrag(sx, sy, ex, ey);
        await sleep(200);
        return { success: true, text: `Dragged (${sx},${sy})→(${ex},${ey})` };
      },
    },

    {
      name: 'scroll',
      description: 'Scroll at (x,y) in a direction. Omit x,y to scroll at the screen center.',
      inputSchema: {
        type: 'object',
        properties: {
          x: { type: 'number' },
          y: { type: 'number' },
          direction: { type: 'string', enum: ['up', 'down'] },
          amount: { type: 'number', description: 'Wheel ticks (default 3)' },
        },
        required: ['direction'],
        additionalProperties: false,
      },
      changesScreen: true,
      async execute(args, ctx) {
        const dir = args.direction === 'up' ? 'up' : 'down';
        const amount = typeof args.amount === 'number' ? args.amount : 3;
        let x = typeof args.x === 'number' ? args.x : Math.floor(ctx.screen.logicalWidth / 2);
        let y = typeof args.y === 'number' ? args.y : Math.floor(ctx.screen.logicalHeight / 2);
        await ctx.platform.mouseScroll(x, y, dir, amount);
        await sleep(150);
        return { success: true, text: `Scrolled ${dir} ${amount} at (${x},${y})` };
      },
    },

    // ─── INPUT (keyboard) ───────────────────────────────────────
    {
      name: 'type',
      description: 'Type text into the currently focused input. Prefer set_field_value when a field has an a11y name.',
      inputSchema: {
        type: 'object',
        properties: { text: { type: 'string' } },
        required: ['text'],
        additionalProperties: false,
      },
      changesScreen: true,
      async execute(args, ctx) {
        const text = String(args.text ?? '');
        await ctx.platform.typeText(text);
        await sleep(200);
        return { success: true, text: `Typed ${text.length} chars: "${truncate(text, 60)}"` };
      },
    },

    {
      name: 'key',
      description: 'Press a key combo. Use "mod" for Ctrl/Cmd. Examples: "mod+s", "Return", "Tab", "shift+Tab", "Escape", "F5".',
      inputSchema: {
        type: 'object',
        properties: { combo: { type: 'string' } },
        required: ['combo'],
        additionalProperties: false,
      },
      changesScreen: true,
      async execute(args, ctx) {
        const combo = String(args.combo ?? '');
        await ctx.platform.keyPress(combo);
        await sleep(150);
        return { success: true, text: `Pressed ${combo}` };
      },
    },

    // ─── APPS & WINDOWS ─────────────────────────────────────────
    {
      name: 'open_app',
      description: 'Open an application by name (e.g. "Notepad", "TextEdit", "Safari").',
      inputSchema: {
        type: 'object',
        properties: { name: { type: 'string' } },
        required: ['name'],
        additionalProperties: false,
      },
      changesScreen: true,
      async execute(args, ctx) {
        const name = String(args.name ?? '');
        const res = await ctx.platform.openApp(name);
        await sleep(800);
        return {
          success: true,
          text: res.title ? `Opened "${name}" (pid=${res.pid}, window="${res.title}")` : `Launched "${name}" (no window surfaced yet)`,
        };
      },
    },

    {
      name: 'focus_window',
      description: 'Bring a window to the foreground. Match by processName, pid, or title substring.',
      inputSchema: {
        type: 'object',
        properties: {
          processName: { type: 'string' },
          processId: { type: 'number' },
          title: { type: 'string' },
        },
        additionalProperties: false,
      },
      changesScreen: true,
      async execute(args, ctx) {
        const q: Record<string, string | number | undefined> = {};
        if (typeof args.processName === 'string') q.processName = args.processName;
        if (typeof args.processId === 'number') q.processId = args.processId;
        if (typeof args.title === 'string') q.title = args.title;
        const ok = await ctx.platform.focusWindow(q as any);
        await sleep(250);
        return { success: ok, text: ok ? 'Focused matching window.' : 'No matching window found.' };
      },
    },

    // ─── WINDOW STATE + BOUNDS (Tranche 1B primitives) ──────────
    {
      name: 'maximize_window',
      description: 'Maximize the foreground window (or a matched window). Polite request; WM may interpret.',
      inputSchema: {
        type: 'object',
        properties: {
          processName: { type: 'string' },
          processId: { type: 'number' },
          title: { type: 'string' },
        },
        additionalProperties: false,
      },
      changesScreen: true,
      async execute(args, ctx) {
        const q = buildWinQuery(args);
        const ok = await ctx.platform.setWindowState('maximize', q);
        return { success: ok, text: ok ? 'Maximized window.' : 'Maximize request ignored.' };
      },
    },

    {
      name: 'minimize_window',
      description: 'Minimize the foreground or matched window to the taskbar / Dock.',
      inputSchema: {
        type: 'object',
        properties: {
          processName: { type: 'string' },
          processId: { type: 'number' },
          title: { type: 'string' },
        },
        additionalProperties: false,
      },
      changesScreen: true,
      async execute(args, ctx) {
        const q = buildWinQuery(args);
        const ok = await ctx.platform.setWindowState('minimize', q);
        return { success: ok, text: ok ? 'Minimized window.' : 'Minimize request failed.' };
      },
    },

    {
      name: 'restore_window',
      description: 'Restore a minimized or maximized window to its previous bounds.',
      inputSchema: {
        type: 'object',
        properties: {
          processName: { type: 'string' },
          processId: { type: 'number' },
          title: { type: 'string' },
        },
        additionalProperties: false,
      },
      changesScreen: true,
      async execute(args, ctx) {
        const q = buildWinQuery(args);
        const ok = await ctx.platform.setWindowState('normal', q);
        return { success: ok, text: ok ? 'Restored window.' : 'Restore request failed.' };
      },
    },

    {
      name: 'close_window',
      description: 'Polite close request (WM_CLOSE / AXCloseAction / _NET_CLOSE_WINDOW). App may prompt.',
      inputSchema: {
        type: 'object',
        properties: {
          processName: { type: 'string' },
          processId: { type: 'number' },
          title: { type: 'string' },
        },
        additionalProperties: false,
      },
      changesScreen: true,
      async execute(args, ctx) {
        const q = buildWinQuery(args);
        const ok = await ctx.platform.setWindowState('close', q);
        return { success: ok, text: ok ? 'Close request posted.' : 'Close request failed.', targetLabel: 'close_window' };
      },
    },

    {
      name: 'resize_window',
      description: 'Set the foreground (or matched) window bounds in logical pixels. Omitted fields preserved.',
      inputSchema: {
        type: 'object',
        properties: {
          x: { type: 'number' }, y: { type: 'number' },
          width: { type: 'number' }, height: { type: 'number' },
          processName: { type: 'string' },
          processId: { type: 'number' },
          title: { type: 'string' },
        },
        additionalProperties: false,
      },
      changesScreen: true,
      async execute(args, ctx) {
        const q = buildWinQuery(args);
        const x = typeof args.x === 'number' ? args.x : undefined;
        const y = typeof args.y === 'number' ? args.y : undefined;
        const width = typeof args.width === 'number' ? args.width : undefined;
        const height = typeof args.height === 'number' ? args.height : undefined;
        const ok = await ctx.platform.setWindowBounds({ x, y, width, height }, q);
        return { success: ok, text: ok ? `Resized window (x=${x ?? '-'}, y=${y ?? '-'}, w=${width ?? '-'}, h=${height ?? '-'}).` : 'Resize failed.' };
      },
    },

    {
      name: 'list_displays',
      description: 'Enumerate connected displays with logical bounds + DPI ratio. Use before display-specific screenshots.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      changesScreen: false,
      async execute(_args, ctx) {
        const displays = await ctx.platform.listDisplays();
        return { success: true, text: JSON.stringify(displays) };
      },
    },

    {
      name: 'switch_tab_os',
      description: 'Cycle next/previous browser tab (mod+Tab / mod+Shift+Tab) or jump to tab N (mod+1..9).',
      inputSchema: {
        type: 'object',
        properties: {
          index: { type: 'number', description: '1-9 for direct tab jump' },
          direction: { type: 'string', enum: ['next', 'previous'] },
        },
        additionalProperties: false,
      },
      changesScreen: true,
      async execute(args, ctx) {
        if (typeof args.index === 'number') {
          const n = Math.max(1, Math.min(9, Math.floor(args.index)));
          await ctx.platform.keyPress(`mod+${n}`);
          return { success: true, text: `Switched to tab ${n}` };
        }
        const dir = args.direction === 'previous' ? 'previous' : 'next';
        await ctx.platform.keyPress(dir === 'next' ? 'mod+Tab' : 'mod+shift+Tab');
        return { success: true, text: `Cycled to ${dir} tab` };
      },
    },

    // ─── ACCESSIBILITY DEPTH (Tranche 1B) ───────────────────────
    {
      name: 'focus_element',
      description: 'Keyboard-focus an element by a11y name. Does NOT raise window — use focus_window first if needed.',
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          controlType: { type: 'string' },
          processId: { type: 'number' },
        },
        required: ['name'],
        additionalProperties: false,
      },
      changesScreen: true,
      async execute(args, ctx) {
        const name = String(args.name ?? '');
        const result = await ctx.platform.invokeElement({
          name,
          controlType: typeof args.controlType === 'string' ? args.controlType : undefined,
          processId: typeof args.processId === 'number' ? args.processId : undefined,
          action: 'focus',
        });
        return {
          success: result.success,
          text: result.success ? `Focused "${name}" via a11y.` : `Could not focus "${name}".`,
          targetLabel: name,
        };
      },
    },

    {
      name: 'wait_for_element',
      description: 'Poll the a11y tree until an element matching name/controlType appears. Useful after an action spawns a dialog.',
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          controlType: { type: 'string' },
          processId: { type: 'number' },
          timeoutMs: { type: 'number', description: 'Default 5000', maximum: 30000 },
          intervalMs: { type: 'number', description: 'Default 250' },
        },
        additionalProperties: false,
      },
      changesScreen: false,
      async execute(args, ctx) {
        const timeout = typeof args.timeoutMs === 'number' ? Math.min(30000, args.timeoutMs) : 5000;
        const element = await ctx.platform.waitForElement(
          {
            name: typeof args.name === 'string' ? args.name : undefined,
            controlType: typeof args.controlType === 'string' ? args.controlType : undefined,
            processId: typeof args.processId === 'number' ? args.processId : undefined,
            intervalMs: typeof args.intervalMs === 'number' ? args.intervalMs : 250,
          },
          timeout,
        );
        if (!element) return { success: false, text: `wait_for_element: timed out after ${timeout}ms` };
        return { success: true, text: `Found element: ${element.name} [${element.controlType}] @${element.bounds.x},${element.bounds.y}` };
      },
    },

    // ─── SYSTEM OPEN HELPERS (Tranche 1B) ───────────────────────
    {
      name: 'open_file',
      description: 'Open a file or folder in the OS default app (explorer / open / xdg-open).',
      inputSchema: {
        type: 'object',
        properties: { path: { type: 'string' } },
        required: ['path'],
        additionalProperties: false,
      },
      changesScreen: true,
      async execute(args, ctx) {
        const p = String(args.path ?? '');
        try {
          if (ctx.platform.platform === 'darwin') await ctx.platform.launchApp('open', { url: p });
          else if (ctx.platform.platform === 'linux') await ctx.platform.launchApp('xdg-open', { url: p });
          else await ctx.platform.launchApp('explorer.exe', { url: p });
          await sleep(500);
          return { success: true, text: `Opened: ${p}` };
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          return { success: false, text: `open_file failed: ${msg}` };
        }
      },
    },

    {
      name: 'open_url',
      description: 'Open a URL in the default browser. Use instead of navigate_browser when you don\'t care which browser.',
      inputSchema: {
        type: 'object',
        properties: { url: { type: 'string' } },
        required: ['url'],
        additionalProperties: false,
      },
      changesScreen: true,
      async execute(args, ctx) {
        const u = String(args.url ?? '');
        if (!/^https?:\/\//i.test(u)) return { success: false, text: 'open_url: URL must start with http(s)://' };
        try {
          if (ctx.platform.platform === 'darwin') await ctx.platform.launchApp('open', { url: u });
          else if (ctx.platform.platform === 'linux') await ctx.platform.launchApp('xdg-open', { url: u });
          else await ctx.platform.launchApp('explorer.exe', { url: u });
          await sleep(800);
          return { success: true, text: `Opened URL: ${u}` };
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          return { success: false, text: `open_url failed: ${msg}` };
        }
      },
    },

    {
      name: 'get_system_time',
      description: 'Return current system time (ISO, epoch, timezone). Zero I/O.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      changesScreen: false,
      async execute() {
        const now = new Date();
        return {
          success: true,
          text: JSON.stringify({
            iso: now.toISOString(),
            epochMs: now.getTime(),
            timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
          }),
        };
      },
    },

    // ─── MOUSE + KEYBOARD EXTENDED (Tranche 1B) ────────────────
    {
      name: 'mouse_move_relative',
      description: 'Move cursor by a relative offset (dx, dy). Wayland-safe via cursor cache.',
      inputSchema: {
        type: 'object',
        properties: { dx: { type: 'number' }, dy: { type: 'number' } },
        required: ['dx', 'dy'],
        additionalProperties: false,
      },
      changesScreen: false,
      async execute(args, ctx) {
        await ctx.platform.mouseMoveRelative(Number(args.dx ?? 0), Number(args.dy ?? 0));
        return { success: true, text: `Cursor moved by (${args.dx}, ${args.dy})` };
      },
    },

    {
      name: 'mouse_down',
      description: 'Press a mouse button without releasing. Pair with mouse_up. Enables hold-and-drag + modifier clicks.',
      inputSchema: {
        type: 'object',
        properties: { button: { type: 'string', enum: ['left', 'right', 'middle'] } },
        additionalProperties: false,
      },
      changesScreen: true,
      async execute(args, ctx) {
        const b = (args.button as 'left' | 'right' | 'middle') ?? 'left';
        await ctx.platform.mouseDown(b);
        return { success: true, text: `Mouse ${b} down.` };
      },
    },

    {
      name: 'mouse_up',
      description: 'Release a mouse button previously pressed with mouse_down.',
      inputSchema: {
        type: 'object',
        properties: { button: { type: 'string', enum: ['left', 'right', 'middle'] } },
        additionalProperties: false,
      },
      changesScreen: true,
      async execute(args, ctx) {
        const b = (args.button as 'left' | 'right' | 'middle') ?? 'left';
        await ctx.platform.mouseUp(b);
        return { success: true, text: `Mouse ${b} up.` };
      },
    },

    {
      name: 'key_down',
      description: 'Press a key without releasing. Pair with key_up. Use to hold modifiers (shift, ctrl) during clicks.',
      inputSchema: {
        type: 'object',
        properties: { key: { type: 'string' } },
        required: ['key'],
        additionalProperties: false,
      },
      changesScreen: false,
      async execute(args, ctx) {
        await ctx.platform.keyDown(String(args.key ?? ''));
        return { success: true, text: `Key down: ${args.key}` };
      },
    },

    {
      name: 'key_up',
      description: 'Release a key previously pressed with key_down.',
      inputSchema: {
        type: 'object',
        properties: { key: { type: 'string' } },
        required: ['key'],
        additionalProperties: false,
      },
      changesScreen: false,
      async execute(args, ctx) {
        await ctx.platform.keyUp(String(args.key ?? ''));
        return { success: true, text: `Key up: ${args.key}` };
      },
    },

    {
      name: 'undo_last',
      description: 'Send the OS Undo keystroke (mod+Z).',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      changesScreen: true,
      async execute(_args, ctx) {
        await ctx.platform.keyPress('mod+z');
        return { success: true, text: 'Sent undo.' };
      },
    },

    // ─── CLIPBOARD ─────────────────────────────────────────────
    {
      name: 'read_clipboard',
      description: 'Read the OS clipboard.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      changesScreen: false,
      async execute(_args, ctx) {
        const text = await ctx.platform.readClipboard();
        return { success: true, text: `Clipboard (${text.length} chars):\n${truncate(text, 500)}` };
      },
    },

    {
      name: 'write_clipboard',
      description: 'Write text to the OS clipboard.',
      inputSchema: {
        type: 'object',
        properties: { text: { type: 'string' } },
        required: ['text'],
        additionalProperties: false,
      },
      changesScreen: false,
      async execute(args, ctx) {
        const text = String(args.text ?? '');
        await ctx.platform.writeClipboard(text);
        return { success: true, text: `Wrote ${text.length} chars to clipboard.` };
      },
    },

    // ─── FLOW CONTROL ───────────────────────────────────────────
    {
      name: 'wait',
      description: 'Pause for N milliseconds (max 5000). Use after actions that trigger animations or page loads.',
      inputSchema: {
        type: 'object',
        properties: { ms: { type: 'number', maximum: 5000 } },
        required: ['ms'],
        additionalProperties: false,
      },
      changesScreen: false,
      async execute(args) {
        const ms = Math.min(5000, Math.max(0, Number(args.ms ?? 0)));
        await sleep(ms);
        return { success: true, text: `Waited ${ms}ms.` };
      },
    },

    // ─── VISION (hybrid + vision modes only) ────────────────────
    {
      name: 'screenshot',
      description: 'Take a screenshot to inspect pixels. Expensive — use only when a11y is insufficient (custom canvas, icon-only UI, verification after action).',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      changesScreen: false,
      async execute(_args, ctx) {
        const shot = await ctx.platform.screenshot({ maxWidth: 1280 });
        ctx.screenshotsCaptured.n += 1;
        return {
          success: true,
          text: `Captured ${shot.width}×${shot.height}.`,
          screenshot: shot,
        };
      },
    },

    // ─── TERMINAL ACTIONS ──────────────────────────────────────
    {
      name: 'done',
      description: 'Declare the task complete. Provide SPECIFIC screen evidence.',
      inputSchema: {
        type: 'object',
        properties: { evidence: { type: 'string' } },
        required: ['evidence'],
        additionalProperties: false,
      },
      changesScreen: false,
      terminal: true,
      async execute(args) {
        const evidence = String(args.evidence ?? 'ok');
        return { success: true, text: `done: ${evidence}`, stop: true, terminalExit: 'done' };
      },
    },

    {
      name: 'give_up',
      description: 'Abandon the task when it\'s impossible from here (credentials missing, captcha, destructive action needs user confirm, stuck after retries).',
      inputSchema: {
        type: 'object',
        properties: { reason: { type: 'string' } },
        required: ['reason'],
        additionalProperties: false,
      },
      changesScreen: false,
      terminal: true,
      async execute(args) {
        const reason = String(args.reason ?? 'unknown');
        return { success: false, text: `give_up: ${reason}`, stop: true, terminalExit: 'give_up' };
      },
    },

    {
      name: 'cannot_read',
      description: 'Escalate from blind mode to vision — the a11y snapshot doesn\'t contain what you need. Only available in blind mode.',
      inputSchema: {
        type: 'object',
        properties: { reason: { type: 'string' } },
        required: ['reason'],
        additionalProperties: false,
      },
      changesScreen: false,
      terminal: true,
      async execute(args) {
        const reason = String(args.reason ?? 'a11y snapshot insufficient');
        return { success: false, text: `cannot_read: ${reason}`, stop: true, terminalExit: 'cannot_read' };
      },
    },
  ];

  // ── Vision mode: compound tools + perception + a11y + terminals ─
  // Replace the individual mouse/keyboard/window primitives with the
  // three action-discriminated compound schemas. This shrinks the
  // catalog the vision LLM sees from ~30 tool definitions to ~12,
  // cutting prompt tokens ~7× and letting the model pick categories
  // first, specific actions second (exactly Anthropic's pattern).
  if (mode === 'vision') {
    const kept = tools.filter(t =>
      !COMPOUND_REPLACES.has(t.name) &&
      t.name !== 'cannot_read' && // vision has nothing to escalate to
      t.name !== 'screenshot',    // included separately below so it sits at top
    );
    const screenshot = tools.find(t => t.name === 'screenshot');
    const compound = getCompoundTools();
    return [
      ...(screenshot ? [screenshot] : []),
      ...compound,
      ...kept,
    ];
  }

  // ── Text modes (blind / hybrid): capability-scoped palettes ────
  // When the preprocessor supplied a specific capability, filter to
  // the tight palette. `general` or undefined → full catalog, matching
  // pre-Tranche-2.5 behavior.
  if (capability && capability !== 'general') {
    const allow = new Set(paletteFor(capability) ?? []);
    // Blind mode must keep cannot_read; hybrid can call screenshot if
    // the palette asks for it (rare — most palettes omit it).
    const palette = tools.filter(t => allow.has(t.name));
    if (mode === 'blind') return palette.filter(t => t.name !== 'screenshot');
    return palette;
  }

  // Full catalog (general capability) with mode-specific trim:
  if (mode === 'blind') {
    // Strip screenshot; keep cannot_read as the blind→vision escape.
    return tools.filter(t => t.name !== 'screenshot');
  }
  // Hybrid: full catalog minus cannot_read (hybrid already has vision access).
  return tools.filter(t => t.name !== 'cannot_read');
}

function buildWinQuery(args: Record<string, unknown>): { processName?: string; processId?: number; title?: string } | undefined {
  const q: { processName?: string; processId?: number; title?: string } = {};
  if (typeof args.processName === 'string') q.processName = args.processName;
  if (typeof args.processId === 'number') q.processId = args.processId;
  if (typeof args.title === 'string') q.title = args.title;
  return Object.keys(q).length ? q : undefined;
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}
