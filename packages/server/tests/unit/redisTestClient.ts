// Real Redis (DB 15) for tests that exercise Lua scripts.
// Requires: docker compose up -d redis
import Redis from 'ioredis';

export const TEST_REDIS_URL = process.env.TEST_REDIS_URL ?? 'redis://localhost:6379/15';

export function createTestRedis(): Redis {
  return new Redis(TEST_REDIS_URL, { maxRetriesPerRequest: 1 });
}
