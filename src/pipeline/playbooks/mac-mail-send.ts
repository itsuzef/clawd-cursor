/**
 * Mac Mail.app send playbook.
 *
 * Ported from src/deterministic-flows.ts. Mac Mail is SIMPLER than Outlook —
 * the To field auto-focuses, Tab order is predictable (To → Subject → Body),
 * primary send is Cmd+Shift+D. Cmd+Return is a fallback.
 */

import type { PlaybookArgs, PlaybookResult } from './index';

export async function macMailSend(args: PlaybookArgs): Promise<PlaybookResult> {
  const { adapter, input } = args;
  const to      = input.to ?? input.recipient ?? '';
  const subject = input.subject ?? '';
  const body    = input.body ?? input.text ?? '';
  const steps: PlaybookResult['steps'] = [];

  // 1) New message
  await adapter.keyPress('mod+n');
  steps.push({ type: 'key', key: 'mod+n', description: 'new Mail message' });
  await sleep(600);
  steps.push({ type: 'wait', description: 'wait 600ms for compose' });

  // 2) To
  if (to) {
    await adapter.typeText(to);
    steps.push({ type: 'type', description: `typed To: ${to}` });
    await adapter.keyPress('Tab');
    steps.push({ type: 'key', key: 'Tab', description: 'advance to Subject' });
  }

  // 3) Subject
  if (subject) {
    await adapter.typeText(subject);
    steps.push({ type: 'type', description: `typed Subject: ${subject}` });
    await adapter.keyPress('Tab');
    steps.push({ type: 'key', key: 'Tab', description: 'advance to body' });
  }

  // 4) Body
  if (body) {
    await adapter.typeText(body);
    steps.push({ type: 'type', description: `typed body (${body.length} chars)` });
  }

  // 5) Primary send — Cmd+Shift+D on macOS Mail.app.
  await adapter.keyPress('mod+shift+d');
  steps.push({ type: 'key', key: 'mod+shift+d', description: 'Cmd+Shift+D primary send' });
  await sleep(400);

  // Fallback — Cmd+Return.
  const active = await adapter.getActiveWindow();
  if (active && /new message|untitled|mail/i.test(active.title)) {
    await adapter.keyPress('mod+Return');
    steps.push({ type: 'key', key: 'mod+Return', description: 'Cmd+Return fallback' });
    await sleep(400);
  }

  return {
    success: true,
    text: `mac-mail-send: To=${to}, Subject=${subject.slice(0, 40)}`,
    steps,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}
