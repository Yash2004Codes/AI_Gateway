// ═══════════════════════════════════════════════════════
// BullMQ Worker - Background Job Processor
// Handles: LLM dispatch, failover, DB writes, callbacks
// ═══════════════════════════════════════════════════════

import 'dotenv/config';
import { Worker, Job } from 'bullmq';
import { createRedisConnection, publishJobUpdate } from '../db/redis';
import { query } from '../db/pool';
import { dispatchToProvider } from '../providers/dispatcher';
import { logger } from '../utils/logger';
import { batchLogger } from '../db/batchLogger';
import { QUEUE_NAME, GatewayJobData, GatewayJobResult } from './gateway.queue';
import { reconcileTokens } from '../utils/slidingWindowLimiter';

async function releaseReservation(data: GatewayJobData, actualTokens: number): Promise<void> {
  if (data.rateLimitAdmittedAt === undefined || data.rateLimitReservedTokens === undefined) return;
  try {
    await reconcileTokens(data.tenantId, data.rateLimitAdmittedAt, data.rateLimitReservedTokens, actualTokens);
  } catch (err) {
    logger.warn('Token reservation reconcile failed', { error: (err as Error).message });
  }
}

// ─────────────────────────────────────────────
// Update request status in PostgreSQL
// ─────────────────────────────────────────────
async function updateRequestStatus(
  requestId: string,
  status: string,
  data: Record<string, unknown> = {}
): Promise<void> {
  const setClause: string[] = ['status = $2', 'updated_at = NOW()'];
  const values: unknown[] = [requestId, status];
  let paramIdx = 3;

  for (const [key, value] of Object.entries(data)) {
    setClause.push(`${key} = $${paramIdx}`);
    values.push(value);
    paramIdx++;
  }

  await query(
    `UPDATE gateway_requests SET ${setClause.join(', ')} WHERE id = $1`,
    values
  );
}

// ─────────────────────────────────────────────
// Write token usage to audit ledger
// ─────────────────────────────────────────────

async function writeTokenLedger(
  requestId: string,
  tenantId: string,
  result: GatewayJobResult
): Promise<void> {
  await batchLogger.logTokenUsage({
    requestId,
    tenantId,
    provider: result.provider,
    model: result.model,
    promptTokens: result.promptTokens,
    completionTokens: result.completionTokens,
    totalTokens: result.totalTokens,
    costUsd: result.costUsd,
  });
}

// ─────────────────────────────────────────────
// SSRF-safe callback delivery
// Only sends to publicly routable URLs
// ─────────────────────────────────────────────
import { sendSSRFSafeWebhook } from '../utils/ssrfSafeWebhook';

async function deliverCallback(callbackUrl: string, payload: unknown): Promise<void> {
  try {
    const response = await sendSSRFSafeWebhook({
      url: callbackUrl,
      method: 'POST',
      body: payload,
      timeoutMs: 10000,
    });
    logger.info('Callback delivered', { callbackUrl, statusCode: response.statusCode });
  } catch (err: any) {
    logger.error('SSRF / Callback delivery failed', { callbackUrl, error: err.message });
  }
}

