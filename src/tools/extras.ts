/**
 * Tranche 1B tools — thin wrappers over the PlatformAdapter primitives
 * added in Tranche 1A.
 *
 * Every tool here is OS-agnostic by construction: it calls through
 * `ctx.platform.*` and the adapter decides how to land the action on
 * the current OS (Windows PowerShell + UIA, macOS osascript + nut-js,
 * Linux wmctrl/xdotool/nut-js). When a primitive isn't supported on the
 * current OS, the adapter returns a falsy value and the tool reports it
 * as `not_supported_on_platform` rather than throwing.
 *
 * Coordinate convention: all mouse tools here take IMAGE-SPACE coords
 * (matching desktop_screenshot), scaled through `getMouseScaleFactor()`
 * just like the existing `mouse_click`. Window / keyboard tools do not
 * carry coords.
 *
 * Safety tier: tools default to 'input' via `safety/layer.ts` TOOL_TIER;
 * `close_window` is tagged 'destructive' and will require confirm when
 * SafetyLayer surfaces block/confirm.
 */

import type { ToolDefinition } from './types';

function notSupported(tool: string): { text: string; isError: true } {
  return {
    text: `${tool}: not supported on this platform in the current version`,
    isError: true,
  };
}

function needPlatform(tool: string): { text: string; isError: true } {
  return {
    text: `${tool}: platform adapter not initialized — is clawdcursor running in a supported OS?`,
    isError: true,
  };
}

