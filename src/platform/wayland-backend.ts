/**
 * Wayland input routing via ydotool / wtype.
 *
 * The Linux adapter's nut-js path silently fails on most Wayland
 * compositors because synthetic input events are blocked at the
 * compositor layer unless injected through a privileged daemon.
 * This module provides a minimal backend that routes mouse + keyboard
 * operations through `ydotool` (requires `ydotoold` running with
 * uinput access) or `wtype` (keyboard-only).
 *
 * Detection order at construction:
 *   1. `ydotool` + socket reachable → preferred (mouse + keyboard)
 *   2. `wtype` → keyboard-only fallback
 *   3. neither → `none`; caller must return graceful error
 *
 * ydotool reference:
 *   mousemove --absolute <x> <y>
 *   click 0xC0                  (left)   0xC1 (right)   0xC2 (middle)
 *   key <code>:1                (down)   <code>:0      (up)
 *   type --delay 10 "text"
 *   mousemove -x <dx> -y <dy>  (relative)
 *
 * All command construction goes through `execFile` (not shell), so
 * there is NO shell interpolation of user text — clawdcursor typing
 * a string with `$` or backticks is safe.
 */

import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);
const TIMEOUT_MS = 5_000;

/** Which backend the LinuxAdapter should use on Wayland. */
export type WaylandInputKind = 'ydotool' | 'wtype-keyboard-only' | 'none';

/** Linux keycodes for the commonly-held modifiers + named keys we care about.
 *  Source: /usr/include/linux/input-event-codes.h
 *  Complete list isn't needed — covers the 90% case. Unknown keys fall back
 *  to `ydotool type` (which synthesizes the codepoint).
 */
const LINUX_KEYCODES: Record<string, number> = {
  // Modifiers
  ctrl:     29,  control:   29,  leftctrl:  29,
  rightctrl:97,
  shift:    42,  leftshift: 42,
  rightshift: 54,
  alt:      56,  option:    56,  leftalt:   56,
  rightalt: 100, altgr:     100,
  super:    125, meta:      125, win:       125, cmd: 125,
  rightsuper: 126,

  // Navigation / editing
  return:   28, enter: 28,
  tab:      15,
  escape:   1,  esc: 1,
  backspace:14,
  space:    57,
  delete:   111,
  home:     102,
  end:      107,
  pageup:   104,
  pagedown: 109,
  insert:   110,
  capslock: 58,

  // Arrows
  left:     105,
  right:    106,
  up:       103,
  down:     108,

  // F-keys
  f1: 59, f2: 60, f3: 61, f4: 62, f5: 63, f6: 64,
  f7: 65, f8: 66, f9: 67, f10: 68, f11: 87, f12: 88,
};

/** Map an ASCII alphanumeric character to its Linux keycode. */
function charToKeycode(ch: string): number | null {
  if (ch.length !== 1) return null;
  const lower = ch.toLowerCase();
  // a-z → 30..56 skipping a few (30=a, 48=b, 46=c, 32=d, 18=e, 33=f, 34=g,
  //   35=h, 23=i, 36=j, 37=k, 38=l, 50=m, 49=n, 24=o, 25=p, 16=q, 19=r,
  //   31=s, 20=t, 22=u, 47=v, 17=w, 45=x, 21=y, 44=z)
  const lettersMap: Record<string, number> = {
    a:30,b:48,c:46,d:32,e:18,f:33,g:34,h:35,i:23,j:36,
    k:37,l:38,m:50,n:49,o:24,p:25,q:16,r:19,s:31,t:20,
    u:22,v:47,w:17,x:45,y:21,z:44,
  };
  if (lower in lettersMap) return lettersMap[lower];
  // 0-9 → 10..19 (0=11, 1=2, 2=3, ..., 9=10)  Wait — actually 1=2, 2=3, ..., 0=11.
  const digitsMap: Record<string, number> = {
    '1':2,'2':3,'3':4,'4':5,'5':6,'6':7,'7':8,'8':9,'9':10,'0':11,
  };
  if (lower in digitsMap) return digitsMap[lower];
  return null;
}

export class WaylandBackend {
  readonly kind: WaylandInputKind;
  private readonly mod2code: Record<string, number>;

  constructor(kind: WaylandInputKind) {
    this.kind = kind;
    this.mod2code = {
      mod: LINUX_KEYCODES.ctrl, // Linux "mod" resolves to Ctrl (same as clawdcursor's portable spec)
      ctrl: LINUX_KEYCODES.ctrl,
      control: LINUX_KEYCODES.ctrl,
      shift: LINUX_KEYCODES.shift,
      alt: LINUX_KEYCODES.alt,
      option: LINUX_KEYCODES.alt,
      super: LINUX_KEYCODES.super,
      meta: LINUX_KEYCODES.super,
      cmd: LINUX_KEYCODES.super,
      command: LINUX_KEYCODES.super,
      win: LINUX_KEYCODES.super,
    };
  }

