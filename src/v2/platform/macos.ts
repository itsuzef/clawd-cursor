/**
 * macOS PlatformAdapter — all macOS-specific code lives here.
 *
 * Strategy:
 *   - Keystrokes: osascript + System Events (CGEvent from helper is blocked by TCC)
 *   - Mouse: nut-js (nut-js mouse events ARE delivered)
 *   - Screenshot: screenshot-helper Swift binary (avoids ReplayKit CPU spin)
 *   - Accessibility: osascript JXA for tree queries + permission-check binary for TCC
 */

import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import { execFile, spawn } from 'child_process';
import { promisify } from 'util';
import sharp from 'sharp';
import { mouse, Point, Button } from '@nut-tree-fork/nut-js';
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
const SCRIPTS_DIR = path.join(__dirname, '..', '..', '..', 'scripts', 'mac');

// Tunables (kept here, not magic numbers)
const OSASCRIPT_TIMEOUT_MS = 8_000;
const A11Y_TREE_TIMEOUT_MS = 12_000;
const SCREENSHOT_TIMEOUT_MS = 10_000;

export class MacOSAdapter implements PlatformAdapter {
  readonly platform = 'darwin' as const;

  private screenSize: ScreenSize | null = null;
  private screenshotHelperPath: string | null = null;
  private permissionCheckPath: string | null = null;
  private inputPermissionTested = false;
  private inputPermissionCached = false;

  async init(): Promise<void> {
    // Find the helper binaries shipped with the app bundle.
    this.screenshotHelperPath = this.findHelper('screenshot-helper');
    this.permissionCheckPath = this.findHelper('permission-check');

    // Pre-warm screen size so first capture is fast.
    await this.getScreenSize().catch(() => null);
  }

  async shutdown(): Promise<void> {
    // No long-lived processes to clean up — osascript and nut-js are stateless.
  }

  // ─── PERMISSIONS ──────────────────────────────────────────────────

  async checkPermissions(): Promise<PermissionStatus> {
    // Test what THIS process tree can actually do, not the app bundle's TCC entry.
    const [accessibility, screenRecording] = await Promise.all([
      this.probeAccessibility(),
      this.probeScreenRecording(),
    ]);
    return { input: accessibility, accessibility, screenRecording };
  }

  async requestPermissions(): Promise<PermissionStatus> {
    // Spawn permission-check with prompt flags to trigger the native dialogs.
    if (this.permissionCheckPath && fs.existsSync(this.permissionCheckPath)) {
      try {
        await execFileAsync(this.permissionCheckPath, ['--prompt', '--request-screen-recording'], { timeout: 30_000 });
      } catch {
        // The binary may exit non-zero if perms denied — that's fine, dialogs were shown.
      }
    }
    return this.checkPermissions();
  }

  private async probeAccessibility(): Promise<boolean> {
    try {
      // Must test actual window access — process enumeration works without assistive access.
      await execFileAsync('osascript', ['-l', 'JavaScript', '-e',
        'var se = Application("System Events"); var p = se.processes.whose({frontmost: true})[0]; p.windows.length; true',
      ], { timeout: 5_000 });
      return true;
    } catch {
      return false;
    }
  }

  private async probeScreenRecording(): Promise<boolean> {
    // Use the Swift screenshot-helper as the probe — it's what ClawdCursor actually uses.
    if (!this.screenshotHelperPath || !fs.existsSync(this.screenshotHelperPath)) return false;
    return new Promise((resolve) => {
      const tmp = `/tmp/.clawdcursor-probe-${process.pid}.png`;
      const proc = spawn(this.screenshotHelperPath!, ['--fullscreen', tmp]);
      const timer = setTimeout(() => { proc.kill(); resolve(false); }, 5_000);
      proc.on('close', (code) => {
        clearTimeout(timer);
        try {
          if (code === 0 && fs.existsSync(tmp) && fs.statSync(tmp).size > 100) {
            fs.unlinkSync(tmp);
            return resolve(true);
          }
        } catch { /* fallthrough */ }
        try { fs.unlinkSync(tmp); } catch { /* */ }
        resolve(false);
      });
    });
  }

  // ─── DISPLAY ──────────────────────────────────────────────────────

