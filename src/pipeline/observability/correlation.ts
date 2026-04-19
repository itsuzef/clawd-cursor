/**
 * Correlation IDs — each /task or CLI invocation generates a UUID, and every
 * log line / trace event from that task carries it. Surface in /status so
 * users can grep logs by ID for debugging.
 *
 * Uses Node's built-in AsyncLocalStorage so a correlation ID set at the top of
 * Pipeline.run() flows to every awaited call inside, without threading it
 * through every function signature.
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';

interface Context {
  correlationId: string;
  taskText?: string;
  startedAt: number;
}

const storage = new AsyncLocalStorage<Context>();

export function newCorrelationId(): string {
  return randomUUID();
}

export function runWithCorrelation<T>(
  ctx: Pick<Context, 'correlationId' | 'taskText'>,
  fn: () => Promise<T> | T,
): Promise<T> | T {
  const full: Context = {
    correlationId: ctx.correlationId,
    taskText: ctx.taskText,
    startedAt: Date.now(),
  };
  return storage.run(full, fn);
}

export function getCorrelationId(): string | undefined {
  return storage.getStore()?.correlationId;
}

export function getContext(): Context | undefined {
  return storage.getStore();
}