  static async detect(hasBinary: (name: string) => Promise<boolean>): Promise<WaylandBackend> {
    const [hasYd, hasWt] = await Promise.all([hasBinary('ydotool'), hasBinary('wtype')]);
    if (hasYd) return new WaylandBackend('ydotool');
    if (hasWt) return new WaylandBackend('wtype-keyboard-only');
    return new WaylandBackend('none');
  }

  canMouse(): boolean { return this.kind === 'ydotool'; }
  canKeyboard(): boolean { return this.kind === 'ydotool' || this.kind === 'wtype-keyboard-only'; }

  // ── Mouse ───────────────────────────────────────────────────

  async mouseMoveAbsolute(x: number, y: number): Promise<void> {
    if (this.kind !== 'ydotool') return;
    await execFileAsync('ydotool', ['mousemove', '--absolute', '-x', String(x), '-y', String(y)], {
      timeout: TIMEOUT_MS,
    });
  }

  async mouseMoveRelative(dx: number, dy: number): Promise<void> {
    if (this.kind !== 'ydotool') return;
    await execFileAsync('ydotool', ['mousemove', '-x', String(dx), '-y', String(dy)], {
      timeout: TIMEOUT_MS,
    });
  }

  /** `click` is a down+up in one ydotool call. For separate down/up, use mouseDown/mouseUp. */
  async mouseClick(button: 'left' | 'right' | 'middle' = 'left', count = 1): Promise<void> {
    if (this.kind !== 'ydotool') return;
    const code = button === 'left' ? '0xC0' : button === 'right' ? '0xC1' : '0xC2';
    for (let i = 0; i < count; i++) {
      await execFileAsync('ydotool', ['click', code], { timeout: TIMEOUT_MS });
      if (i < count - 1) await sleep(50);
    }
  }

  async mouseDown(button: 'left' | 'right' | 'middle' = 'left'): Promise<void> {
    if (this.kind !== 'ydotool') return;
    // ydotool has `mousedown` on newer versions; fall back to the raw button
    // code with :1 suffix which works on all versions.
    const code = button === 'left' ? '0x110' : button === 'right' ? '0x111' : '0x112';
    await execFileAsync('ydotool', ['key', `${code}:1`], { timeout: TIMEOUT_MS });
  }

  async mouseUp(button: 'left' | 'right' | 'middle' = 'left'): Promise<void> {
    if (this.kind !== 'ydotool') return;
    const code = button === 'left' ? '0x110' : button === 'right' ? '0x111' : '0x112';
    await execFileAsync('ydotool', ['key', `${code}:0`], { timeout: TIMEOUT_MS });
  }

  async mouseScroll(direction: 'up' | 'down' | 'left' | 'right', amount = 3): Promise<void> {
    if (this.kind !== 'ydotool') return;
    // `ydotool mousemove --wheel` doesn't exist; use `ydotool scroll` if
    // available, else fall back to button-code press (4/5 vertical, 6/7 horizontal).
    try {
      if (direction === 'up')    await execFileAsync('ydotool', ['scroll', String(-amount)], { timeout: TIMEOUT_MS });
      else if (direction === 'down') await execFileAsync('ydotool', ['scroll', String(amount)], { timeout: TIMEOUT_MS });
      else {
        // Horizontal: ydotool doesn't directly support; fall back to button codes.
        const code = direction === 'left' ? '0x06' : '0x07';
        for (let i = 0; i < amount; i++) {
          await execFileAsync('ydotool', ['key', `${code}:1`, `${code}:0`], { timeout: TIMEOUT_MS });
        }
      }
    } catch {
      // scroll subcmd not supported on this ydotool build — try button codes.
      const code =
        direction === 'up' ? '0x04' :
        direction === 'down' ? '0x05' :
        direction === 'left' ? '0x06' : '0x07';
      for (let i = 0; i < amount; i++) {
        await execFileAsync('ydotool', ['key', `${code}:1`, `${code}:0`], { timeout: TIMEOUT_MS });
      }
    }
  }

  // ── Keyboard ────────────────────────────────────────────────