  async getScreenSize(): Promise<ScreenSize> {
    if (this.screenSize) return this.screenSize;

    // Query NSScreen for logical dimensions.
    let logicalWidth = 0, logicalHeight = 0;
    try {
      const out = await execFileAsync('osascript', ['-e',
        `use framework "AppKit"\n` +
        `set frame to current application's NSScreen's mainScreen's frame()\n` +
        `set sz to size of frame\n` +
        `return ((width of sz) as integer) & "," & ((height of sz) as integer) as text`,
      ], { timeout: 5_000 });
      const [w, h] = out.stdout.trim().split(',').map(s => parseInt(s, 10));
      logicalWidth = w || 0; logicalHeight = h || 0;
    } catch { /* fall through */ }

    // Capture a probe screenshot to learn physical dimensions.
    const probe = await this.screenshot();
    const physicalWidth = probe.width * probe.scaleFactor;
    const physicalHeight = probe.height * probe.scaleFactor;
    if (!logicalWidth) logicalWidth = probe.width;
    if (!logicalHeight) logicalHeight = probe.height;

    const dpiRatio = physicalWidth > logicalWidth ? physicalWidth / logicalWidth : 1;

    this.screenSize = { physicalWidth, physicalHeight, logicalWidth, logicalHeight, dpiRatio };
    return this.screenSize;
  }

  async screenshot(opts?: { maxWidth?: number }): Promise<ScreenshotResult> {
    if (!this.screenshotHelperPath) throw new Error('screenshot-helper not found');

    const tmp = `/tmp/.clawdcursor-shot-${process.pid}-${Date.now()}.png`;
    try {
      await execFileAsync(this.screenshotHelperPath, ['--fullscreen', tmp], {
        timeout: SCREENSHOT_TIMEOUT_MS,
      });
      let buffer: Buffer = fs.readFileSync(tmp);
      try { fs.unlinkSync(tmp); } catch { /* */ }

      const meta = await sharp(buffer).metadata();
      let width = meta.width || 0;
      let height = meta.height || 0;
      let scaleFactor = 1;

      if (opts?.maxWidth && width > opts.maxWidth) {
        scaleFactor = width / opts.maxWidth;
        const newH = Math.round(height / scaleFactor);
        const resized = await sharp(buffer).resize(opts.maxWidth, newH, { fit: 'fill' }).png().toBuffer();
        buffer = Buffer.from(resized);
        width = opts.maxWidth;
        height = newH;
      }

      return { buffer, width, height, scaleFactor };
    } catch (err) {
      try { fs.unlinkSync(tmp); } catch { /* */ }
      throw err;
    }
  }

  async screenshotRegion(x: number, y: number, w: number, h: number): Promise<ScreenshotResult> {
    const full = await this.screenshot();
    const buffer = await sharp(full.buffer).extract({ left: x, top: y, width: w, height: h }).png().toBuffer();
    return { buffer, width: w, height: h, scaleFactor: 1 };
  }

  // ─── WINDOWS ──────────────────────────────────────────────────────

  async listWindows(): Promise<WindowInfo[]> {
    try {
      const scriptPath = path.join(SCRIPTS_DIR, 'get-windows.jxa');
      const { stdout } = await execFileAsync('osascript', ['-l', 'JavaScript', scriptPath], {
        timeout: OSASCRIPT_TIMEOUT_MS,
      });
      const raw = JSON.parse(stdout);
      return Array.isArray(raw) ? raw.map(this.normalizeWindow) : [];
    } catch {
      return [];
    }
  }

  async getActiveWindow(): Promise<WindowInfo | null> {
    try {
      const scriptPath = path.join(SCRIPTS_DIR, 'get-foreground-window.jxa');
      const { stdout } = await execFileAsync('osascript', ['-l', 'JavaScript', scriptPath], {
        timeout: OSASCRIPT_TIMEOUT_MS,
      });
      const raw = JSON.parse(stdout);
      return raw ? this.normalizeWindow(raw) : null;
    } catch {
      return null;
    }
  }

  async focusWindow(query: { processName?: string; processId?: number; title?: string }): Promise<boolean> {
    const args: string[] = [];
    if (query.processId !== undefined) args.push('-FocusedProcessId', String(query.processId));
    if (query.processName) args.push('-ProcessName', query.processName);
    if (query.title) args.push('-WindowTitle', query.title);
    try {
      const scriptPath = path.join(SCRIPTS_DIR, 'focus-window.jxa');
      const { stdout } = await execFileAsync('osascript', ['-l', 'JavaScript', scriptPath, ...args], {
        timeout: OSASCRIPT_TIMEOUT_MS,
      });
      const result = JSON.parse(stdout);
      return result?.success === true;
    } catch {
      return false;
    }
  }

  async maximizeWindow(): Promise<void> {
    // macOS native fullscreen toggle.
    await this.keyPress('ctrl+mod+f').catch(() => { /* non-fatal */ });
  }

  // ─── ACCESSIBILITY ────────────────────────────────────────────────

