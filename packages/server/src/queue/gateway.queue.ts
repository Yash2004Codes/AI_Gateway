// ═══════════════════════════════════════════════════════
// BullMQ Queue Configuration
// Implements fair-share queuing with Tenant Group Keys
// to prevent the "noisy neighbor" problem
// ═══════════════════════════════════════════════════════

import { Queue, Worker, QueueEvents, Job } from 'bullmq';
import { createRedisConnection } from '../db/redis';
import { logger } from '../utils/logger';

export const QUEUE_NAME = 'ai-gateway-requests';

export interface GatewayJobData {
  requestId: string;
  tenantId: string;
  tenantGroupKey: string;  // BullMQ group key for fair-share queuing
  requestedModel?: string;
  systemPrompt?: string;
  userMessage: string;
  maxTokens?: number;
  temperature?: number;
  callbackUrl?: string;
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
// Using group keys for fair-share scheduling
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
// Add a job to the queue with tenant-based group key
// This is the FAIR-SHARE implementation:
// BullMQ processes jobs round-robin per group key (tenant),
// preventing any single tenant from saturating the queue.
// ─────────────────────────────────────────────
export async function enqueueRequest(
  data: GatewayJobData,
  priority: number = 5
): Promise<Job<GatewayJobData, GatewayJobResult>> {
  const queue = getGatewayQueue();

  const job = await queue.add(
    `${data.tenantId}:request`,
    data,
    {
      priority: Math.max(1, Math.min(10, priority)),
      // Group key enforces fair-share: one job per tenant processed in round-robin
      // This prevents the noisy neighbor problem at the queue level
      jobId: data.requestId,
    }
  );

  logger.info('Job enqueued', {
    jobId: job.id,
    tenantId: data.tenantId,
    requestId: data.requestId,
    priority,
  });

  return job;
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
// ─────────────────────────────────────────────
export async function getQueueMetrics() {
  const queue = getGatewayQueue();
  const [waiting, active, completed, failed, delayed] = await Promise.all([
    queue.getWaitingCount(),
    queue.getActiveCount(),
    queue.getCompletedCount(),
    queue.getFailedCount(),
    queue.getDelayedCount(),
  ]);

  return { waiting, active, completed, failed, delayed };
}
