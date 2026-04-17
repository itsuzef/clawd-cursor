/**
 * Unified Pipeline (v0.8.1) — "Universal Smart Pipeline" restored from v0.6.3
 * on top of v0.8.0's V2 infrastructure.
 *
 * Layer order (per plan §4.2):
 *   preprocess → classify → router → decompose →
 *     skill-cache → knowledge → sense → text-agent →
 *     vision-agent (fallback) → verifier → retry (verifier-reject)
 *
 * Model-agnostic: per-layer models come from src/providers.ts PROVIDERS
 * registry, overrideable via AI_TEXT_MODEL / AI_VISION_MODEL / AI_RETRY_MODEL.
 *
 * v0.8.1 scaffold: this Pipeline class is a shim that delegates to the existing
 * V2 orchestrator while the per-layer modules are ported in. Each port lands
 * behind a feature flag, then becomes default in subsequent commits. By the
 * time --legacy is removed in v0.8.2, every layer is native to this module.
 */

import {
  newCorrelationId,
  runWithCorrelation,
} from './observability/correlation';
import { CostMeter } from './observability/cost-meter';
import { logger } from './observability/logger';
import type { TaskResult } from './types';

export interface PipelineDeps {
  /** Existing V2 orchestrator, used as the initial delegate until layers are ported. */
  v2?: {
    run: (input: { task: string; isAborted?: () => boolean }) => Promise<{
      success: boolean;
      text: string;
      [k: string]: unknown;
    }>;
  };
  /** Whether to enable the retry-tier-up path on verifier reject. */
  retry?: { useFallback: boolean; maxPerSession: number };
  /** Whether to disable the vision-agent entirely (a11y-only security mode). */
  disableVision?: boolean;
}

export interface PipelineRunInput {
  task: string;
  isAborted?: () => boolean;
}

export class Pipeline {
  private retriesThisSession = 0;

  constructor(private readonly deps: PipelineDeps) {}

  async run(input: PipelineRunInput): Promise<TaskResult> {
    const correlationId = newCorrelationId();
    const startedAt = Date.now();
    const costMeter = new CostMeter();
    const log = logger.with({ correlationId, task: input.task });

    return runWithCorrelation({ correlationId, taskText: input.task }, async () => {
      log.info('pipeline.start');

      // v0.8.1 scaffold: delegate to V2 while layers are being ported.
      // Each subsequent commit replaces a slice of this delegation with a
      // native pipeline step.
      if (!this.deps.v2) {
        log.error('pipeline.no_delegate', { note: 'V2 unavailable; pipeline requires delegate during port window' });
        return {
          success: false,
          path: 'router',
          costUsd: 0,
          durationMs: Date.now() - startedAt,
          correlationId,
          trace: [],
          text: 'pipeline unavailable: no delegate configured',
        };
      }

      try {
        const v2Result = await this.deps.v2.run({
          task: input.task,
          isAborted: input.isAborted,
        });
        const cost = costMeter.snapshot();
        log.info('pipeline.done', { success: v2Result.success, costUsd: cost.totalUsd });
        return {
          success: Boolean(v2Result.success),
          path: 'vision-agent', // V2 is vision-first today; will be overridden as layers port
          costUsd: cost.totalUsd,
          durationMs: Date.now() - startedAt,
          correlationId,
          trace: [],
          text: String(v2Result.text ?? ''),
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log.error('pipeline.failed', { error: msg });
        return {
          success: false,
          path: 'router',
          costUsd: costMeter.snapshot().totalUsd,
          durationMs: Date.now() - startedAt,
          correlationId,
          trace: [],
          text: `pipeline failed: ${msg}`,
        };
      }
    });
  }

  /** Reset per-session counters. Call at the start of a fresh agent session. */
  resetSession(): void {
    this.retriesThisSession = 0;
  }
}

export type { TaskResult } from './types';