  async getUiTree(processId?: number): Promise<UiElement[]> {
    try {
      const args = ['-l', 'JavaScript', path.join(SCRIPTS_DIR, 'get-screen-context.jxa')];
      if (processId !== undefined) args.push('--', '-FocusedProcessId', String(processId));
      const { stdout } = await execFileAsync('osascript', args, { timeout: A11Y_TREE_TIMEOUT_MS });
      const data = JSON.parse(stdout);
      return this.flattenTree(data?.uiTree);
    } catch {
      return [];
    }
  }

  async findElements(query: { name?: string; controlType?: string; processId?: number }): Promise<UiElement[]> {
    try {
      const args = ['-l', 'JavaScript', path.join(SCRIPTS_DIR, 'find-element.jxa')];
      if (query.processId !== undefined) args.push('--', '-FocusedProcessId', String(query.processId));
      if (query.name) args.push('-Name', query.name);
      if (query.controlType) args.push('-ControlType', query.controlType);
      const { stdout } = await execFileAsync('osascript', args, { timeout: A11Y_TREE_TIMEOUT_MS });
      const raw = JSON.parse(stdout);
      return Array.isArray(raw) ? raw.map(this.normalizeElement) : [];
    } catch {
      return [];
    }
  }

  async getFocusedElement(): Promise<UiElement | null> {
    try {
      const scriptPath = path.join(SCRIPTS_DIR, 'get-focused-element.jxa');
      const { stdout } = await execFileAsync('osascript', ['-l', 'JavaScript', scriptPath], {
        timeout: OSASCRIPT_TIMEOUT_MS,
      });
      const raw = JSON.parse(stdout);
      return raw ? this.normalizeElement(raw) : null;
    } catch {
      return null;
    }
  }

  async invokeElement(query: {
    name?: string; controlType?: string; processId?: number;
    action?: 'click' | 'focus' | 'set-value'; value?: string;
  }): Promise<{ success: boolean; bounds?: { x: number; y: number; width: number; height: number } }> {
    try {
      const args = ['-l', 'JavaScript', path.join(SCRIPTS_DIR, 'invoke-element.jxa')];
      if (query.processId !== undefined) args.push('--', '-FocusedProcessId', String(query.processId));
      if (query.name) args.push('-Name', query.name);
      if (query.controlType) args.push('-ControlType', query.controlType);
      if (query.action) args.push('-Action', query.action);
      if (query.value !== undefined) args.push('-Value', query.value);
      const { stdout } = await execFileAsync('osascript', args, { timeout: OSASCRIPT_TIMEOUT_MS });
      const result = JSON.parse(stdout);
      return { success: result?.success === true, bounds: result?.bounds };
    } catch {
      return { success: false };
    }
  }

  // ─── INPUT (mouse) ────────────────────────────────────────────────

