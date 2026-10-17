// ═══════════════════════════════════════════════════════
// Socket.io Real-time Event Handler
// Bridges Redis Pub/Sub → WebSocket clients
// Enables the "Flight Radar" live dashboard
// ═══════════════════════════════════════════════════════

import { Server as SocketIOServer } from 'socket.io';
import { Server as HttpServer } from 'http';
import { createRedisConnection } from '../db/redis';
import { getQueueMetrics } from '../queue/gateway.queue';
import { query } from '../db/pool';
import { logger } from '../utils/logger';
import { verifyJwt } from '../middleware/auth.middleware';
import { getLiveSnapshot } from '../services/liveMetrics';
import Redis from 'ioredis';

let io: SocketIOServer | null = null;

export function initializeSocketIO(httpServer: HttpServer): SocketIOServer {
  io = new SocketIOServer(httpServer, {
    cors: {
      origin: process.env.CLIENT_URL ?? 'http://localhost:3000',
      methods: ['GET', 'POST'],
      credentials: true,
    },
    transports: ['websocket', 'polling'],
  });

  // ── Authentication middleware ──────────────────────
  io.use((socket, next) => {
    const token = socket.handshake.auth?.token;
    try {
      const user = verifyJwt(token);
      if (!['admin', 'operator'].includes(user.role)) {
        return next(new Error('Insufficient permissions'));
      }
      next();
    } catch {
      next(new Error('Unauthorized'));
    }
  });

  // ── Connection handler ─────────────────────────────
  io.on('connection', (socket) => {
    logger.info('Dashboard client connected', { socketId: socket.id });

    // Send initial state on connect
    sendInitialState(socket);

    // Allow clients to subscribe to specific tenant updates
    socket.on('subscribe:tenant', (tenantId: string) => {
      socket.join(`tenant:${tenantId}`);
      logger.debug('Client subscribed to tenant', { socketId: socket.id, tenantId });
    });

    socket.on('unsubscribe:tenant', (tenantId: string) => {
      socket.leave(`tenant:${tenantId}`);
    });

    // Manual refresh request from dashboard
    socket.on('request:queue-metrics', async () => {
      const metrics = await getQueueMetrics();
      socket.emit('queue:metrics', metrics);
    });

    socket.on('disconnect', () => {
      logger.info('Dashboard client disconnected', { socketId: socket.id });
    });
  });

  // ── Redis Pub/Sub Subscriber ───────────────────────
  const subscriber: Redis = createRedisConnection();
  subscriber.subscribe('provider:health', 'job:updates', (err, count) => {
    if (err) {
      logger.error('Redis subscribe error', { error: err.message });
      return;
    }
    logger.info(`Subscribed to ${count} Redis channels`);
  });

  subscriber.on('message', (channel, message) => {
    try {
      const data = JSON.parse(message);

      if (channel === 'provider:health') {
        // Broadcast provider health to all dashboard clients
        io?.emit('provider:health', data);
      } else if (channel === 'job:updates') {
        // Broadcast job update to all clients + tenant room
        io?.emit('job:update', data);
        if (data.tenantId) {
          io?.to(`tenant:${data.tenantId}`).emit('job:update', data);
        }
      }
    } catch (err) {
      logger.error('Failed to parse Redis message', { channel, error: (err as Error).message });
    }
  });

  // ── Periodic control-plane push (every 2s) ────────
  // queue + lanes, provider health, breakers, chaos, per-tenant windows
  const metricsInterval = setInterval(async () => {
    if (!io || io.engine.clientsCount === 0) return;
    try {
      io.emit('metrics:update', await getLiveSnapshot());
    } catch (err) {
      logger.error('Failed to push metrics', { error: (err as Error).message });
    }
  }, 2000);

  httpServer.on('close', () => {
    clearInterval(metricsInterval);
    subscriber.disconnect();
  });

  logger.info('Socket.IO initialized');
  return io;
}

async function sendInitialState(socket: any): Promise<void> {
  try {
    const [queueMetrics, providers, recentRequests] = await Promise.all([
      getQueueMetrics(),
      query(`SELECT name, display_name, health_status, error_rate, avg_latency_ms FROM providers ORDER BY priority`),
      query(`
        SELECT gr.id, gr.status, gr.provider_used, gr.model_used, gr.total_tokens,
               gr.estimated_cost_usd, gr.total_latency_ms, gr.created_at, t.name AS tenant_name
        FROM gateway_requests gr
        JOIN tenants t ON t.id = gr.tenant_id
        ORDER BY gr.created_at DESC LIMIT 20
      `),
    ]);

    socket.emit('initial:state', {
      queue: queueMetrics,
      providers,
      recentRequests,
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    logger.error('Failed to send initial state', { error: (err as Error).message });
  }
}

export function getSocketIO(): SocketIOServer | null {
  return io;
}
