/**
 * A11y bounds resolver — math-only, zero LLM, zero vision.
 *
 * Ported from src/a11y-click-resolver.ts. Decoupled from the legacy
 * `AccessibilityBridge` class — the unified pipeline hands in a resolver
 * function that returns UI element bounds (typically from
 * `PlatformAdapter.findElements`).
 *
 * The critical invariant v0.6.3 earned through real-world bug hunting:
 * reject bounds with `y:-29503` and similar absurd values that some a11y
 * APIs return for hidden/off-screen elements. This file's `isValidBounds`
 * is the guard.
 */

export interface Bounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface UiElementWithBounds {
  name?: string;
  controlType?: string;
  bounds?: Bounds;
  automationId?: string;
}

/**
 * Bounds sanity check. Rejects:
 *  - zero/negative width or height
 *  - off-screen coordinates that indicate hidden elements
 *    (e.g. macOS AX returns y:-29503 for some cached-but-invisible items)
 *  - out-of-range coordinates > 10k (no real screen is that large; 8K is ~8000)
 */
export function isValidBounds(b: Bounds | undefined): boolean {
  if (!b || b.width <= 0 || b.height <= 0) return false;
  if (b.x < -100 || b.y < -100) return false;
  if (b.x > 10_000 || b.y > 10_000) return false;
  return true;
}

/**
 * Return the integer center of a bounds rect.
 */
export function centerOf(b: Bounds): { x: number; y: number } {
  return {
    x: b.x + Math.floor(b.width / 2),
    y: b.y + Math.floor(b.height / 2),
  };
}

/**
 * Resolve an element name/automationId to its center coords.
 *
 * `lookup` is a caller-provided function so this module is decoupled from any
 * specific `AccessibilityBridge` or `PlatformAdapter` instance — tests can
 * stub it, and the pipeline can wire whatever adapter it has.
 *
 * Returns null if the element isn't found or its bounds fail the sanity
 * check. Callers should fall back to OCR-based coord resolution on null.
 */
export async function resolveByName(
  name: string,
  lookup: (q: { name?: string; controlType?: string; processId?: number }) => Promise<UiElementWithBounds[]>,
  opts?: { controlType?: string; processId?: number },
): Promise<{ x: number; y: number } | null> {
  const results = await lookup({ name, ...opts });
  if (!results?.length) return null;
  const first = results[0];
  if (!isValidBounds(first.bounds)) return null;
  return centerOf(first.bounds!);
}

/**
 * Resolve by a11y automationId (Windows UIA only today; noop elsewhere).
 */
export async function resolveById(
  automationId: string,
  lookup: (q: { automationId?: string; processId?: number }) => Promise<UiElementWithBounds[]>,
  opts?: { processId?: number },
): Promise<{ x: number; y: number } | null> {
  const results = await lookup({ automationId, ...opts });
  if (!results?.length) return null;
  const first = results[0];
  if (!isValidBounds(first.bounds)) return null;
  return centerOf(first.bounds!);
}
