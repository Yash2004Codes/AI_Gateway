// ═══════════════════════════════════════════════════════
// Worker Entry Point
// Runs independently of the API server
// Can be horizontally scaled
// ═══════════════════════════════════════════════════════

import 'dotenv/config';
import { startWorker } from './queue/gateway.worker';
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

  // Graceful shutdown
  const shutdown = async (signal: string) => {
    logger.info(`Worker: ${signal} received - closing gracefully`);
    await worker.close();
    process.exit(0);
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  logger.info('🔧 Worker is ready and listening for jobs');
}

main();
