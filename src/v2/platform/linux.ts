/**
 * Linux PlatformAdapter — all Linux-specific code lives here.
 *
 * Strategy:
 *   - Mouse + keyboard: nut-js directly (same approach as Windows).
 *   - Screenshot: nut-js screen.grab() → sharp for PNG encode / resize.
 *   - Screen size: xrandr --query; HiDPI via GDK_SCALE / QT_SCALE_FACTOR env.
 *   - Windows: wmctrl -lG for listing; xdotool for active-window detection.
 *   - A11y: AT-SPI bridge not yet implemented — graceful empty returns.
 *   - Clipboard: xclip -selection clipboard (X11 assumption).
 *   - openApp: spawn by name, falling back to xdg-open.
 *
 * All tool invocations tolerate missing binaries — if wmctrl/xclip/xdotool
 * are not installed the adapter still loads and methods return empty defaults.
 */

import { execFile, spawn } from 'child_process';
import { promisify } from 'util';
import sharp from 'sharp';
import {
  mouse,
  keyboard,
  screen as nutScreen,
  Point,
  Button,
  Key,
} from '@nut-tree-fork/nut-js';
import type {
  PlatformAdapter,
  ScreenSize,
  ScreenshotResult,
  WindowInfo,
  UiElement,
  PermissionStatus,
  PortableKeyCombo,
} from './types';

const execFileAsync = promisify(execFile);

// Tunables
const TOOL_TIMEOUT_MS = 3_000;
const SCREENSHOT_TIMEOUT_MS = 10_000;

export class LinuxAdapter implements PlatformAdapter {
  readonly platform = 'linux' as const;

  private screenSize: ScreenSize | null = null;
  private binaryCache = new Map<string, boolean>();

  async init(): Promise<void> {
    // Tighten nut-js defaults (mirrors Windows path in legacy code).
    mouse.config.mouseSpeed = 2000;
    mouse.config.autoDelayMs = 0;
    keyboard.config.autoDelayMs = 0;

    // Warm binary presence cache (non-fatal if none present).
    await Promise.all([
      this.hasBinary('wmctrl'),
      this.hasBinary('xdotool'),
      this.hasBinary('xclip'),
      this.hasBinary('xrandr'),
      this.hasBinary('xdg-open'),
    ]);

    // Pre-warm screen size so first capture is fast.
    await this.getScreenSize().catch(() => null);
  }

  async shutdown(): Promise<void> {
    // No long-lived processes to clean up.
  }

  // ─── PERMISSIONS ──────────────────────────────────────────────────

  async checkPermissions(): Promise<PermissionStatus> {
    // X11 has no TCC-style permission gating — user-level access is implicit.
    // Wayland would require portals, but the brief says assume X11 for now.
    return { input: true, accessibility: true, screenRecording: true };
  }

  async requestPermissions(): Promise<PermissionStatus> {
    return this.checkPermissions();
  }

  // ─── DISPLAY ──────────────────────────────────────────────────────

