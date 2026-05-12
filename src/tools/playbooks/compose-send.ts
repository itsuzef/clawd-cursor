/**
 * compose-send playbook.
 *
 * App-agnostic keyboard choreography for "fill a compose form and submit":
 *   1. open a new compose window (mod+n is the cross-app convention)
 *   2. type the To value (the first field auto-focuses on every mail client)
 *   3. Tab past optional Cc/Bcc rows (extra Tabs are harmless on apps that
 *      don't have those rows)
 *   4. type the Subject
 *   5. Tab to the body
 *   6. type the Body
 *   7. mod+Return to submit (mod+Return is the cross-app send shortcut on
 *      every modern mail client: Outlook, Apple Mail, Thunderbird, Spark,
 *      Gmail web, etc.)
 *
 * Naming: this is named for the CAPABILITY, not for any specific app. The
 * same choreography works for any "compose with To/Subject/Body fields and
 * submit on mod+Return" form. The first-class path for email is
 * open_uri(mailto: ...) \u2014 use this playbook only when:
 *   - the user explicitly wants to compose inside the app's native UI, OR
 *   - the URI handler is broken / not registered on the user's machine.
 *
 * Zero app-specific branches. Zero title-bar matching.
 */

import type { PlaybookArgs, PlaybookResult } from './index';

const COMPOSE_MOUNT_WAIT_MS = 1_000;
const POST_SUBMIT_WAIT_MS = 400;

export async function composeSend(args: PlaybookArgs): Promise<PlaybookResult> {
  const { adapter, input } = args;
  const to      = input.to ?? input.recipient ?? '';
  const subject = input.subject ?? '';
  const body    = input.body ?? input.text ?? '';
  const steps: PlaybookResult['steps'] = [];

  // 1) New compose window. mod+n is the cross-app convention.
  await adapter.keyPress('mod+n');
  steps.push({ type: 'key', key: 'mod+n', description: 'new compose window' });
  await sleep(COMPOSE_MOUNT_WAIT_MS);
  steps.push({ type: 'wait', description: `wait ${COMPOSE_MOUNT_WAIT_MS}ms for compose to mount` });

  // 2) Recipient — first field auto-focuses on every mail compose UI.
  if (to) {
    await adapter.typeText(to);
    steps.push({ type: 'type', description: `typed recipient: ${to}` });
    // Two Tabs: advance past the recipient row, then past any Cc/Bcc row.
    // Extra Tabs are harmless on apps without Cc/Bcc visible by default.
    await adapter.keyPress('Tab');
    steps.push({ type: 'key', key: 'Tab', description: 'advance past recipient' });
    await adapter.keyPress('Tab');
    steps.push({ type: 'key', key: 'Tab', description: 'advance past any Cc/Bcc' });
  }

  // 3) Subject
  if (subject) {
    await adapter.typeText(subject);
    steps.push({ type: 'type', description: `typed subject: ${subject}` });
    await adapter.keyPress('Tab');
    steps.push({ type: 'key', key: 'Tab', description: 'advance to body' });
  }

  // 4) Body
  if (body) {
    await adapter.typeText(body);
    steps.push({ type: 'type', description: `typed body (${body.length} chars)` });
  }

  // 5) Submit. mod+Return is the cross-app send shortcut on every modern
  // mail client. We attempt it once and let the verifier decide success.
  await adapter.keyPress('mod+Return');
  steps.push({ type: 'key', key: 'mod+Return', description: 'submit (mod+Return)' });
  await sleep(POST_SUBMIT_WAIT_MS);

  return {
    success: true,
    text: `compose-send: to=${to || '(none)'} subject=${subject.slice(0, 40)}`,
    steps,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}
