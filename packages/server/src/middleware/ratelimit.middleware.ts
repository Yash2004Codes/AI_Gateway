import { Request, Response, NextFunction } from 'express';
import { checkTpmLimit } from '../db/redis';
import { AuthenticatedRequest } from './auth.middleware';
import { logger } from '../utils/logger';

// ─────────────────────────────────────────────
// Tenant TPM Rate Limiter (Sliding Window via Redis)
// Estimates tokens from message length before processing
// to enforce pre-flight limits
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

  const { allowed, current, limit } = await checkTpmLimit(
    req.tenant.id,
    estimatedTotal,
    req.tenant.tpmLimit
  );

  // Set rate limit headers for client visibility
  res.setHeader('X-RateLimit-Limit', limit);
  res.setHeader('X-RateLimit-Remaining', Math.max(0, limit - current));
  res.setHeader('X-RateLimit-Reset', Math.ceil(Date.now() / 60000) * 60);

  if (!allowed) {
    logger.warn('TPM rate limit exceeded', {
      tenantId: req.tenant.id,
      tenantName: req.tenant.name,
      current,
      limit,
    });
    res.status(429).json({
      error: 'Token-per-minute rate limit exceeded',
      code: 'TPM_EXCEEDED',
      current,
      limit,
      retryAfter: 60,
    });
    return;
  }

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
  const { userMessage } = req.body;

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

  next();
}
