// ═══════════════════════════════════════════════════════
// Gateway Routes - Main ingestion endpoint
// POST /api/v1/gateway/completions
// Returns 202 Accepted immediately, processes async
// ═══════════════════════════════════════════════════════

import { Router, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { AuthenticatedRequest, apiKeyAuth } from '../middleware/auth.middleware';
import { tenantRateLimiter, validateGatewayRequest } from '../middleware/ratelimit.middleware';
import { getIdempotencyKey, setIdempotencyKey } from '../db/redis';
import { query, queryOne } from '../db/pool';
import { enqueueRequest } from '../queue/gateway.queue';
import { idempotencyMiddleware } from '../middleware/idempotency.middleware';

const router = Router();
router.use(idempotencyMiddleware);

// ─────────────────────────────────────────────
// POST /api/v1/gateway/completions
// Main ingestion endpoint - accepts requests and queues them
// ─────────────────────────────────────────────
router.post(
  '/completions',
  apiKeyAuth,
  tenantRateLimiter,
  validateGatewayRequest,
  async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const tenant = req.tenant!;
    const {
      userMessage,
      systemPrompt,
      requestedModel,
      maxTokens = 1024,
      temperature = 0.7,
      idempotencyKey,
      callbackUrl,
      priority = 5,
    } = req.body;

    // ── Idempotency Check ──────────────────────────────
    if (idempotencyKey) {
      const existing = await getIdempotencyKey(idempotencyKey);
      if (existing) {
        const existingRequest = JSON.parse(existing);
        logger.info('Idempotent request - returning cached response', {
          idempotencyKey,
          requestId: existingRequest.requestId,
        });
        res.status(200).json({
          ...existingRequest,
          idempotent: true,
          message: 'Returning cached response for idempotency key',
        });
        return;
      }
    }

    // ── Create request record in PostgreSQL ────────────
    const requestId = uuidv4();

    await query(
      `INSERT INTO gateway_requests
         (id, tenant_id, idempotency_key, status, requested_model,
          system_prompt, user_message, max_tokens, priority, queued_at)
       VALUES ($1, $2, $3, 'queued', $4, $5, $6, $7, $8, NOW())`,
      [
        requestId,
        tenant.id,
        idempotencyKey ?? null,
        requestedModel ?? null,
        systemPrompt ?? null,
        userMessage,
        maxTokens,
        priority,
      ]
    );

    // ── Enqueue to BullMQ with tenant group key ────────
    const job = await enqueueRequest(
      {
        requestId,
        tenantId: tenant.id,
        tenantGroupKey: tenant.id,  // Fair-share: round-robin per tenant
        requestedModel,
        systemPrompt,
        userMessage,
        maxTokens,
        temperature,
        callbackUrl,
      },
      priority
    );

    // Update record with job ID
    await query(
      'UPDATE gateway_requests SET job_id = $1 WHERE id = $2',
      [job.id, requestId]
    );

    // Cache idempotency key if provided
    if (idempotencyKey) {
      await setIdempotencyKey(
        idempotencyKey,
        JSON.stringify({ requestId, jobId: job.id, status: 'queued' }),
        86400
      );
    }

    logger.info('Request accepted and queued', {
      requestId,
      jobId: job.id,
      tenantId: tenant.id,
      priority,
    });

    // ── Return 202 Accepted immediately ───────────────
    res.status(202).json({
      requestId,
      jobId: job.id,
      status: 'queued',
      message: 'Request accepted and queued for processing',
      statusUrl: `/api/v1/gateway/requests/${requestId}`,
      estimatedWaitMs: 2000,
    });
  }
);

// ─────────────────────────────────────────────
// GET /api/v1/gateway/requests/:requestId
// Poll for job status and results
// ─────────────────────────────────────────────
router.get(
  '/requests/:requestId',
  apiKeyAuth,
  async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const { requestId } = req.params;
    const tenant = req.tenant!;

    const request = await queryOne<{
      id: string;
      tenant_id: string;
      status: string;
      provider_used: string | null;
      model_used: string | null;
      response_text: string | null;
      prompt_tokens: number;
      completion_tokens: number;
      total_tokens: number;
      estimated_cost_usd: number;
      providers_tried: unknown[];
      total_latency_ms: number | null;
      error_code: string | null;
      error_message: string | null;
      created_at: string;
      completed_at: string | null;
    }>(
      `SELECT id, tenant_id, status, provider_used, model_used, response_text,
              prompt_tokens, completion_tokens, total_tokens, estimated_cost_usd,
              providers_tried, total_latency_ms, error_code, error_message,
              created_at, completed_at
       FROM gateway_requests
       WHERE id = $1 AND tenant_id = $2`,
      [requestId, tenant.id]
    );

    if (!request) {
      res.status(404).json({ error: 'Request not found' });
      return;
    }

    res.json(request);
  }
);

// ─────────────────────────────────────────────
// GET /api/v1/gateway/requests
// List tenant's requests with pagination
// ─────────────────────────────────────────────
router.get(
  '/requests',
  apiKeyAuth,
  async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const tenant = req.tenant!;
    const page = parseInt(req.query.page as string ?? '1', 10);
    const limit = Math.min(parseInt(req.query.limit as string ?? '20', 10), 100);
    const offset = (page - 1) * limit;
    const status = req.query.status as string | undefined;

    const statusFilter = status ? 'AND status = $3' : '';
    const params: unknown[] = [tenant.id, limit, ...(status ? [status] : [])];

    const requests = await query(
      `SELECT id, status, provider_used, model_used, total_tokens,
              estimated_cost_usd, total_latency_ms, created_at, completed_at
       FROM gateway_requests
       WHERE tenant_id = $1 ${statusFilter}
       ORDER BY created_at DESC
       LIMIT $2 OFFSET ${offset}`,
      params
    );

    res.json({ requests, page, limit });
  }
);

export default router;