// ─────────────────────────────────────────────
// Main Job Processor
// ─────────────────────────────────────────────
async function processGatewayJob(
  job: Job<GatewayJobData, GatewayJobResult>
): Promise<GatewayJobResult> {
  const { requestId, tenantId, requestedModel, systemPrompt, userMessage, maxTokens, temperature, callbackUrl } =
    job.data;

  logger.info('Processing job', { jobId: job.id, requestId, tenantId, attemptsMade: job.attemptsMade });

  // Mark as processing
  await updateRequestStatus(requestId, 'processing', {
    processing_started_at: new Date().toISOString(),
    attempt_count: job.attemptsMade + 1,
  });

  // Publish real-time update
  await publishJobUpdate({
    requestId,
    tenantId,
    status: 'processing',
    jobId: job.id,
    timestamp: new Date().toISOString(),
  });

  await job.updateProgress(10);

  let result: GatewayJobResult;
  try {
    // Dispatch to provider with automatic failover
    const dispatchResult = await dispatchToProvider(requestedModel, {
      systemPrompt,
      userMessage,
      maxTokens,
      temperature,
    }, tenantId);

    result = {
      requestId,
      provider: dispatchResult.provider,
      model: dispatchResult.model,
      responseText: dispatchResult.responseText,
      promptTokens: dispatchResult.promptTokens,
      completionTokens: dispatchResult.completionTokens,
      totalTokens: dispatchResult.totalTokens,
      latencyMs: dispatchResult.latencyMs,
      costUsd: dispatchResult.costUsd,
      providersTried: dispatchResult.providersTried,
    };
  } catch (dispatchError: any) {
    // All providers failed. Only mark the request failed on the final attempt;
    // earlier attempts go back to 'queued' because BullMQ will retry them.
    const isFinalAttempt = job.attemptsMade + 1 >= (job.opts.attempts ?? 1);
    if (!isFinalAttempt) {
      await updateRequestStatus(requestId, 'queued', {
        error_message: dispatchError.message,
      });
      throw dispatchError;
    }

    await updateRequestStatus(requestId, 'failed', {
      error_code: 'ALL_PROVIDERS_FAILED',
      error_message: dispatchError.message,
      completed_at: new Date().toISOString(),
    });

    // Nothing was consumed: release the whole reservation back to the window
    await releaseReservation(job.data, 0);

    await publishJobUpdate({
      requestId,
      tenantId,
      status: 'failed',
      error: dispatchError.message,
      timestamp: new Date().toISOString(),
    });

    throw dispatchError;
  }

  await job.updateProgress(80);

  // Write results to DB
  await updateRequestStatus(requestId, 'completed', {
    provider_used: result.provider,
    model_used: result.model,
    response_text: result.responseText,
    prompt_tokens: result.promptTokens,
    completion_tokens: result.completionTokens,
    total_tokens: result.totalTokens,
    estimated_cost_usd: result.costUsd,
    providers_tried: JSON.stringify(result.providersTried),
    completed_at: new Date().toISOString(),
  });
  // End-to-end latency as the client experiences it: queue wait + provider time
  await query(
    `UPDATE gateway_requests
     SET total_latency_ms = (EXTRACT(EPOCH FROM (completed_at - queued_at)) * 1000)::int
     WHERE id = $1`,
    [requestId]
  );

  // Write to token ledger
  await writeTokenLedger(requestId, tenantId, result);

  // Swap the up-front estimate for the real token count in the sliding window
  await releaseReservation(job.data, result.totalTokens);

  await job.updateProgress(95);

  // Publish completion event
  await publishJobUpdate({
    requestId,
    tenantId,
    status: 'completed',
    provider: result.provider,
    model: result.model,
    totalTokens: result.totalTokens,
    latencyMs: result.latencyMs,
    costUsd: result.costUsd,
    providersTried: result.providersTried,
    timestamp: new Date().toISOString(),
  });

  // Deliver callback if provided (SSRF-protected)
  if (callbackUrl) {
    await deliverCallback(callbackUrl, {
      requestId,
      status: 'completed',
      result: {
        provider: result.provider,
        model: result.model,
        responseText: result.responseText,
        tokens: result.totalTokens,
        costUsd: result.costUsd,
      },
    });
  }

  await job.updateProgress(100);
  logger.info('Job completed successfully', {
    jobId: job.id,
    requestId,
    provider: result.provider,
    model: result.model,
    tokens: result.totalTokens,
    costUsd: result.costUsd,
  });

  return result;
}

// ─────────────────────────────────────────────
// Worker Initialization
// ─────────────────────────────────────────────
export function startWorker(): Worker<GatewayJobData, GatewayJobResult> {
  const connection = createRedisConnection();
  const concurrency = parseInt(process.env.WORKER_CONCURRENCY ?? '5', 10);

  const worker = new Worker<GatewayJobData, GatewayJobResult>(
    QUEUE_NAME,
    processGatewayJob,
    {
      connection,
      concurrency,
      // Stalled job detection - marks as failed if silent for 60s
      stalledInterval: 60000,
      maxStalledCount: 2,
    }
  );

  worker.on('completed', (job, result) => {
    logger.info('Worker: Job completed', { jobId: job.id, requestId: result.requestId });
  });

  worker.on('failed', (job, err) => {
    logger.error('Worker: Job failed', {
      jobId: job?.id,
      error: err.message,
      attemptsMade: job?.attemptsMade,
    });
  });

  worker.on('stalled', (jobId) => {
    logger.warn('Worker: Job stalled', { jobId });
  });

  worker.on('error', (err) => {
    logger.error('Worker error', { error: err.message });
  });

  logger.info('BullMQ Worker started', { queue: QUEUE_NAME, concurrency });
  return worker;
}
