/**
 * Outlook send playbook (Windows).
 *
 * Ported from src/deterministic-flows.ts. The choreography is the product
 * knowledge — Outlook's compose mounting can be slow, Tab order includes
 * Cc/Bcc in some builds, mod+Return is primary send, Alt+S is the fallback.
 */

import type { PlaybookArgs, PlaybookResult } from './index';

const PRE_MOUNT_WAIT_MS = 1_200;
const POST_SEND_WAIT_MS = 400;

export async function outlookSend(args: PlaybookArgs): Promise<PlaybookResult> {
  const { adapter, input } = args;
  const to      = input.to ?? input.recipient ?? '';
  const subject = input.subject ?? '';
  const body    = input.body ?? input.text ?? '';
  const steps: PlaybookResult['steps'] = [];

  // 1) New message (Ctrl+N on Windows, Cmd+N on mac-equivalent Outlook).
  await adapter.keyPress('mod+n');
  steps.push({ type: 'key', key: 'mod+n', description: 'new Outlook message' });

  // 2) Wait for compose to mount — Outlook's Electron shell is slow.
  await sleep(PRE_MOUNT_WAIT_MS);
  steps.push({ type: 'wait', description: `wait ${PRE_MOUNT_WAIT_MS}ms for compose` });

  // 3) To field is auto-focused. Type recipient, Tab to advance.
  if (to) {
    await adapter.typeText(to);
    steps.push({ type: 'type', description: `typed To: ${to}` });
    await adapter.keyPress('Tab');
    steps.push({ type: 'key', key: 'Tab', description: 'advance past To' });

    // Some Outlook builds park the Cc/Bcc row between To and Subject — advance
    // a second Tab to land on Subject. Harmless if Subject is next directly.
    await adapter.keyPress('Tab');
    steps.push({ type: 'key', key: 'Tab', description: 'advance past Cc/Bcc' });
  }

  // 4) Subject
  if (subject) {
    await adapter.typeText(subject);
    steps.push({ type: 'type', description: `typed Subject: ${subject}` });
    await adapter.keyPress('Tab');
    steps.push({ type: 'key', key: 'Tab', description: 'advance to body' });
  }

  // 5) Body
  if (body) {
    await adapter.typeText(body);
    steps.push({ type: 'type', description: `typed body (${body.length} chars)` });
  }

  // 6) Send — mod+Return primary.
  await adapter.keyPress('mod+Return');
  steps.push({ type: 'key', key: 'mod+Return', description: 'primary send' });
  await sleep(POST_SEND_WAIT_MS);

  // 7) Verify window closed. If not, Alt+S fallback. Verifier decides success —
  // we just do our best.
  const active = await adapter.getActiveWindow();
  if (active && /outlook|olk|new message|untitled/i.test(active.title)) {
    await adapter.keyPress('alt+s');
    steps.push({ type: 'key', key: 'alt+s', description: 'alt+s send fallback' });
    await sleep(POST_SEND_WAIT_MS);
  }

  return {
    success: true,
    text: `outlook-send: To=${to}, Subject=${subject.slice(0, 40)}`,
    steps,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}
