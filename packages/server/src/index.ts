// ═══════════════════════════════════════════════════════
// AI Gateway - Main Server Entry Point
// ═══════════════════════════════════════════════════════

import 'dotenv/config';
import express from 'express';
import 'express-async-errors'; // route rejections reach the error handler instead of hanging
import http from 'http';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import { getPool } from './db/pool';
import { getRedis } from './db/redis';
import { initializeSocketIO } from './socket/socket.server';
import gatewayRoutes from './routes/gateway.routes';
import adminRoutes from './routes/admin.routes';
import { logger } from './utils/logger';

const app = express();
const httpServer = http.createServer(app);
const PORT = parseInt(process.env.PORT ?? '3001', 10);

// ── Middleware ──────────────────────────────────────────
app.use(helmet({
  crossOriginResourcePolicy: { policy: 'cross-origin' },
}));

app.use(cors({
  origin: process.env.CLIENT_URL ?? 'http://localhost:3000',
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
}));

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(morgan('combined', {
  stream: { write: (msg) => logger.http(msg.trim()) },
}));

// ── Health Check ───────────────────────────────────────
app.get('/health', async (_req, res) => {
  try {
    const pool = getPool();
    await pool.query('SELECT 1');
    const redis = getRedis();
    await redis.ping();

    res.json({
      status: 'healthy',
      timestamp: new Date().toISOString(),
      services: { postgres: 'up', redis: 'up' },
      version: '1.0.0',
    });
  } catch (err) {
    res.status(503).json({
      status: 'unhealthy',
      error: (err as Error).message,
      timestamp: new Date().toISOString(),
    });
  }
});

// ── Routes ─────────────────────────────────────────────
app.use('/api/v1/gateway', gatewayRoutes);
app.use('/api/v1/admin', adminRoutes);

// ── 404 Handler ───────────────────────────────────────
app.use((req, res) => {
  res.status(404).json({ error: 'Route not found', path: req.path });
});

// ── Error Handler ─────────────────────────────────────
app.use((err: Error, req: express.Request, res: express.Response, _next: express.NextFunction) => {
  logger.error('Unhandled error', { error: err.message, stack: err.stack, path: req.path });
  res.status(500).json({ error: 'Internal server error' });
});

// ── Initialize Socket.IO ───────────────────────────────
initializeSocketIO(httpServer);

// ── Start Server ───────────────────────────────────────
async function start() {
  try {
    // Test DB connection
    const pool = getPool();
    await pool.query('SELECT 1');
    logger.info('PostgreSQL connected');

    // Test Redis connection
    const redis = getRedis();
    await redis.ping();
    logger.info('Redis connected');

    httpServer.listen(PORT, () => {
      logger.info(`🚀 AI Gateway API running on port ${PORT}`);
      logger.info(`📊 Admin Dashboard API: http://localhost:${PORT}/api/v1/admin`);
      logger.info(`🔌 WebSocket server ready`);
      logger.info(`❤️  Health check: http://localhost:${PORT}/health`);
    });
  } catch (err) {
    logger.error('Failed to start server', { error: (err as Error).message });
    process.exit(1);
  }
}

// ── Graceful Shutdown ──────────────────────────────────
process.on('SIGTERM', async () => {
  logger.info('SIGTERM received - shutting down gracefully');
  httpServer.close(() => {
    logger.info('HTTP server closed');
    process.exit(0);
  });
});

process.on('SIGINT', async () => {
  logger.info('SIGINT received - shutting down gracefully');
  process.exit(0);
});

start();