export function getExtraTools(): ToolDefinition[] {
  return [
    // ── MOUSE ──────────────────────────────────────────────────────

    {
      name: 'mouse_move_relative',
      description:
        'Move the cursor by a relative offset (dx, dy) in image-space pixels. ' +
        'Useful for drawing on a canvas or adjusting a selection. On Wayland ' +
        'where cursor-query APIs are blocked, uses the last known position.',
      parameters: {
        dx: { type: 'number', description: 'X offset in image-space pixels', required: true },
        dy: { type: 'number', description: 'Y offset in image-space pixels', required: true },
      },
      category: 'mouse',
      handler: async ({ dx, dy }, ctx) => {
        await ctx.ensureInitialized();
        if (!ctx.platform) return needPlatform('mouse_move_relative');
        const sf = ctx.getMouseScaleFactor();
        await ctx.platform.mouseMoveRelative(Math.round(dx * sf), Math.round(dy * sf));
        return { text: `Cursor moved by (${dx}, ${dy}) image-space` };
      },
    },

    {
      name: 'mouse_middle_click',
      description: 'Middle-click (wheel-click) at image-space (x, y). Opens links in new tab in most browsers; pans in some apps.',
      parameters: {
        x: { type: 'number', description: 'X coordinate in image-space', required: true },
        y: { type: 'number', description: 'Y coordinate in image-space', required: true },
      },
      category: 'mouse',
      handler: async ({ x, y }, ctx) => {
        await ctx.ensureInitialized();
        if (!ctx.platform) return needPlatform('mouse_middle_click');
        const sf = ctx.getMouseScaleFactor();
        await ctx.platform.mouseClick(Math.round(x * sf), Math.round(y * sf), { button: 'middle' });
        return { text: `Middle-clicked at (${x}, ${y})` };
      },
    },

    {
      name: 'mouse_triple_click',
      description: 'Triple-click the left mouse button at image-space (x, y) — selects a paragraph in most text editors.',
      parameters: {
        x: { type: 'number', description: 'X coordinate in image-space', required: true },
        y: { type: 'number', description: 'Y coordinate in image-space', required: true },
      },
      category: 'mouse',
      handler: async ({ x, y }, ctx) => {
        await ctx.ensureInitialized();
        if (!ctx.platform) return needPlatform('mouse_triple_click');
        const sf = ctx.getMouseScaleFactor();
        await ctx.platform.mouseClick(Math.round(x * sf), Math.round(y * sf), { button: 'left', count: 3 });
        return { text: `Triple-clicked at (${x}, ${y})` };
      },
    },

    {
      name: 'mouse_down',
      description:
        'Press a mouse button without releasing. Pair with mouse_up. ' +
        'Useful for hold-and-drag gestures, modifier-click selections, or chord input.',
      parameters: {
        button: {
          type: 'string', required: false, enum: ['left', 'right', 'middle'],
          description: 'Which button (default: left)',
        },
      },
      category: 'mouse',
      handler: async ({ button }, ctx) => {
        await ctx.ensureInitialized();
        if (!ctx.platform) return needPlatform('mouse_down');
        const btn = (button as 'left' | 'right' | 'middle') ?? 'left';
        await ctx.platform.mouseDown(btn);
        return { text: `Mouse ${btn} button pressed (release with mouse_up)` };
      },
    },

    {
      name: 'mouse_up',
      description: 'Release a mouse button previously pressed with mouse_down. No-op if nothing is held.',
      parameters: {
        button: {
          type: 'string', required: false, enum: ['left', 'right', 'middle'],
          description: 'Which button (default: left)',
        },
      },
      category: 'mouse',
      handler: async ({ button }, ctx) => {
        await ctx.ensureInitialized();
        if (!ctx.platform) return needPlatform('mouse_up');
        const btn = (button as 'left' | 'right' | 'middle') ?? 'left';
        await ctx.platform.mouseUp(btn);
        return { text: `Mouse ${btn} button released` };
      },
    },

    {
      name: 'mouse_scroll_horizontal',
      description:
        'Scroll horizontally at image-space (x, y). On Windows uses Shift+wheel synthesis; ' +
        'on Linux uses xdotool wheel buttons when available; on macOS uses Shift+wheel.',
      parameters: {
        x: { type: 'number', description: 'X coordinate in image-space', required: true },
        y: { type: 'number', description: 'Y coordinate in image-space', required: true },
        direction: { type: 'string', description: 'Scroll direction', required: true, enum: ['left', 'right'] },
        amount: { type: 'number', description: 'Wheel ticks (default: 3)', required: false, default: 3 },
      },
      category: 'mouse',
      handler: async ({ x, y, direction, amount }, ctx) => {
        await ctx.ensureInitialized();
        if (!ctx.platform) return needPlatform('mouse_scroll_horizontal');
        const sf = ctx.getMouseScaleFactor();
        const ticks = amount ?? 3;
        await ctx.platform.mouseScroll(
          Math.round(x * sf), Math.round(y * sf),
          direction as 'left' | 'right',
          ticks,
        );
        return { text: `Scrolled ${direction} ${ticks} ticks at (${x}, ${y})` };
      },
    },

    {
      name: 'mouse_drag_stepped',
      description:
        'Drag the mouse along a multi-point path in image-space. ' +
        'Path is a JSON string of {x,y} points. Useful for Paint-style drawing ' +
        'or gesture input. Press occurs at the first point and release at the last.',
      parameters: {
        path: {
          type: 'string', required: true,
          description: 'JSON array of {"x":n, "y":n} points in image-space, min 2 points',
        },
      },
      category: 'mouse',
      handler: async ({ path }, ctx) => {
        await ctx.ensureInitialized();
        if (!ctx.platform) return needPlatform('mouse_drag_stepped');
        let points: Array<{ x: number; y: number }>;
        try { points = JSON.parse(String(path)); }
        catch { return { text: 'mouse_drag_stepped: path must be a JSON array of {x,y}', isError: true }; }
        if (!Array.isArray(points) || points.length < 2) {
          return { text: 'mouse_drag_stepped: need at least 2 points', isError: true };
        }
        const sf = ctx.getMouseScaleFactor();
        const scaled = points.map(p => ({ x: Math.round(p.x * sf), y: Math.round(p.y * sf) }));

        await ctx.platform.mouseMove(scaled[0].x, scaled[0].y);
        await ctx.platform.mouseDown('left');
        try {
          for (let i = 1; i < scaled.length; i++) {
            await ctx.platform.mouseMove(scaled[i].x, scaled[i].y);
            // Small delay between segments so apps register the drag motion.
            await new Promise(r => setTimeout(r, 16));
          }
        } finally {
          await ctx.platform.mouseUp('left');
        }
        return { text: `Stepped-drag through ${points.length} points` };
      },
    },

    // ── KEYBOARD ───────────────────────────────────────────────────

    {
      name: 'key_down',
      description:
        'Press a key (or modifier) without releasing. Pair with key_up. ' +
        'Enables hold-modifier-while-click or chord-hold workflows. ' +
        'Accepts the same tokens as key_press ("shift", "Return", "F5", etc.).',
      parameters: {
        key: { type: 'string', description: 'Key token (e.g. "shift", "ctrl", "a", "Return")', required: true },
      },
      category: 'keyboard',
      handler: async ({ key }, ctx) => {
        await ctx.ensureInitialized();
        if (!ctx.platform) return needPlatform('key_down');
        await ctx.platform.keyDown(String(key));
        return { text: `Key down: ${key} (release with key_up)` };
      },
    },

    {
      name: 'key_up',
      description: 'Release a key previously pressed with key_down. No-op if not currently down.',
      parameters: {
        key: { type: 'string', description: 'Key token', required: true },
      },
      category: 'keyboard',
      handler: async ({ key }, ctx) => {
        await ctx.ensureInitialized();
        if (!ctx.platform) return needPlatform('key_up');
        await ctx.platform.keyUp(String(key));
        return { text: `Key up: ${key}` };
      },
    },

    // ── WINDOWS ────────────────────────────────────────────────────

    {
      name: 'maximize_window',
      description:
        'Maximize the foreground window (or a specific window matched by processName/title). ' +
        'Polite request — the OS window manager may snap to the full working area.',
      parameters: {
        processName: { type: 'string', description: 'Optional process name match', required: false },
        processId:   { type: 'number', description: 'Optional process id match', required: false },
        title:       { type: 'string', description: 'Optional title-substring match', required: false },
      },
      category: 'window',
      handler: async ({ processName, processId, title }, ctx) => {
        await ctx.ensureInitialized();
        if (!ctx.platform) return needPlatform('maximize_window');
        const query = processName || processId !== undefined || title
          ? { processName, processId, title }
          : undefined;
        const ok = await ctx.platform.setWindowState('maximize', query);
        return { text: ok ? 'Window maximized.' : 'maximize request failed or ignored by WM.', isError: !ok };
      },
    },

    {
      name: 'minimize_window_to_taskbar',
      description:
        'Minimize a window (hide to taskbar/Dock). Counterpart to the existing `minimize_window` in a11y.ts ' +
        'but routed through the OS-agnostic PlatformAdapter and accepts explicit target queries.',
      parameters: {
        processName: { type: 'string', description: 'Optional process name match', required: false },
        processId:   { type: 'number', description: 'Optional process id match', required: false },
        title:       { type: 'string', description: 'Optional title-substring match', required: false },
      },
      category: 'window',
      handler: async ({ processName, processId, title }, ctx) => {
        await ctx.ensureInitialized();
        if (!ctx.platform) return needPlatform('minimize_window_to_taskbar');
        const query = processName || processId !== undefined || title
          ? { processName, processId, title }
          : undefined;
        const ok = await ctx.platform.setWindowState('minimize', query);
        return { text: ok ? 'Window minimized.' : 'minimize request failed.', isError: !ok };
      },
    },

    {
      name: 'restore_window',
      description:
        'Restore a minimized or maximized window back to its previous bounds. ' +
        'Use this to bring a hidden window back without toggling into fullscreen.',
      parameters: {
        processName: { type: 'string', description: 'Optional process name match', required: false },
        processId:   { type: 'number', description: 'Optional process id match', required: false },
        title:       { type: 'string', description: 'Optional title-substring match', required: false },
      },
      category: 'window',
      handler: async ({ processName, processId, title }, ctx) => {
        await ctx.ensureInitialized();
        if (!ctx.platform) return needPlatform('restore_window');
        const query = processName || processId !== undefined || title
          ? { processName, processId, title }
          : undefined;
        const ok = await ctx.platform.setWindowState('normal', query);
        return { text: ok ? 'Window restored.' : 'restore request failed.', isError: !ok };
      },
    },

    {
      name: 'close_window',
      description:
        'Polite close request — the app receives WM_CLOSE / AXCloseAction / _NET_CLOSE_WINDOW ' +
        'and may prompt ("Save changes?") or refuse. Returns when the request was posted, ' +
        'NOT when the window actually closed.',
      parameters: {
        processName: { type: 'string', description: 'Optional process name match', required: false },
        processId:   { type: 'number', description: 'Optional process id match', required: false },
        title:       { type: 'string', description: 'Optional title-substring match', required: false },
      },
      category: 'window',
      handler: async ({ processName, processId, title }, ctx) => {
        await ctx.ensureInitialized();
        if (!ctx.platform) return needPlatform('close_window');
        const query = processName || processId !== undefined || title
          ? { processName, processId, title }
          : undefined;
        const ok = await ctx.platform.setWindowState('close', query);
        return { text: ok ? 'Close request posted (app may prompt or refuse).' : 'close request failed.', isError: !ok };
      },
    },

    {
      name: 'resize_window',
      description:
        'Set a window\'s logical-pixel bounds. Pass only the dimensions you want to change; ' +
        'omitted fields preserve the current value. Coordinates are logical pixels — top-left origin.',
      parameters: {
        x:      { type: 'number', description: 'New X (top-left origin, logical px)', required: false },
        y:      { type: 'number', description: 'New Y (top-left origin, logical px)', required: false },
        width:  { type: 'number', description: 'New width in logical px', required: false },
        height: { type: 'number', description: 'New height in logical px', required: false },
        processName: { type: 'string', description: 'Optional process name match', required: false },
        processId:   { type: 'number', description: 'Optional process id match', required: false },
        title:       { type: 'string', description: 'Optional title-substring match', required: false },
      },
      category: 'window',
      handler: async ({ x, y, width, height, processName, processId, title }, ctx) => {
        await ctx.ensureInitialized();
        if (!ctx.platform) return needPlatform('resize_window');
        const query = processName || processId !== undefined || title
          ? { processName, processId, title }
          : undefined;
        const ok = await ctx.platform.setWindowBounds({ x, y, width, height }, query);
        return {
          text: ok
            ? `Window bounds set: x=${x ?? '-'}, y=${y ?? '-'}, w=${width ?? '-'}, h=${height ?? '-'}`
            : 'resize request failed (WM may have refused).',
          isError: !ok,
        };
      },
    },

    {
      name: 'list_displays',
      description:
        'Enumerate all connected displays with logical bounds, physical size, DPI ratio, and primary flag. ' +
        'Use this before desktop_screenshot with displayIndex to target a specific monitor.',
      parameters: {},
      category: 'window',
      handler: async (_params, ctx) => {
        await ctx.ensureInitialized();
        if (!ctx.platform) return needPlatform('list_displays');
        const displays = await ctx.platform.listDisplays();
        return { text: JSON.stringify(displays, null, 2) };
      },
    },

    // ── ACCESSIBILITY ──────────────────────────────────────────────

    {
      name: 'focus_element',
      description:
        'Put keyboard focus on a UI element by accessibility name. Does NOT raise the window — ' +
        'use focus_window first if you also need the window in the foreground. ' +
        'Returns not_supported_on_platform on Linux (AT-SPI bridge pending).',
      parameters: {
        name:        { type: 'string', description: 'Accessibility name of the element', required: true },
        controlType: { type: 'string', description: 'Optional role filter (Button, Edit, etc.)', required: false },
        processId:   { type: 'number', description: 'Optional process id to scope the search', required: false },
      },
      category: 'perception',
      handler: async ({ name, controlType, processId }, ctx) => {
        await ctx.ensureInitialized();
        if (!ctx.platform) return needPlatform('focus_element');
        if (ctx.platform.platform === 'linux') return notSupported('focus_element');
        const result = await ctx.platform.invokeElement({
          name: String(name), controlType, processId, action: 'focus',
        });
        return {
          text: result.success ? `Focused "${name}" via accessibility.` : `Focus failed for "${name}".`,
          isError: !result.success,
        };
      },
    },

    {
      name: 'wait_for_element',
      description:
        'Poll the accessibility tree until an element appears or timeout elapses. ' +
        'Useful after an action that triggers a dialog or side panel. ' +
        'Returns not_supported_on_platform on Linux (AT-SPI bridge pending).',
      parameters: {
        name:        { type: 'string', description: 'Accessibility name to match', required: false },
        controlType: { type: 'string', description: 'Role filter (e.g. "Button")', required: false },
        processId:   { type: 'number', description: 'Scope the search to a process', required: false },
        timeoutMs:   { type: 'number', description: 'Max wait in milliseconds (default 5000)', required: false, default: 5000 },
        intervalMs:  { type: 'number', description: 'Poll interval in ms (default 250)', required: false, default: 250 },
      },
      category: 'perception',
      handler: async ({ name, controlType, processId, timeoutMs, intervalMs }, ctx) => {
        await ctx.ensureInitialized();
        if (!ctx.platform) return needPlatform('wait_for_element');
        if (ctx.platform.platform === 'linux') return notSupported('wait_for_element');
        const deadline = typeof timeoutMs === 'number' ? timeoutMs : 5000;
        const element = await ctx.platform.waitForElement(
          { name, controlType, processId, intervalMs: intervalMs ?? 250 },
          deadline,
        );
        if (!element) {
          return { text: `wait_for_element: timed out after ${deadline}ms`, isError: true };
        }
        return { text: JSON.stringify(element) };
      },
    },

    // ── SYSTEM INTEGRATION ────────────────────────────────────────

    {
      name: 'open_file',
      description:
        'Open a file or folder in the OS default application. ' +
        'Uses `open` (macOS), `xdg-open` (Linux), and explorer / ShellExecute (Windows).',
      parameters: {
        path: { type: 'string', description: 'Absolute filesystem path', required: true },
      },
      category: 'orchestration',
      handler: async ({ path: filePath }, ctx) => {
        await ctx.ensureInitialized();
        if (!ctx.platform) return needPlatform('open_file');
        // Route through launchApp with a file-URL or raw path. The Windows
        // adapter handles shell: paths and Start-Process; macOS uses `open`;
        // Linux uses xdg-open fallback.
        const p = String(filePath);
        try {
          if (ctx.platform.platform === 'darwin') {
            await ctx.platform.launchApp('open', { url: p });
          } else if (ctx.platform.platform === 'linux') {
            await ctx.platform.launchApp('xdg-open', { url: p });
          } else {
            // Windows: explorer handles files directly.
            await ctx.platform.launchApp('explorer.exe', { url: p });
          }
          return { text: `Opened: ${p}` };
        } catch (err) {
          return {
            text: `open_file failed: ${err instanceof Error ? err.message : String(err)}`,
            isError: true,
          };
        }
      },
    },

    {
      name: 'open_url',
      description: 'Open a URL in the OS default browser. Non-browser-agnostic counterpart to navigate_browser.',
      parameters: {
        url: { type: 'string', description: 'https:// or http:// URL', required: true },
      },
      category: 'orchestration',
      handler: async ({ url }, ctx) => {
        await ctx.ensureInitialized();
        if (!ctx.platform) return needPlatform('open_url');
        const u = String(url);
        if (!/^https?:\/\//i.test(u)) {
          return { text: 'open_url: url must start with http:// or https://', isError: true };
        }
        try {
          if (ctx.platform.platform === 'darwin') {
            await ctx.platform.launchApp('open', { url: u });
          } else if (ctx.platform.platform === 'linux') {
            await ctx.platform.launchApp('xdg-open', { url: u });
          } else {
            await ctx.platform.launchApp('explorer.exe', { url: u });
          }
          return { text: `Opened URL: ${u}` };
        } catch (err) {
          return {
            text: `open_url failed: ${err instanceof Error ? err.message : String(err)}`,
            isError: true,
          };
        }
      },
    },

    {
      name: 'get_system_time',
      description: 'Return the current system time as ISO 8601 UTC + local components. Zero I/O.',
      parameters: {},
      category: 'perception',
      handler: async () => {
        const now = new Date();
        return {
          text: JSON.stringify({
            iso: now.toISOString(),
            localString: now.toString(),
            epochMs: now.getTime(),
            timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
          }),
        };
      },
    },

    {
      name: 'switch_tab_os',
      description:
        'Cycle or jump to a browser tab using the OS-agnostic keyboard shortcut ' +
        '(mod+Tab / mod+Shift+Tab / mod+{1..9}). Works in Chrome, Firefox, Edge, Safari. ' +
        'For in-browser DOM-level control use cdp_switch_tab.',
      parameters: {
        index: {
          type: 'number', required: false,
          description: 'Jump to tab N (1-based, 1-9). If omitted, direction must be provided.',
          minimum: 1, maximum: 9,
        },
        direction: {
          type: 'string', required: false, enum: ['next', 'previous'],
          description: 'Cycle "next" or "previous". Ignored when `index` is given.',
        },
      },
      category: 'window',
      handler: async ({ index, direction }, ctx) => {
        await ctx.ensureInitialized();
        if (!ctx.platform) return needPlatform('switch_tab_os');
        if (typeof index === 'number') {
          const n = Math.max(1, Math.min(9, Math.floor(index)));
          await ctx.platform.keyPress(`mod+${n}`);
          return { text: `Switched to tab ${n}` };
        }
        const dir = direction === 'previous' ? 'previous' : 'next';
        const combo = dir === 'next' ? 'mod+Tab' : 'mod+shift+Tab';
        await ctx.platform.keyPress(combo);
        return { text: `Cycled to ${dir} tab` };
      },
    },

    // ── META ──────────────────────────────────────────────────────

    {
      name: 'undo_last',
      description: 'Emit the OS-specific Undo shortcut (Ctrl+Z on Win/Linux, Cmd+Z on macOS) into the focused window.',
      parameters: {},
      category: 'keyboard',
      handler: async (_params, ctx) => {
        await ctx.ensureInitialized();
        if (!ctx.platform) return needPlatform('undo_last');
        await ctx.platform.keyPress('mod+z');
        return { text: 'Sent undo keystroke.' };
      },
    },
  ];
}
