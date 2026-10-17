import { Request, Response, NextFunction } from 'express';
import { publishJobUpdate } from '../db/redis';
import { checkRateLimit, WINDOW_SECONDS } from '../utils/slidingWindowLimiter';
import { AuthenticatedRequest } from './auth.middleware';
import { logger } from '../utils/logger';
import { recordRejection } from '../services/liveMetrics';

// ─────────────────────────────────────────────
// Tenant TPM + RPM Rate Limiter (sliding window via Redis Lua)
// Reserves estimated tokens up front (prompt chars / 4 + maxTokens);
// the worker gives back the unused part once actual usage is known.
// ─────────────────────────────────────────────
export async function tenantRateLimiter(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  if (!req.tenant) {
    next();
    return;
  }

  // Estimate token count from message length (rough 4 chars/token heuristic)
  const message = req.body?.userMessage ?? '';
  const systemPrompt = req.body?.systemPrompt ?? '';
  const estimatedTokens = Math.ceil((message.length + systemPrompt.length) / 4);
  const maxTokens = req.body?.maxTokens ?? 1024;
  const estimatedTotal = estimatedTokens + maxTokens;

  const result = await checkRateLimit(
    req.tenant.id,
    estimatedTotal,
    req.tenant.tpmLimit,
    req.tenant.rpmLimit
  );

  // Set rate limit headers for client visibility
  res.setHeader('X-RateLimit-Limit-Tokens', req.tenant.tpmLimit);
  res.setHeader('X-RateLimit-Remaining-Tokens', Math.max(0, req.tenant.tpmLimit - result.tpmUsed));
  res.setHeader('X-RateLimit-Limit-Requests', req.tenant.rpmLimit);
  res.setHeader('X-RateLimit-Remaining-Requests', Math.max(0, req.tenant.rpmLimit - result.rpmUsed));
  res.setHeader('X-RateLimit-Window', `${WINDOW_SECONDS}s sliding`);

  if (!result.allowed) {
    logger.warn('Rate limit exceeded', {
      tenantId: req.tenant.id,
      tenantName: req.tenant.name,
      reason: result.reason,
      tpmUsed: result.tpmUsed,
      rpmUsed: result.rpmUsed,
    });

    recordRejection(req.tenant.id).catch(() => {});
    publishJobUpdate({
      requestId: null,
      tenantId: req.tenant.id,
      tenantName: req.tenant.name,
      status: 'rate_limited',
      error: result.reason,
      timestamp: new Date().toISOString(),
    }).catch(() => {});

    res.setHeader('Retry-After', result.retryAfterSeconds);
    res.status(429).json({
      error:
        result.reason === 'RPM_EXCEEDED'
          ? 'Requests-per-minute rate limit exceeded'
          : 'Token-per-minute rate limit exceeded',
      code: result.reason,
      tpmUsed: result.tpmUsed,
      tpmLimit: req.tenant.tpmLimit,
      rpmUsed: result.rpmUsed,
      rpmLimit: req.tenant.rpmLimit,
      retryAfter: result.retryAfterSeconds,
    });
    return;
  }

  res.locals.rateLimit = { admittedAt: result.admittedAt, reservedTokens: estimatedTotal };
  next();
}

// ─────────────────────────────────────────────
// Request validation middleware
// ─────────────────────────────────────────────
export function validateGatewayRequest(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  const { userMessage, maxTokens, priority } = req.body;

  if (!userMessage || typeof userMessage !== 'string' || userMessage.trim().length === 0) {
    res.status(400).json({
      error: 'userMessage is required and must be a non-empty string',
      code: 'INVALID_REQUEST',
    });
    return;
  }

  if (userMessage.length > 100000) {
    res.status(400).json({
      error: 'userMessage exceeds maximum length of 100,000 characters',
      code: 'MESSAGE_TOO_LONG',
    });
    return;
  }

  if (maxTokens !== undefined && (!Number.isInteger(maxTokens) || maxTokens < 1 || maxTokens > 32000)) {
    res.status(400).json({ error: 'maxTokens must be an integer between 1 and 32000', code: 'INVALID_REQUEST' });
    return;
  }

  if (priority !== undefined && (!Number.isInteger(priority) || priority < 1 || priority > 10)) {
    res.status(400).json({ error: 'priority must be an integer between 1 and 10', code: 'INVALID_REQUEST' });
    return;
  }

  next();
}