  async getScreenSize(): Promise<ScreenSize> {
    if (this.screenSize) return this.screenSize;

    // Prefer xrandr for logical geometry — matches mouse coordinate space.
    let logicalWidth = 0;
    let logicalHeight = 0;
    try {
      const { stdout } = await execFileAsync('xrandr', ['--query'], {
        timeout: TOOL_TIMEOUT_MS,
      });
      // Match "primary AxB" first; else the first "connected AxB+x+y" entry.
      const primary = stdout.match(/\bconnected\s+primary\s+(\d+)x(\d+)/);
      const first = stdout.match(/\bconnected(?:\s+primary)?\s+(\d+)x(\d+)/);
      const m = primary ?? first;
      if (m) {
        logicalWidth = parseInt(m[1], 10) || 0;
        logicalHeight = parseInt(m[2], 10) || 0;
      }
    } catch {
      /* xrandr missing or failed — fall through to nut-js */
    }

    // Physical dimensions — nut-js screen.grab returns hardware pixels.
    let physicalWidth = logicalWidth;
    let physicalHeight = logicalHeight;
    try {
      const w = await nutScreen.width();
      const h = await nutScreen.height();
      if (w > 0 && h > 0) {
        physicalWidth = w;
        physicalHeight = h;
      }
    } catch {
      /* nut-js unavailable — keep logical dims as physical */
    }

    // If xrandr gave us nothing, assume physical == logical.
    if (!logicalWidth) logicalWidth = physicalWidth;
    if (!logicalHeight) logicalHeight = physicalHeight;

    // HiDPI hints from desktop environment env vars.
    const gdkScale = parseInt(process.env.GDK_SCALE || '1', 10);
    const qtScale = parseFloat(process.env.QT_SCALE_FACTOR || '1');
    const envScale = Math.max(
      Number.isFinite(gdkScale) ? gdkScale : 1,
      Number.isFinite(qtScale) ? qtScale : 1,
      1,
    );

    let dpiRatio = 1;
    if (physicalWidth > 0 && logicalWidth > 0 && physicalWidth > logicalWidth) {
      dpiRatio = physicalWidth / logicalWidth;
    } else if (envScale > 1) {
      dpiRatio = envScale;
      // Derive physical dims from env scale when xrandr/nut didn't disagree.
      if (physicalWidth === logicalWidth) {
        physicalWidth = Math.round(logicalWidth * envScale);
        physicalHeight = Math.round(logicalHeight * envScale);
      }
    }

    this.screenSize = {
      physicalWidth,
      physicalHeight,
      logicalWidth,
      logicalHeight,
      dpiRatio,
    };
    return this.screenSize;
  }

  async screenshot(opts?: { maxWidth?: number }): Promise<ScreenshotResult> {
    const img = await this.grabScreen();
    let pipeline = sharp(img.data, {
      raw: { width: img.width, height: img.height, channels: 4 },
    });

    let width = img.width;
    let height = img.height;
    let scaleFactor = 1;

    if (opts?.maxWidth && width > opts.maxWidth) {
      scaleFactor = width / opts.maxWidth;
      const newH = Math.round(height / scaleFactor);
      pipeline = pipeline.resize(opts.maxWidth, newH, { fit: 'fill' });
      width = opts.maxWidth;
      height = newH;
    }

    const buffer = await pipeline.png().toBuffer();
    // Release raw RGBA buffer now that sharp has consumed it.
    (img as any).data = null;
    return { buffer, width, height, scaleFactor };
  }

  async screenshotRegion(x: number, y: number, w: number, h: number): Promise<ScreenshotResult> {
    const img = await this.grabScreen();
    try {
      // Clamp to image bounds so sharp doesn't throw.
      const left = Math.max(0, Math.min(x, img.width - 1));
      const top = Math.max(0, Math.min(y, img.height - 1));
      const width = Math.max(1, Math.min(w, img.width - left));
      const height = Math.max(1, Math.min(h, img.height - top));
      const buffer = await sharp(img.data, {
        raw: { width: img.width, height: img.height, channels: 4 },
      })
        .extract({ left, top, width, height })
        .png()
        .toBuffer();
      return { buffer, width, height, scaleFactor: 1 };
    } finally {
      (img as any).data = null;
    }
  }

  private async grabScreen(): Promise<{ data: Buffer; width: number; height: number }> {
    return await this.withTimeout(
      nutScreen.grab() as unknown as Promise<{ data: Buffer; width: number; height: number }>,
      SCREENSHOT_TIMEOUT_MS,
      'nut-js screen.grab',
    );
  }

  // ─── WINDOWS ──────────────────────────────────────────────────────

  async listWindows(): Promise<WindowInfo[]> {
    if (!(await this.hasBinary('wmctrl'))) return [];
    try {
      // -l -G -p: <id> <desktop> <pid> <x> <y> <w> <h> <host> <title...>
      const { stdout } = await execFileAsync('wmctrl', ['-l', '-G', '-p'], {
        timeout: TOOL_TIMEOUT_MS,
      });
      return this.parseWmctrlOutput(stdout);
    } catch {
      return [];
    }
  }

