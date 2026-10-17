import { Router, Request, Response, NextFunction } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { queryOne, query } from '../db/pool';
import { jwtAuth, requireRole, AuthenticatedRequest, getJwtSecret } from '../middleware/auth.middleware';
import { getQueueMetrics } from '../queue/gateway.queue';
import { getCachedMetrics, cacheMetrics } from '../db/redis';
import { generateApiKey } from '../utils/apiKey';
import { circuitBreaker } from '../utils/redisCircuitBreaker';
import { setChaos } from '../utils/chaos';
import { setFairShareEnabled } from '../queue/fairQueue';
import { getLiveSnapshot } from '../services/liveMetrics';
import { getProvider } from '../providers/llmProviders';
import { seedHistory } from '../demo/seedHistory';
import {
  getTrafficStatus,
  startSteady,
  startBurst,
  stopTraffic,
  resetCounters,
} from '../demo/trafficGenerator';

const router = Router();

// ─────────────────────────────────────────────
// POST /api/v1/admin/auth/login
// ─────────────────────────────────────────────
router.post('/auth/login', async (req: Request, res: Response): Promise<void> => {
  const { email, password } = req.body;

  if (!email || !password) {
    res.status(400).json({ error: 'Email and password are required' });
    return;
  }

  const user = await queryOne<{
    id: string;
    email: string;
    password_hash: string;
    name: string;
    role: string;
    tenant_id: string | null;
    is_active: boolean;
  }>('SELECT id, email, password_hash, name, role, tenant_id, is_active FROM users WHERE email = $1', [email]);

  if (!user || !user.is_active) {
    res.status(401).json({ error: 'Invalid credentials' });
    return;
  }

  const valid = await bcrypt.compare(password, user.password_hash);
  if (!valid) {
    res.status(401).json({ error: 'Invalid credentials' });
    return;
  }

  await query('UPDATE users SET last_login = NOW() WHERE id = $1', [user.id]);

  const token = jwt.sign(
    { userId: user.id, email: user.email, role: user.role, tenantId: user.tenant_id },
    getJwtSecret(),
    { expiresIn: '24h' }
  );

  res.json({
    token,
    user: { id: user.id, email: user.email, name: user.name, role: user.role },
  });
});

// ─────────────────────────────────────────────
// GET /api/v1/admin/dashboard/overview
// ─────────────────────────────────────────────
router.get(
  '/dashboard/overview',
  jwtAuth,
  requireRole('admin', 'operator'),
  async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const cached = await getCachedMetrics<Record<string, unknown>>('dashboard:overview');
    if (cached) {
      res.json(cached);
      return;
    }

    const [requestStats, tokenStats, queueMetrics, providerStats] = await Promise.all([
      query(`
        SELECT
          COUNT(*) FILTER (WHERE status = 'completed') AS completed,
          COUNT(*) FILTER (WHERE status = 'failed') AS failed,
          COUNT(*) FILTER (WHERE status IN ('pending', 'queued', 'processing')) AS in_flight,
          COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '1 hour') AS last_hour,
          COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '24 hours') AS last_24h,
          ROUND(AVG(total_latency_ms) FILTER (WHERE status = 'completed'), 0) AS avg_latency_ms,
          ROUND(
            100.0 * COUNT(*) FILTER (WHERE status = 'completed') /
            NULLIF(COUNT(*) FILTER (WHERE status IN ('completed', 'failed')), 0), 2
          ) AS success_rate
        FROM gateway_requests
      `),
      query(`
        SELECT
          SUM(total_tokens) AS total_tokens,
          SUM(cost_usd) AS total_cost_usd,
          COUNT(DISTINCT tenant_id) AS active_tenants
        FROM token_usage_ledger
        WHERE recorded_at > NOW() - INTERVAL '24 hours'
      `),
      getQueueMetrics(),
      query(`
        SELECT name, display_name, health_status, error_rate, avg_latency_ms
        FROM providers WHERE is_active = true ORDER BY priority
      `),
    ]);

    const data = {
      requests: requestStats[0],
      tokens: tokenStats[0],
      queue: queueMetrics,
      providers: providerStats,
      generatedAt: new Date().toISOString(),
    };

    await cacheMetrics('dashboard:overview', data, 15);
    res.json(data);
  }
);

