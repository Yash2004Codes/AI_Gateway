// ═══════════════════════════════════════════════════════
// BullMQ Queue Configuration
// Jobs reach BullMQ through per-tenant fair-share lanes (see fairQueue.ts)
// to prevent the "noisy neighbor" problem
// ═══════════════════════════════════════════════════════

import { Queue, QueueEvents } from 'bullmq';
import { createRedisConnection } from '../db/redis';
import { logger } from '../utils/logger';
import { enqueueToLane, getLaneDepths, isFairShareEnabled } from './fairQueue';

export const QUEUE_NAME = 'ai-gateway-requests';

export interface GatewayJobData {
  requestId: string;
  tenantId: string;
  requestedModel?: string;
  systemPrompt?: string;
  userMessage: string;
  maxTokens?: number;
  temperature?: number;
  callbackUrl?: string;
  // Sliding-window reservation, reconciled against actual usage after completion
  rateLimitAdmittedAt?: number;
  rateLimitReservedTokens?: number;
}

export interface GatewayJobResult {
  requestId: string;
  provider: string;
  model: string;
  responseText: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  latencyMs: number;
  costUsd: number;
  providersTried: string[];
}

// ─────────────────────────────────────────────
// Queue Factory
// ─────────────────────────────────────────────
let gatewayQueue: Queue | null = null;

export function getGatewayQueue(): Queue {
  if (!gatewayQueue) {
    const connection = createRedisConnection();
    gatewayQueue = new Queue(QUEUE_NAME, {
      connection,
      defaultJobOptions: {
        attempts: parseInt(process.env.JOB_RETRY_ATTEMPTS ?? '3', 10),
        backoff: {
          type: 'exponential',
          delay: parseInt(process.env.JOB_RETRY_DELAY ?? '1000', 10),
        },
        removeOnComplete: { count: 100, age: 3600 },
        removeOnFail: { count: 200, age: 86400 },
      },
    });
    logger.info('Gateway queue initialized', { queue: QUEUE_NAME });
  }
  return gatewayQueue;
}

// ─────────────────────────────────────────────
// Enqueue a request.
// Fair-share ON  → tenant lane; the scheduler feeds BullMQ round-robin.
// Fair-share OFF → straight into BullMQ (global FIFO), kept for comparison.
// ─────────────────────────────────────────────
export async function enqueueRequest(
  data: GatewayJobData,
  priority: number = 5
): Promise<{ id: string; mode: 'fair-share' | 'fifo' }> {
  const clamped = Math.max(1, Math.min(10, priority));

  if (await isFairShareEnabled()) {
    const laneDepth = await enqueueToLane(data.tenantId, clamped, { ...data });
    logger.info('Job enqueued to tenant lane', {
      requestId: data.requestId,
      tenantId: data.tenantId,
      priority: clamped,
      laneDepth,
    });
    return { id: data.requestId, mode: 'fair-share' };
  }

  await getGatewayQueue().add(`${data.tenantId}:request`, data, {
    priority: clamped,
    jobId: data.requestId,
  });
  logger.info('Job enqueued (FIFO mode)', { requestId: data.requestId, tenantId: data.tenantId });
  return { id: data.requestId, mode: 'fifo' };
}

// ─────────────────────────────────────────────
// Queue Events (for real-time status updates)
// ─────────────────────────────────────────────
export function createQueueEvents(): QueueEvents {
  const connection = createRedisConnection();
  return new QueueEvents(QUEUE_NAME, { connection });
}

// ─────────────────────────────────────────────
// Queue metrics for dashboard
// `lanes` = jobs still waiting in fair-share lanes (not yet handed to BullMQ)
// ─────────────────────────────────────────────
export async function getQueueMetrics() {
  const queue = getGatewayQueue();
  const [waiting, active, completed, failed, delayed, laneDepths] = await Promise.all([
    queue.getWaitingCount(),
    queue.getActiveCount(),
    queue.getCompletedCount(),
    queue.getFailedCount(),
    queue.getDelayedCount(),
    getLaneDepths(),
  ]);
  const lanes = Object.values(laneDepths).reduce((a, b) => a + b, 0);

  return { lanes, waiting, active, completed, failed, delayed };
}
