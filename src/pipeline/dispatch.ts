/**
 * Action dispatcher — translates a PipelineAction into real PlatformAdapter
 * calls, gated by the SafetyLayer.
 *
 * This is the single chokepoint the audit demanded: every agent action
 * (text-agent, vision-agent, playbook retry) flows through here, so
 * safety.evaluate() runs before any side effect.
 *
 * Model-agnostic and OS-agnostic: uses PlatformAdapter for the actual I/O,
 * so a rule fix lands in one place and covers all three OSes.
 */

import type { PlatformAdapter } from '../v2/platform/types';
import type { PipelineAction, ActionResult } from './types';
import { evaluate, isAllowed } from './safety/layer';
import { PLAYBOOKS } from './playbooks/index';
import { logger } from './observability/logger';

export interface DispatchDeps {
  adapter: PlatformAdapter;
  /** Optional: called when an action is blocked/needs-confirm, so the UI
   *  can surface the decision. Default: logs only. */
  onBlocked?: (action: PipelineAction, reason: string) => void;
}

/**
 * Execute a single PipelineAction. Never throws — all failures are returned
 * as ActionResult with success=false + errorCode.
 */
export async function dispatchAction(
  action: PipelineAction,
  deps: DispatchDeps,
): Promise<ActionResult> {
  // 1) Safety evaluate — every action, every path.
  const decision = evaluate({
    tool: action.type,
    args: actionArgs(action),
    targetLabel: (action as any).target,
  });
  if (!isAllowed(decision)) {
    const reason = decision.decision === 'block'
      ? decision.reason
      : `requires ${decision.decision}: ${decision.tier}`;
    deps.onBlocked?.(action, reason);
    logger.info('dispatch.blocked', { action: action.type, decision: decision.decision, reason });
    return {
      success: false,
      text: `[${decision.decision}] ${reason}`,
      errorCode: `safety_${decision.decision}`,
    };
  }

  // 2) Dispatch per action type.
  try {
    return await execute(action, deps.adapter);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn('dispatch.threw', { action: action.type, error: msg });
    return { success: false, text: `dispatch threw: ${msg}`, errorCode: 'dispatch_error' };
  }
}

function actionArgs(action: PipelineAction): Record<string, unknown> {
  const { type, ...rest } = action as any;
  return rest;
}

async function execute(action: PipelineAction, adapter: PlatformAdapter): Promise<ActionResult> {
  switch (action.type) {
    case 'a11y_click': {
      const res = await adapter.invokeElement({
        name: action.target,
        processId: action.processId,
        action: 'click',
      });
      return res.success
        ? { success: true, text: `a11y clicked "${action.target}"` }
        : { success: false, text: `a11y click failed for "${action.target}"`, errorCode: 'a11y_not_found' };
    }

    case 'a11y_set_value': {
      const res = await adapter.invokeElement({
        name: action.target,
        processId: action.processId,
        action: 'set-value',
        value: action.value,
      });
      return res.success
        ? { success: true, text: `set value on "${action.target}"` }
        : { success: false, text: `set value failed for "${action.target}"`, errorCode: 'a11y_not_found' };
    }

    case 'click': {
      await adapter.mouseClick(action.x, action.y, {
        button: action.button,
        count: action.count,
      });
      return { success: true, text: `clicked at (${action.x}, ${action.y})` };
    }

    case 'type': {
      await adapter.typeText(action.text);
      return { success: true, text: `typed ${action.text.length} chars` };
    }

    case 'press': {
      await adapter.keyPress(action.combo);
      return { success: true, text: `pressed ${action.combo}` };
    }

    case 'scroll': {
      // PlatformAdapter.mouseScroll needs (x,y,dir,amount); scroll from center of screen.
      const size = await adapter.getScreenSize();
      const cx = Math.floor(size.logicalWidth / 2);
      const cy = Math.floor(size.logicalHeight / 2);
      const dir = action.dir === 'up' || action.dir === 'down' ? action.dir : 'down';
      await adapter.mouseScroll(cx, cy, dir as 'up' | 'down', action.amount ?? 3);
      return { success: true, text: `scrolled ${action.dir}` };
    }

    case 'drag': {
      await adapter.mouseDrag(action.startX, action.startY, action.endX, action.endY);
      return { success: true, text: `dragged (${action.startX},${action.startY})→(${action.endX},${action.endY})` };
    }

    case 'wait': {
      await new Promise(r => setTimeout(r, action.ms));
      return { success: true, text: `waited ${action.ms}ms` };
    }

    case 'screenshot': {
      const shot = await adapter.screenshot({ maxWidth: 1280 });
      return { success: true, text: `captured ${shot.width}×${shot.height}`, data: { width: shot.width, height: shot.height } };
    }

    case 'run_playbook': {
      const pb = PLAYBOOKS[action.name];
      if (!pb) {
        return { success: false, text: `unknown playbook: ${action.name}`, errorCode: 'playbook_not_found' };
      }
      const result = await pb({ adapter, input: (action.args ?? {}) as Record<string, string> });
      return {
        success: result.success,
        text: result.text,
        data: { steps: result.steps },
      };
    }

    // Terminal actions should be handled by the caller, not dispatched. Defensive: noop success.
    case 'done':
    case 'give_up':
    case 'cannot_read':
      return { success: action.type === 'done', text: action.reason };
  }
}