  async getActiveWindow(): Promise<WindowInfo | null> {
    // xdotool gives us the active window id directly; we cross-reference wmctrl
    // for title/pid/bounds. Missing xdotool → fall back to first non-minimized.
    const all = await this.listWindows();
    if (!all.length) return null;

    if (await this.hasBinary('xdotool')) {
      try {
        const { stdout } = await execFileAsync('xdotool', ['getactivewindow'], {
          timeout: TOOL_TIMEOUT_MS,
        });
        const id = parseInt(stdout.trim(), 10);
        if (Number.isFinite(id)) {
          const match = all.find(w => typeof w.handle === 'number' && w.handle === id);
          if (match) return match;
        }
      } catch {
        /* fall through */
      }
    }
    return all[0] ?? null;
  }

  async focusWindow(query: { processName?: string; processId?: number; title?: string }): Promise<boolean> {
    if (!(await this.hasBinary('wmctrl'))) return false;

    // Prefer pid-based focus when we know it (wmctrl -i -a expects window id,
    // not pid, so we find the matching id from the list first).
    try {
      const windows = await this.listWindows();
      const match = windows.find(w => {
        if (query.processId !== undefined && w.processId === query.processId) return true;
        if (query.processName && w.processName.toLowerCase() === query.processName.toLowerCase()) return true;
        if (query.title && w.title.toLowerCase().includes(query.title.toLowerCase())) return true;
        return false;
      });

      if (match?.handle !== undefined) {
        const handleHex = typeof match.handle === 'number'
          ? '0x' + match.handle.toString(16)
          : String(match.handle);
        await execFileAsync('wmctrl', ['-i', '-a', handleHex], { timeout: TOOL_TIMEOUT_MS });
        return true;
      }

      // Fallback: wmctrl -a <title substring>
      if (query.title) {
        await execFileAsync('wmctrl', ['-a', query.title], { timeout: TOOL_TIMEOUT_MS });
        return true;
      }
      return false;
    } catch {
      return false;
    }
  }

  async maximizeWindow(): Promise<void> {
    if (!(await this.hasBinary('wmctrl'))) return;
    try {
      await execFileAsync(
        'wmctrl',
        ['-r', ':ACTIVE:', '-b', 'add,maximized_vert,maximized_horz'],
        { timeout: TOOL_TIMEOUT_MS },
      );
    } catch {
      /* non-fatal */
    }
  }

  // ─── ACCESSIBILITY ────────────────────────────────────────────────
  // AT-SPI D-Bus bridge is not yet implemented — return safe empties.

  async getUiTree(_processId?: number): Promise<UiElement[]> {
    return [];
  }

  async findElements(_query: { name?: string; controlType?: string; processId?: number }): Promise<UiElement[]> {
    return [];
  }

  async getFocusedElement(): Promise<UiElement | null> {
    return null;
  }

  async invokeElement(_query: {
    name?: string;
    controlType?: string;
    processId?: number;
    action?: 'click' | 'focus' | 'set-value';
    value?: string;
  }): Promise<{ success: boolean; bounds?: { x: number; y: number; width: number; height: number } }> {
    return { success: false };
  }

  // ─── INPUT (mouse) ────────────────────────────────────────────────

  async mouseClick(x: number, y: number, opts?: { button?: 'left' | 'right'; count?: number }): Promise<void> {
    await mouse.setPosition(new Point(x, y));
    await this.delay(30);
    const count = opts?.count ?? 1;
    for (let i = 0; i < count; i++) {
      if (opts?.button === 'right') await mouse.rightClick();
      else await mouse.click(Button.LEFT);
      if (i < count - 1) await this.delay(50);
    }
  }

  async mouseMove(x: number, y: number): Promise<void> {
    await mouse.setPosition(new Point(x, y));
  }