  async mouseClick(x: number, y: number, opts?: { button?: 'left' | 'right'; count?: number }): Promise<void> {
    await mouse.setPosition(new Point(x, y));
    await this.delay(40);
    const count = opts?.count ?? 1;
    for (let i = 0; i < count; i++) {
      if (opts?.button === 'right') await mouse.rightClick();
      else await mouse.click(Button.LEFT);
      if (i < count - 1) await this.delay(60);
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
      await mouse.setPosition(new Point(Math.round(x1 + (x2 - x1) * t), Math.round(y1 + (y2 - y1) * t)));
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
    // Escape backslashes and quotes for AppleScript string literal.
    const escaped = text.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    await execFileAsync('osascript', ['-e',
      `tell application "System Events" to keystroke "${escaped}"`,
    ], { timeout: 15_000 });
  }

  async keyPress(combo: PortableKeyCombo): Promise<void> {
    if (!combo) return;

    // Literal "+" can't be split.
    if (combo === '+') {
      await execFileAsync('osascript', ['-e', 'tell application "System Events" to keystroke "+"']);
      return;
    }

    const parts = combo.split('+').map(s => s.trim()).filter(Boolean);
    const key = parts[parts.length - 1];
    const mods = parts.slice(0, -1).map(this.normalizeMod);

    const usingClause = mods.length ? ` using {${mods.map(m => `${m} down`).join(', ')}}` : '';

    // Special keys → key code; printable single chars → keystroke.
    const keyCode = MAC_KEY_CODES[key.toLowerCase()];
    let script: string;
    if (keyCode !== undefined) {
      script = `tell application "System Events" to key code ${keyCode}${usingClause}`;
    } else if (key.length === 1) {
      const escaped = key.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
      script = `tell application "System Events" to keystroke "${escaped}"${usingClause}`;
    } else {
      // Unknown multi-char key — try as keystroke (covers things like word chars).
      script = `tell application "System Events" to keystroke "${key}"${usingClause}`;
    }

    await execFileAsync('osascript', ['-e', script], { timeout: 6_000 });
  }

  private normalizeMod(mod: string): string {
    const m = mod.toLowerCase();
    if (m === 'mod' || m === 'cmd' || m === 'command' || m === 'super' || m === 'meta') return 'command';
    if (m === 'shift') return 'shift';
    if (m === 'alt' || m === 'option' || m === 'opt') return 'option';
    if (m === 'ctrl' || m === 'control') return 'control';
    return m;
  }

  // ─── CLIPBOARD ────────────────────────────────────────────────────

  async readClipboard(): Promise<string> {
    try {
      const { stdout } = await execFileAsync('pbpaste', [], { timeout: 3_000 });
      return stdout;
    } catch {
      return '';
    }
  }

  async writeClipboard(text: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const proc = spawn('pbcopy');
      const timer = setTimeout(() => { proc.kill(); reject(new Error('pbcopy timeout')); }, 3_000);
      proc.on('close', (code) => {
        clearTimeout(timer);
        if (code === 0) resolve();
        else reject(new Error(`pbcopy exit ${code}`));
      });
      proc.stdin.write(text);
      proc.stdin.end();
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
    // uwpAppId is Windows-only — ignore on macOS.
    void opts?.uwpAppId;
    // Reject shell-metachar input even though we use execFile (no shell expansion).
    // Keeps parity with Windows' stricter validator and avoids surprising `open`.
    if (/[\r\n\t\x00-\x1f]/.test(name)) {
      throw new Error('launchApp: illegal characters in app name');
    }
    try {
      const args = ['-a', name];
      if (opts?.alwaysNewInstance) args.unshift('-n');
      if (opts?.url) args.push(opts.url);
      await execFileAsync('open', args, {
        timeout: 5_000,
        cwd: opts?.cwd,
      });
      await this.delay(opts?.alwaysNewInstance ? 1200 : 800);
      const win = (await this.listWindows()).find(w =>
        w.processName.toLowerCase() === name.toLowerCase() ||
        w.title.toLowerCase().includes(name.toLowerCase()),
      );
      return win ? { pid: win.processId, title: win.title } : {};
    } catch {
      return {};
    }
  }

  // ─── INTERNAL HELPERS ─────────────────────────────────────────────

  private findHelper(name: string): string | null {
    const candidates = [
      path.join(__dirname, '..', '..', '..', 'native', 'ClawdCursor.app', 'Contents', 'MacOS', name),
      path.join(__dirname, '..', '..', '..', 'node_modules', '.clawdcursor', 'ClawdCursor.app', 'Contents', 'MacOS', name),
      path.join(os.homedir(), '.clawdcursor', 'ClawdCursor.app', 'Contents', 'MacOS', name),
    ];
    return candidates.find(p => fs.existsSync(p)) ?? null;
  }

  private normalizeWindow = (raw: any): WindowInfo => ({
    title: raw.title ?? '',
    processName: raw.processName ?? '',
    processId: raw.processId ?? 0,
    bounds: raw.bounds ?? { x: 0, y: 0, width: 0, height: 0 },
    isMinimized: raw.isMinimized ?? false,
    handle: raw.handle ?? raw.processId,
  });

  private normalizeElement = (raw: any): UiElement => ({
    name: raw.name ?? '',
    controlType: (raw.controlType ?? '').replace('AX', ''),
    bounds: raw.bounds ?? { x: 0, y: 0, width: 0, height: 0 },
    value: raw.value,
    enabled: raw.enabled,
    focused: raw.focused,
  });

  private flattenTree(node: any, acc: UiElement[] = []): UiElement[] {
    if (!node) return acc;
    if (node.controlType || node.name) acc.push(this.normalizeElement(node));
    if (Array.isArray(node.children)) {
      for (const child of node.children) this.flattenTree(child, acc);
    }
    return acc;
  }

  private delay(ms: number): Promise<void> {
    return new Promise(r => setTimeout(r, ms));
  }
}

// macOS virtual keycodes for special keys (US ANSI keyboard).
const MAC_KEY_CODES: Record<string, number> = {
  'return': 36, 'enter': 36,
  'tab': 48,
  'space': 49,
  'delete': 51, 'backspace': 51,
  'escape': 53, 'esc': 53,
  'left': 123, 'right': 124, 'down': 125, 'up': 126,
  'home': 115, 'end': 119, 'pageup': 116, 'pagedown': 121,
  'f1': 122, 'f2': 120, 'f3': 99, 'f4': 118,
  'f5': 96, 'f6': 97, 'f7': 98, 'f8': 100,
  'f9': 101, 'f10': 109, 'f11': 103, 'f12': 111,
  'forwarddelete': 117,
};
