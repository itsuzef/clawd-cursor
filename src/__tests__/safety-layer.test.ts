/**
 * SafetyLayer tests — tier assignment, blocked keys, destructive labels,
 * sensitive apps.
 */

import { describe, it, expect } from 'vitest';
import { evaluate, isAllowed, evaluateInput } from '../core/safety';

describe('SafetyLayer.evaluate', () => {
  describe('read tier', () => {
    it.each(['read_screen', 'desktop_screenshot', 'get_windows', 'read_clipboard', 'cdp_read_text'])(
      '%s always allows',
      (tool) => {
        const d = evaluate({ tool, args: {} });
        expect(d.decision).toBe('allow');
        expect(d.tier).toBe('read');
      },
    );
  });

  describe('blocked keys', () => {
    it('blocks alt+F4 via key_press', () => {
      const d = evaluate({ tool: 'key_press', args: { key: 'alt+f4' } });
      expect(d.decision).toBe('block');
    });
    it('blocks cmd+Q via press (pipeline-internal alias)', () => {
      const d = evaluate({ tool: 'press', args: { combo: 'cmd+q' } });
      expect(d.decision).toBe('block');
    });
    it('blocks ctrl+alt+delete', () => {
      const d = evaluate({ tool: 'key_press', args: { key: 'Ctrl+Alt+Delete' } });
      expect(d.decision).toBe('block');
    });
    it('allows safe combos', () => {
      expect(evaluate({ tool: 'key_press', args: { key: 'mod+s' } }).decision).toBe('allow');
      expect(evaluate({ tool: 'press', args: { combo: 'Return' } }).decision).toBe('allow');
    });
  });

  describe('cdp_evaluate', () => {
    it('requires confirm even without args inspection', () => {
      expect(evaluate({ tool: 'cdp_evaluate', args: {} }).decision).toBe('confirm');
    });
  });

  describe('destructive target labels', () => {
    it.each(['Send', 'Delete', 'Confirm', 'Remove', 'Checkout', 'Pay', 'Publish', 'Log Out'])(
      'elevates click with target=%j to confirm',
      (label) => {
        const d = evaluate({ tool: 'mouse_click', args: {}, targetLabel: label });
        expect(d.decision).toBe('confirm');
        expect(d.tier).toBe('destructive');
      },
    );

    it('allows click on benign target', () => {
      expect(evaluate({ tool: 'mouse_click', args: {}, targetLabel: 'New' }).decision).toBe('allow');
    });
  });

  describe('input tier default', () => {
    it.each(['mouse_click', 'type_text', 'smart_click', 'smart_type', 'a11y_click'])(
      '%s with no target defaults to allow',
      (tool) => {
        expect(evaluate({ tool, args: {} }).decision).toBe('allow');
      },
    );
  });

  describe('isAllowed helper', () => {
    it('is true for allow', () => {
      expect(isAllowed({ decision: 'allow', tier: 'read' })).toBe(true);
    });
    it('is false for confirm and block', () => {
      expect(isAllowed({ decision: 'confirm', tier: 'input', reason: 'x' })).toBe(false);
      expect(isAllowed({ decision: 'block', tier: 'destructive', reason: 'x' })).toBe(false);
    });
  });

  describe('unknown tools default to input tier', () => {
    it('treats a made-up tool name as input tier + allow-by-default', () => {
      const d = evaluate({ tool: 'future_tool_xyz', args: {} });
      expect(d.decision).toBe('allow');
      expect(d.tier).toBe('input');
    });
  });
});

describe('evaluateInput (canonical safety gate)', () => {
  it('returns allow:true for a read-tier tool', () => {
    const d = evaluateInput({ toolName: 'desktop_screenshot', args: {} });
    expect(d.allow).toBe(true);
    expect(d.tier).toBe(0);
  });

  it('safetyTier:3 injected via ToolDefinition overrides name-based lookup', () => {
    // 'wait' is normally tier 0 (read), but declaring it as tier 3 should elevate it
    const d = evaluateInput({ toolName: 'wait', args: {}, safetyTier: 3 });
    // tier 3 maps to 'destructive' — which means decision is 'confirm', so allow === false
    expect(d.allow).toBe(false);
    expect(d.tier).toBe(3);
  });
});