  /**
   * Press a key combo. On ydotool we map each component to a Linux
   * keycode and emit paired down/up events. On wtype we use wtype's
   * native combo syntax (e.g. `wtype -M ctrl -k s`).
   */
  async keyPress(combo: string): Promise<void> {
    if (this.kind === 'none') return;

    // Special case: literal "+"
    if (combo === '+') {
      if (this.kind === 'ydotool') {
        await execFileAsync('ydotool', ['type', '--', '+'], { timeout: TIMEOUT_MS });
      } else {
        await execFileAsync('wtype', ['+'], { timeout: TIMEOUT_MS });
      }
      return;
    }

    const parts = combo.split('+').map(s => s.trim()).filter(Boolean);
    if (parts.length === 0) return;

    if (this.kind === 'wtype-keyboard-only') {
      // wtype: -M <mod> repeatable, then -k <keyname> or bare text.
      const args: string[] = [];
      const modsLower = parts.slice(0, -1).map(p => p.toLowerCase());
      const key = parts[parts.length - 1];
      for (const m of modsLower) {
        const wm = wtypeModName(m);
        if (wm) { args.push('-M', wm); }
      }
      // wtype named keys (Return, Tab, etc.) go via `-k`.
      const wtypeKey = wtypeKeyName(key);
      if (wtypeKey) {
        args.push('-k', wtypeKey);
      } else if (key.length === 1) {
        args.push(key);
      } else {
        // Unknown key — best-effort type the text.
        args.push(key);
      }
      await execFileAsync('wtype', args, { timeout: TIMEOUT_MS }).catch(() => {});
      return;
    }

    // ydotool path: press all modifier codes (down), tap main key, release modifiers.
    const modCodes: number[] = [];
    for (let i = 0; i < parts.length - 1; i++) {
      const code = this.mod2code[parts[i].toLowerCase()];
      if (typeof code === 'number') modCodes.push(code);
    }
    const mainName = parts[parts.length - 1];
    const mainCode = this.keyToCode(mainName);

    try {
      // Press modifiers
      for (const c of modCodes) {
        await execFileAsync('ydotool', ['key', `${c}:1`], { timeout: TIMEOUT_MS });
      }
      if (mainCode !== null) {
        await execFileAsync('ydotool', ['key', `${mainCode}:1`, `${mainCode}:0`], {
          timeout: TIMEOUT_MS,
        });
      } else if (mainName.length > 0) {
        // No keycode mapping — type it as text (ydotool type handles the layout).
        await execFileAsync('ydotool', ['type', '--', mainName], { timeout: TIMEOUT_MS });
      }
    } finally {
      // Release modifiers in reverse order
      for (let i = modCodes.length - 1; i >= 0; i--) {
        await execFileAsync('ydotool', ['key', `${modCodes[i]}:0`], { timeout: TIMEOUT_MS })
          .catch(() => {});
      }
    }
  }

  async keyDown(key: string): Promise<void> {
    if (this.kind !== 'ydotool') return;
    const code = this.keyToCode(key.toLowerCase());
    if (code === null) return;
    await execFileAsync('ydotool', ['key', `${code}:1`], { timeout: TIMEOUT_MS });
  }

  async keyUp(key: string): Promise<void> {
    if (this.kind !== 'ydotool') return;
    const code = this.keyToCode(key.toLowerCase());
    if (code === null) return;
    await execFileAsync('ydotool', ['key', `${code}:0`], { timeout: TIMEOUT_MS });
  }

  async typeText(text: string): Promise<void> {
    if (this.kind === 'none' || !text) return;
    if (this.kind === 'ydotool') {
      // Small delay so fast apps don't drop chars.
      await execFileAsync('ydotool', ['type', '--delay', '10', '--', text], {
        timeout: TIMEOUT_MS + text.length * 15,
      });
      return;
    }
    // wtype: positional arg
    await execFileAsync('wtype', ['--', text], {
      timeout: TIMEOUT_MS + text.length * 15,
    });
  }

  // ── Internals ───────────────────────────────────────────────

  private keyToCode(name: string): number | null {
    const low = name.toLowerCase();
    if (low in LINUX_KEYCODES) return LINUX_KEYCODES[low];
    if (low in this.mod2code) return this.mod2code[low];
    const ch = charToKeycode(name);
    if (ch !== null) return ch;
    return null;
  }
}

function wtypeModName(m: string): string | null {
  if (m === 'ctrl' || m === 'control' || m === 'mod') return 'ctrl';
  if (m === 'shift') return 'shift';
  if (m === 'alt' || m === 'option') return 'alt';
  if (m === 'super' || m === 'cmd' || m === 'command' || m === 'meta' || m === 'win') return 'logo';
  return null;
}

function wtypeKeyName(k: string): string | null {
  const lo = k.toLowerCase();
  const map: Record<string, string> = {
    return: 'Return', enter: 'Return',
    tab: 'Tab',
    space: 'space',
    escape: 'Escape', esc: 'Escape',
    backspace: 'BackSpace',
    delete: 'Delete',
    home: 'Home', end: 'End',
    pageup: 'Page_Up', pagedown: 'Page_Down',
    insert: 'Insert',
    left: 'Left', right: 'Right', up: 'Up', down: 'Down',
    f1:'F1',f2:'F2',f3:'F3',f4:'F4',f5:'F5',f6:'F6',
    f7:'F7',f8:'F8',f9:'F9',f10:'F10',f11:'F11',f12:'F12',
  };
  return map[lo] ?? null;
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}
