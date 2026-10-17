import Redis from 'ioredis';
import { logger } from '../utils/logger';

let redisClient: Redis | null = null;

export function getRedis(): Redis {
  if (!redisClient) {
    redisClient = new Redis(process.env.REDIS_URL || 'redis://localhost:6379', {
      maxRetriesPerRequest: null,
      enableReadyCheck: false,
      lazyConnect: false,
    });

    redisClient.on('connect', () => logger.info('Redis connected'));
    redisClient.on('error', (err) => logger.error('Redis error', { error: err.message }));
    redisClient.on('reconnecting', () => logger.warn('Redis reconnecting...'));
  }
  return redisClient;
}

export function createRedisConnection(): Redis {
  return new Redis(process.env.REDIS_URL || 'redis://localhost:6379', {
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
  });
}

export async function closeRedis(): Promise<void> {
  if (redisClient) {
    await redisClient.quit();
    redisClient = null;
    logger.info('Redis connection closed');
  }
}

/**
 * Publish a provider health event for real-time UI updates
 */
export async function publishProviderHealth(data: Record<string, unknown>): Promise<void> {
  await getRedis().publish('provider:health', JSON.stringify(data));
}

/**
 * Publish a job status update for real-time UI updates
 */
export async function publishJobUpdate(data: Record<string, unknown>): Promise<void> {
  await getRedis().publish('job:updates', JSON.stringify(data));
}

/**
 * Cache metrics data with short TTL
 */
export async function cacheMetrics(key: string, data: unknown, ttl: number = 30): Promise<void> {
  await getRedis().setex(`metrics:${key}`, ttl, JSON.stringify(data));
}

export async function getCachedMetrics<T>(key: string): Promise<T | null> {
  const data = await getRedis().get(`metrics:${key}`);
  return data ? (JSON.parse(data) as T) : null;
}