// ─────────────────────────────────────────────
// GET /api/v1/admin/dashboard/time-series
// Token usage over time for charting
// ─────────────────────────────────────────────
router.get(
  '/dashboard/time-series',
  jwtAuth,
  requireRole('admin', 'operator'),
  async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const hours = Math.min(Math.max(1, parseInt(req.query.hours as string, 10) || 24), 720);

    const series = await query(`
      SELECT
        DATE_TRUNC('hour', recorded_at) AS hour,
        provider,
        SUM(total_tokens)::bigint AS tokens,
        SUM(cost_usd)::numeric AS cost_usd,
        COUNT(*)::int AS request_count
      FROM token_usage_ledger
      WHERE recorded_at > NOW() - ($1 || ' hours')::INTERVAL
      GROUP BY 1, 2
      ORDER BY 1 ASC, 2
    `, [hours]);

    res.json({ series, hours });
  }
);

// ─────────────────────────────────────────────
// GET /api/v1/admin/dashboard/requests
// Recent requests for admin view
// ─────────────────────────────────────────────
router.get(
  '/dashboard/requests',
  jwtAuth,
  requireRole('admin', 'operator'),
  async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const limit = Math.min(Math.max(1, parseInt(req.query.limit as string, 10) || 50), 200);
    const status = req.query.status as string | undefined;

    const statusFilter = status ? 'WHERE gr.status = $2' : '';
    const params: unknown[] = [limit, ...(status ? [status] : [])];

    const requests = await query(`
      SELECT
        gr.id, gr.status, gr.provider_used, gr.model_used,
        gr.total_tokens, gr.estimated_cost_usd, gr.total_latency_ms,
        gr.attempt_count, gr.providers_tried, gr.error_code,
        gr.created_at, gr.completed_at,
        t.name AS tenant_name
      FROM gateway_requests gr
      JOIN tenants t ON t.id = gr.tenant_id
      ${statusFilter}
      ORDER BY gr.created_at DESC
      LIMIT $1
    `, params);

    res.json({ requests });
  }
);

// ─────────────────────────────────────────────
// GET /api/v1/admin/tenants
// ─────────────────────────────────────────────
router.get(
  '/tenants',
  jwtAuth,
  requireRole('admin'),
  async (_req: AuthenticatedRequest, res: Response): Promise<void> => {
    const tenants = await query(`
      SELECT
        t.id, t.name, t.tpm_limit, t.rpm_limit, t.monthly_token_budget, t.is_active, t.created_at,
        COUNT(gr.id) AS total_requests,
        SUM(gr.total_tokens) AS total_tokens,
        SUM(gr.estimated_cost_usd) AS total_cost
      FROM tenants t
      LEFT JOIN gateway_requests gr ON gr.tenant_id = t.id
      GROUP BY t.id ORDER BY t.created_at DESC
    `);
    res.json({ tenants });
  }
);

// ─────────────────────────────────────────────
// POST /api/v1/admin/tenants
// ─────────────────────────────────────────────
router.post(
  '/tenants',
  jwtAuth,
  requireRole('admin'),
  async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const { name, tpmLimit = 10000, rpmLimit = 100 } = req.body;
    if (!name || typeof name !== 'string') {
      res.status(400).json({ error: 'name is required' });
      return;
    }

    const { apiKey, hash, prefix } = generateApiKey();

    const tenant = await queryOne(
      `INSERT INTO tenants (name, api_key_hash, api_key_prefix, tpm_limit, rpm_limit)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, name, api_key_prefix, tpm_limit, rpm_limit, created_at`,
      [name, hash, prefix, tpmLimit, rpmLimit]
    );

    // The raw key is returned exactly once; only its hash is persisted
    res.status(201).json({ ...tenant, api_key: apiKey });
  }
);

// ─────────────────────────────────────────────
// GET /api/v1/admin/providers
// ─────────────────────────────────────────────
router.get(
  '/providers',
  jwtAuth,
  requireRole('admin', 'operator'),
  async (_req: AuthenticatedRequest, res: Response): Promise<void> => {
    const providers = await query(`
      SELECT p.id, p.name, p.display_name, p.is_active, p.priority,
             p.health_status, p.error_rate, p.avg_latency_ms, p.last_health_check,
             COUNT(m.id) AS model_count
      FROM providers p
      LEFT JOIN models m ON m.provider_id = p.id AND m.is_active = true
      GROUP BY p.id ORDER BY p.priority
    `);

    const models = await query(`
      SELECT m.id, m.provider_id, m.name, m.display_name,
             m.context_window, m.input_cost_per_1k_tokens, m.output_cost_per_1k_tokens, m.is_active
      FROM models m ORDER BY m.provider_id, m.name
    `);

    res.json({
      providers: providers.map((p: { name: string }) => ({ ...p, mode: getProvider(p.name).mode })),
      models,
    });
  }
);