  async mouseDrag(x1: number, y1: number, x2: number, y2: number): Promise<void> {
    await mouse.setPosition(new Point(x1, y1));
    await this.delay(50);
    await mouse.pressButton(Button.LEFT);
    await this.delay(80);
    const steps = Math.max(8, Math.floor(Math.hypot(x2 - x1, y2 - y1) / 18));
    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      await mouse.setPosition(
        new Point(
          Math.round(x1 + (x2 - x1) * t),
          Math.round(y1 + (y2 - y1) * t),
        ),
      );
      await this.delay(10);
    }
    await mouse.releaseButton(Button.LEFT);
  }

  async mouseScroll(x: number, y: number, direction: 'up' | 'down', amount: number = 3): Promise<void> {
    await mouse.setPosition(new Point(x, y));
    await this.delay(30);
    if (direction === 'down') await mouse.scrollDown(amount);
    else await mouse.scrollUp(amount);
  }

  // ─── INPUT (keyboard) ─────────────────────────────────────────────

  async typeText(text: string): Promise<void> {
    if (!text) return;
    await keyboard.type(text);
  }

  async keyPress(combo: PortableKeyCombo): Promise<void> {
    if (!combo) return;

    // Literal "+" — can't split on it.
    if (combo === '+') {
      await keyboard.type('+');
      return;
    }

    const parts = combo.split('+').map(s => s.trim()).filter(Boolean);
    const keyName = parts[parts.length - 1];
    const modNames = parts.slice(0, -1);

    const modKeys = modNames.map(m => this.resolveModifier(m)).filter((k): k is Key => k !== null);
    const mainKey = this.resolveKey(keyName);

    if (mainKey === null) {
      // Unknown multi-char key — best-effort type as text.
      if (modKeys.length === 0 && keyName.length > 0) {
        await keyboard.type(keyName);
      }
      return;
    }

    try {
      if (modKeys.length > 0) {
        await keyboard.pressKey(...modKeys, mainKey);
        await keyboard.releaseKey(...modKeys, mainKey);
      } else {
        await keyboard.pressKey(mainKey);
        await keyboard.releaseKey(mainKey);
      }
    } catch {
      /* non-fatal — caller likely has a retry or fallback */
    }
  }

  private resolveModifier(name: string): Key | null {
    const m = name.toLowerCase();
    // "mod" on Linux → Control (brief §9).
    if (m === 'mod' || m === 'ctrl' || m === 'control') return Key.LeftControl;
    if (m === 'shift') return Key.LeftShift;
    if (m === 'alt' || m === 'option' || m === 'opt') return Key.LeftAlt;
    if (m === 'super' || m === 'cmd' || m === 'command' || m === 'meta' || m === 'win') return Key.LeftSuper;
    return null;
  }

  private resolveKey(name: string): Key | null {
    if (!name) return null;
    const lower = name.toLowerCase();

    // Special / named keys.
    const named = LINUX_SPECIAL_KEYS[lower];
    if (named !== undefined) return named;

    // Single printable char: letters a-z, digits 0-9, a few punctuation.
    if (name.length === 1) {
      const code = name.toUpperCase().charCodeAt(0);
      // Letters A-Z → Key.A .. Key.Z
      if (code >= 65 && code <= 90) {
        const keyName = name.toUpperCase() as keyof typeof Key;
        const k = Key[keyName];
        if (typeof k === 'number') return k as Key;
      }
      // Digits 0-9 → Key.Num0 .. Key.Num9
      if (code >= 0x30 && code <= 0x39) {
        const keyName = `Num${name}` as keyof typeof Key;
        const k = Key[keyName];
        if (typeof k === 'number') return k as Key;
      }
      // Common punctuation
      const punct = PUNCTUATION_KEYS[name];
      if (punct !== undefined) return punct;
    }

    return null;
  }

  // ─── CLIPBOARD ────────────────────────────────────────────────────

  async readClipboard(): Promise<string> {
    if (!(await this.hasBinary('xclip'))) return '';
    try {
      const { stdout } = await execFileAsync(
        'xclip',
        ['-selection', 'clipboard', '-o'],
        { timeout: TOOL_TIMEOUT_MS },
      );
      return stdout;
    } catch {
      return '';
    }
  }

  async writeClipboard(text: string): Promise<void> {
    if (!(await this.hasBinary('xclip'))) return;
    await new Promise<void>((resolve) => {
      try {
        const proc = spawn('xclip', ['-selection', 'clipboard']);
        const timer = setTimeout(() => {
          proc.kill();
          resolve();
        }, TOOL_TIMEOUT_MS);
        proc.on('close', () => {
          clearTimeout(timer);
          resolve();
        });
        proc.on('error', () => {
          clearTimeout(timer);
          resolve();
        });
        proc.stdin.write(text);
        proc.stdin.end();
      } catch {
        resolve();
      }
    });
  }

  // ─── APPS ─────────────────────────────────────────────────────────

  async openApp(name: string): Promise<{ pid?: number; title?: string }> {
    return this.launchApp(name);
  }

  async launchApp(
    name: string,
    opts?: { alwaysNewInstance?: boolean; url?: string; cwd?: string; uwpAppId?: string },
  ): Promise<{ pid?: number; title?: string; handle?: number | string }> {
    // uwpAppId is Windows-only — ignore on Linux.
    void opts?.uwpAppId;
    if (/[\r\n\t\x00-\x1f]/.test(name)) {
      throw new Error('launchApp: illegal characters in app name');
    }
    const settleMs = opts?.alwaysNewInstance ? 1200 : 800;

    // 1) Try the bare executable name directly (detached so it survives us).
    const directArgs: string[] = [];
    if (opts?.url) directArgs.push(opts.url);
    const direct = await this.spawnDetached(name, directArgs, opts?.cwd);
    if (direct.ok) {
      await this.delay(settleMs);
      const match = await this.findSpawnedWindow(name, direct.pid);
      return match ?? { pid: direct.pid };
    }

    // 2) Fallback to xdg-open (handles desktop-file names, URLs, file paths).
    const target = opts?.url ?? name;
    if (await this.hasBinary('xdg-open')) {
      const fallback = await this.spawnDetached('xdg-open', [target], opts?.cwd);
      if (fallback.ok) {
        await this.delay(settleMs);
        const match = await this.findSpawnedWindow(name);
        return match ?? {};
      }
    }

    return {};
  }

  private async findSpawnedWindow(name: string, pid?: number): Promise<{ pid?: number; title?: string } | null> {
    const windows = await this.listWindows();
    const byPid = pid ? windows.find(w => w.processId === pid) : undefined;
    if (byPid) return { pid: byPid.processId, title: byPid.title };

    const lower = name.toLowerCase();
    const byName = windows.find(w =>
      w.processName.toLowerCase() === lower ||
      w.title.toLowerCase().includes(lower),
    );
    return byName ? { pid: byName.processId, title: byName.title } : null;
  }

  private spawnDetached(cmd: string, args: string[], cwd?: string): Promise<{ ok: boolean; pid?: number }> {
    return new Promise((resolve) => {
      try {
        const proc = spawn(cmd, args, { detached: true, stdio: 'ignore', cwd });
        let settled = false;

        // "error" fires synchronously-ish for ENOENT.
        proc.on('error', () => {
          if (!settled) {
            settled = true;
            resolve({ ok: false });
          }
        });

        // If it launches cleanly, we get a pid immediately.
        setImmediate(() => {
          if (settled) return;
          if (proc.pid) {
            settled = true;
            try { proc.unref(); } catch { /* */ }
            resolve({ ok: true, pid: proc.pid });
          } else {
            settled = true;
            resolve({ ok: false });
          }
        });
      } catch {
        resolve({ ok: false });
      }
    });
  }

  // ─── INTERNAL HELPERS ─────────────────────────────────────────────

  private async hasBinary(name: string): Promise<boolean> {
    const cached = this.binaryCache.get(name);
    if (cached !== undefined) return cached;
    try {
      await execFileAsync('command', ['-v', name], { timeout: 1_500, shell: '/bin/sh' });
      this.binaryCache.set(name, true);
      return true;
    } catch {
      // Fallback: try `which`.
      try {
        await execFileAsync('which', [name], { timeout: 1_500 });
        this.binaryCache.set(name, true);
        return true;
      } catch {
        this.binaryCache.set(name, false);
        return false;
      }
    }
  }

  private parseWmctrlOutput(stdout: string): WindowInfo[] {
    const results: WindowInfo[] = [];
    for (const rawLine of stdout.split('\n')) {
      const line = rawLine.trim();
      if (!line) continue;

      // With -l -G -p: windowId desktop pid x y width height host title...
      const parts = line.split(/\s+/);
      if (parts.length < 9) continue;

      const windowId = parseInt(parts[0], 16);
      const desktop = parseInt(parts[1], 10);
      const pid = parseInt(parts[2], 10);
      const x = parseInt(parts[3], 10);
      const y = parseInt(parts[4], 10);
      const w = parseInt(parts[5], 10);
      const h = parseInt(parts[6], 10);
      // parts[7] = host; title is everything after.
      const title = parts.slice(8).join(' ');

      if (!title || title === 'Desktop') continue;

      results.push({
        title,
        processName: '', // wmctrl doesn't expose process name
        processId: Number.isFinite(pid) ? pid : 0,
        bounds: {
          x: Number.isFinite(x) ? x : 0,
          y: Number.isFinite(y) ? y : 0,
          width: Number.isFinite(w) ? w : 0,
          height: Number.isFinite(h) ? h : 0,
        },
        // wmctrl -l -G -p doesn't report minimized state directly; desktop=-1 is "all",
        // not minimized. Minimized windows still appear in this list.
        isMinimized: desktop === -1 ? false : false,
        handle: Number.isFinite(windowId) ? windowId : undefined,
      });
    }
    return results;
  }

  private withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
      p.then(v => { clearTimeout(timer); resolve(v); })
       .catch(e => { clearTimeout(timer); reject(e); });
    });
  }

  private delay(ms: number): Promise<void> {
    return new Promise(r => setTimeout(r, ms));
  }
}

