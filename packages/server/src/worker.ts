// ═══════════════════════════════════════════════════════
// Worker Entry Point
// Runs independently of the API server
// Can be horizontally scaled
// ═══════════════════════════════════════════════════════

import 'dotenv/config';
import { startWorker } from './queue/gateway.worker';
import { getGatewayQueue } from './queue/gateway.queue';
import { startFairScheduler } from './queue/fairQueue';
import { batchLogger } from './db/batchLogger';
import { getRedis } from './db/redis';
import { getPool } from './db/pool';
import { logger } from './utils/logger';

async function main() {
  logger.info('Starting AI Gateway Worker...');

  // Ensure DB and Redis connections are alive
  try {
    const pool = getPool();
    await pool.query('SELECT 1');
    logger.info('Worker: PostgreSQL connected');

    const redis = getRedis();
    await redis.ping();
    logger.info('Worker: Redis connected');
  } catch (err) {
    logger.error('Worker: Failed to connect to dependencies', { error: (err as Error).message });
    process.exit(1);
  }

  const worker = startWorker();

  // Feed BullMQ round-robin from the tenant lanes. A small buffer keeps
  // ordering decided by the scheduler, not by arrival time. Every worker
  // replica runs one; pops are atomic, so they cooperate safely.
  const concurrency = parseInt(process.env.WORKER_CONCURRENCY ?? '5', 10);
  const bufferSize = parseInt(process.env.FAIR_SHARE_BUFFER ?? String(concurrency), 10);
  const stopScheduler = startFairScheduler(getGatewayQueue(), bufferSize);

  // Graceful shutdown
  const shutdown = async (signal: string) => {
    logger.info(`Worker: ${signal} received - closing gracefully`);
    stopScheduler();
    await worker.close();
    await batchLogger.flushAllSync();
    process.exit(0);
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  logger.info('🔧 Worker is ready and listening for jobs');
}

main();