// ─────────────────────────────────────────────
// GET /api/v1/admin/circuit-breaker/:provider
// ─────────────────────────────────────────────
router.get(
  '/circuit-breaker/:provider',
  jwtAuth,
  requireRole('admin', 'operator'),
  async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const { provider } = req.params;
    const status = await circuitBreaker.getStatus(provider);
    res.json(status);
  }
);

// ─────────────────────────────────────────────
// POST /api/v1/admin/circuit-breaker/:provider/reset
// ─────────────────────────────────────────────
router.post(
  '/circuit-breaker/:provider/reset',
  jwtAuth,
  requireRole('admin'),
  async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const { provider } = req.params;
    await circuitBreaker.reset(provider);
    res.json({ success: true, message: `Circuit breaker for ${provider} reset to CLOSED` });
  }
);

// ─────────────────────────────────────────────
// PATCH /api/v1/admin/providers/:id/status
// Enable/disable a provider; the dispatcher reads this on every job
// ─────────────────────────────────────────────
router.patch(
  '/providers/:id/status',
  jwtAuth,
  requireRole('admin'),
  async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    if (typeof req.body?.isActive !== 'boolean') {
      res.status(400).json({ error: 'isActive (boolean) is required' });
      return;
    }
    const provider = await queryOne(
      'UPDATE providers SET is_active = $1 WHERE id = $2 RETURNING id, name, is_active',
      [req.body.isActive, req.params.id]
    );
    if (!provider) {
      res.status(404).json({ error: 'Provider not found' });
      return;
    }
    res.json(provider);
  }
);

// ─────────────────────────────────────────────
// Live control plane: GET /live, chaos, fair-share mode
// ─────────────────────────────────────────────
router.get(
  '/live',
  jwtAuth,
  requireRole('admin', 'operator'),
  async (_req: AuthenticatedRequest, res: Response): Promise<void> => {
    res.json(await getLiveSnapshot());
  }
);

router.put(
  '/chaos/:provider',
  jwtAuth,
  requireRole('admin'),
  async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const exists = await queryOne('SELECT 1 FROM providers WHERE name = $1', [req.params.provider]);
    if (!exists) {
      res.status(404).json({ error: 'Provider not found' });
      return;
    }
    const chaos = await setChaos(req.params.provider, req.body ?? {});
    res.json({ provider: req.params.provider, ...chaos });
  }
);

router.put(
  '/fair-share',
  jwtAuth,
  requireRole('admin'),
  async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    if (typeof req.body?.enabled !== 'boolean') {
      res.status(400).json({ error: 'enabled (boolean) is required' });
      return;
    }
    await setFairShareEnabled(req.body.enabled);
    res.json({ fairShare: req.body.enabled });
  }
);

// ─────────────────────────────────────────────
// Demo controls (only when DEMO_MODE=true)
// ─────────────────────────────────────────────
const demoOnly = (_req: Request, res: Response, next: NextFunction): void => {
  if (process.env.DEMO_MODE !== 'true') {
    res.status(404).json({ error: 'Demo mode is disabled' });
    return;
  }
  next();
};

router.get('/demo/traffic', jwtAuth, requireRole('admin', 'operator'), demoOnly, (_req, res) => {
  res.json(getTrafficStatus());
});

router.post(
  '/demo/traffic',
  jwtAuth,
  requireRole('admin'),
  demoOnly,
  async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const { action } = req.body ?? {};
    switch (action) {
      case 'steady':
        startSteady();
        break;
      case 'burst':
        startSteady(); // the point of the burst is its effect on the others
        startBurst(); // runs in the background
        break;
      case 'stop':
        stopTraffic();
        break;
      case 'reset':
        resetCounters();
        break;
      default:
        res.status(400).json({ error: "action must be 'steady', 'burst', 'stop' or 'reset'" });
        return;
    }
    res.json(getTrafficStatus());
  }
);

router.post(
  '/demo/seed-history',
  jwtAuth,
  requireRole('admin'),
  demoOnly,
  async (_req: AuthenticatedRequest, res: Response): Promise<void> => {
    const result = await seedHistory();
    res.json(result);
  }
);

export default router;
