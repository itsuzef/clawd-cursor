/**
 * PlatformAdapter — single contract for all platform-specific operations.
 *
 * Replaces scattered `if (IS_MAC) ... else ...` branching across 34 files.
 * Each platform implements this interface; business logic stays platform-free.
 */

export interface ScreenSize {
  /** Physical pixels (what screenshots are captured at). */
  physicalWidth: number;
  physicalHeight: number;
  /** Logical pixels (what mouse coordinates use). */
  logicalWidth: number;
  logicalHeight: number;
  /** Physical / logical (e.g. 2.0 on Retina, 1.0 on standard). */
  dpiRatio: number;
}

export interface ScreenshotResult {
  /** PNG image buffer. */
  buffer: Buffer;
  /** Image dimensions (may differ from screen size if resized). */
  width: number;
  height: number;
  /** Multiplier to convert image coords back to physical screen coords. */
  scaleFactor: number;
}

export interface WindowInfo {
  title: string;
  processName: string;
  processId: number;
  bounds: { x: number; y: number; width: number; height: number };
  isMinimized: boolean;
  /** Platform-opaque handle for re-targeting. */
  handle?: number | string;
}

export interface UiElement {
  name: string;
  controlType: string;
  bounds: { x: number; y: number; width: number; height: number };
  /** Optional structured value (e.g. text field contents). */
  value?: string;
  /** Whether the element is enabled and visible. */
  enabled?: boolean;
  /** Whether the element currently has keyboard focus. */
  focused?: boolean;
}

export interface PermissionStatus {
  /** Can we send keyboard/mouse events to other apps? */
  input: boolean;
  /** Can we read window contents / accessibility tree? */
  accessibility: boolean;
  /** Can we capture the screen? */
  screenRecording: boolean;
}

/**
 * Platform-agnostic interface every supported OS implements.
 *
 * Business logic uses this interface and never touches `process.platform`.
 */
export interface PlatformAdapter {
  /** OS family this adapter handles. */
  readonly platform: 'darwin' | 'win32' | 'linux';

  /** One-time setup (warm caches, start helpers). */
  init(): Promise<void>;

  /** Cleanup on shutdown. */
  shutdown(): Promise<void>;

  // ─── PERMISSIONS ────────────────────────────────────────────────
  /** Check current permission status (no prompts). */
  checkPermissions(): Promise<PermissionStatus>;
  /** Request OS to prompt the user for missing permissions. */
  requestPermissions(): Promise<PermissionStatus>;

  // ─── DISPLAY ────────────────────────────────────────────────────
  /** Get the primary display geometry. */
  getScreenSize(): Promise<ScreenSize>;
  /** Capture the full screen as PNG. Optionally resize to maxWidth. */
  screenshot(opts?: { maxWidth?: number }): Promise<ScreenshotResult>;
  /** Capture a region of the screen. */
  screenshotRegion(x: number, y: number, w: number, h: number): Promise<ScreenshotResult>;

  // ─── WINDOWS ────────────────────────────────────────────────────
  /** List all visible windows. */
  listWindows(): Promise<WindowInfo[]>;
  /** Get the currently foreground window. */
  getActiveWindow(): Promise<WindowInfo | null>;
  /** Bring a window to front by process name, pid, or title substring. */
  focusWindow(query: { processName?: string; processId?: number; title?: string }): Promise<boolean>;
  /** Maximize the foreground window. */
  maximizeWindow(): Promise<void>;

  // ─── ACCESSIBILITY ──────────────────────────────────────────────
  /** Get the accessibility tree of the focused window as a flat element list. */
  getUiTree(processId?: number): Promise<UiElement[]>;
  /** Find UI elements matching a query (name, control type, etc.). */
  findElements(query: { name?: string; controlType?: string; processId?: number }): Promise<UiElement[]>;
  /** Get the currently focused UI element. */
  getFocusedElement(): Promise<UiElement | null>;
  /** Invoke an accessibility action on a named element (more reliable than coord click). */
  invokeElement(query: { name?: string; controlType?: string; processId?: number; action?: 'click' | 'focus' | 'set-value'; value?: string }): Promise<{ success: boolean; bounds?: { x: number; y: number; width: number; height: number } }>;

  // ─── INPUT (mouse) ──────────────────────────────────────────────
  /** All coords are in LOGICAL pixels (mouse coordinate space). */
  mouseClick(x: number, y: number, opts?: { button?: 'left' | 'right'; count?: number }): Promise<void>;
  mouseMove(x: number, y: number): Promise<void>;
  mouseDrag(x1: number, y1: number, x2: number, y2: number): Promise<void>;
  mouseScroll(x: number, y: number, direction: 'up' | 'down', amount?: number): Promise<void>;

  // ─── INPUT (keyboard) ───────────────────────────────────────────
  /** Type a string of characters. */
  typeText(text: string): Promise<void>;
  /** Press a key combo using a portable spec, e.g. "mod+s", "shift+Return". */
  keyPress(combo: PortableKeyCombo): Promise<void>;

  // ─── CLIPBOARD ──────────────────────────────────────────────────
  readClipboard(): Promise<string>;
  writeClipboard(text: string): Promise<void>;

  // ─── APPS ───────────────────────────────────────────────────────
  /** Open an application by user-friendly name (e.g. "Safari", "notepad"). */
  openApp(name: string): Promise<{ pid?: number; title?: string }>;

  /**
   * Extended app launch (v0.8.1).
   *
   * Unlike {@link openApp}, this returns richer metadata (hwnd on Windows when
   * available) and accepts launch options: `alwaysNewInstance` forces a fresh
   * process (for apps like mspaint where the user may already have an instance
   * running and want a separate window); `url` launches a browser directly at
   * a target URL on platforms where that's a single syscall.
   *
   * Implementations SHOULD fall back to `openApp` behavior when their OS can't
   * honor an option. The router port (pipeline/router) expects this method to
   * exist for all three platforms.
   */
  launchApp(name: string, opts?: {
    alwaysNewInstance?: boolean;
    url?: string;
    cwd?: string;
    /**
     * Windows UWP AppsFolder ID (e.g. `Microsoft.WindowsCalculator_8wekyb3d8bbwe!App`).
     * When provided, the Windows adapter launches via `explorer.exe shell:AppsFolder\<id>`,
     * which works reliably for UWP / Store apps where `Start-Process -FilePath <exe>`
     * silently fails. Ignored on macOS and Linux.
     */
    uwpAppId?: string;
  }): Promise<{ pid?: number; title?: string; handle?: number | string }>;
}

/**
 * Portable key combo spec — uses semantic modifiers, not platform names.
 *
 * "mod" resolves to Cmd on macOS, Ctrl on Windows/Linux.
 * "alt" stays "alt" on Windows/Linux, becomes "option" on macOS at the OS level.
 *
 * Examples:
 *   "mod+s"       — save (Cmd+S on mac, Ctrl+S elsewhere)
 *   "mod+shift+t" — reopen tab
 *   "Return"      — single key
 *   "shift+Tab"   — modifier + key
 */
export type PortableKeyCombo = string;
