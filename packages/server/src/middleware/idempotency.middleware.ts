import { Request, Response, NextFunction } from 'express';
import { getRedis } from '../db/redis';
import { logger } from '../utils/logger';

export interface IdempotencyCachedResponse {
  status: 'COMPLETED';
  statusCode: number;
  headers: Record<string, string>;
  body: unknown;
  savedAt: string;
}

const IDEMPOTENCY_TTL_SECONDS = 86400; // 24 hours

export async function idempotencyMiddleware(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  const idempotencyKey = req.headers['idempotency-key'] as string | undefined;

  if (!idempotencyKey) {
    return next();
  }

  // Tenant ID from auth middleware or request body
  const tenantId = (req as any).tenant?.id ?? (req as any).tenantId ?? 'global';
  const redisKey = `idempotency:${tenantId}:${idempotencyKey}`;

  try {
    const redis = getRedis();

    // Atomic set with NX (Only set if not exists)
    const acquired = await redis.set(redisKey, 'IN_PROGRESS', 'EX', IDEMPOTENCY_TTL_SECONDS, 'NX');

    if (!acquired) {
      // Key already exists!
      const existingValue = await redis.get(redisKey);

      if (existingValue === 'IN_PROGRESS') {
        logger.warn('Idempotency conflict: Concurrent request detected', { tenantId, idempotencyKey });
        res.status(409).json({
          error: 'Idempotency Conflict',
          message: 'A request with this Idempotency-Key is currently being processed.',
          idempotencyKey,
        });
        return;
      }

      if (existingValue) {
        try {
          const cached: IdempotencyCachedResponse = JSON.parse(existingValue);
          logger.info('Idempotency HIT: Returning cached response', { tenantId, idempotencyKey });

          res.setHeader('X-Cache-Lookup', 'HIT (Idempotent)');
          res.setHeader('X-Idempotency-Key', idempotencyKey);
          res.status(cached.statusCode).json(cached.body);
          return;
        } catch {
          // Invalid cached payload, allow re-execution
        }
      }
    }

    // Key acquired! Intercept res.json to cache the completed response payload
    const originalJson = res.json.bind(res);

    res.json = (body: any): Response => {
      // Only cache successful/completed responses (2xx / 202)
      if (res.statusCode >= 200 && res.statusCode < 300) {
        const payloadToCache: IdempotencyCachedResponse = {
          status: 'COMPLETED',
          statusCode: res.statusCode,
          headers: { 'content-type': 'application/json' },
          body,
          savedAt: new Date().toISOString(),
        };

        redis
          .set(redisKey, JSON.stringify(payloadToCache), 'EX', IDEMPOTENCY_TTL_SECONDS)
          .catch((err) => {
            logger.error('Failed to save idempotency cache in Redis', { error: err.message, idempotencyKey });
          });
      } else {
        // Remove key on server failure so client can retry
        redis.del(redisKey).catch(() => {});
      }

      return originalJson(body);
    };

    next();
  } catch (err) {
    logger.error('Idempotency middleware error', { error: (err as Error).message });
    next();
  }
}