// Named-key table — lowercase lookup, maps to nut-js Key enum.
const LINUX_SPECIAL_KEYS: Record<string, Key> = {
  'return': Key.Return, 'enter': Key.Enter,
  'tab': Key.Tab,
  'space': Key.Space,
  'backspace': Key.Backspace,
  'delete': Key.Delete,
  'escape': Key.Escape, 'esc': Key.Escape,
  'left': Key.Left, 'right': Key.Right, 'up': Key.Up, 'down': Key.Down,
  'home': Key.Home, 'end': Key.End,
  'pageup': Key.PageUp, 'pagedown': Key.PageDown,
  'insert': Key.Insert,
  'capslock': Key.CapsLock,
  'numlock': Key.NumLock,
  'scrolllock': Key.ScrollLock,
  'pause': Key.Pause,
  'print': Key.Print,
  'menu': Key.Menu,
  'f1': Key.F1, 'f2': Key.F2, 'f3': Key.F3, 'f4': Key.F4,
  'f5': Key.F5, 'f6': Key.F6, 'f7': Key.F7, 'f8': Key.F8,
  'f9': Key.F9, 'f10': Key.F10, 'f11': Key.F11, 'f12': Key.F12,
};

// Punctuation keys — nut-js enum names differ from the character.
const PUNCTUATION_KEYS: Record<string, Key> = {
  '-': Key.Minus,
  '=': Key.Equal,
  '[': Key.LeftBracket,
  ']': Key.RightBracket,
  '\\': Key.Backslash,
  ';': Key.Semicolon,
  "'": Key.Quote,
  ',': Key.Comma,
  '.': Key.Period,
  '/': Key.Slash,
  '`': Key.Grave,
};
