// ═══════════════════════════════════════════════════════
// Live control-plane snapshot for the dashboard
// (sliding-window usage, fair-share lanes, queue wait, breakers, chaos)
// ═══════════════════════════════════════════════════════

import { query } from '../db/pool';
import { getRedis } from '../db/redis';
import { getQueueMetrics } from '../queue/gateway.queue';
import { getLaneDepths, isFairShareEnabled } from '../queue/fairQueue';
import { getWindowUsage } from '../utils/slidingWindowLimiter';
import { circuitBreaker } from '../utils/redisCircuitBreaker';
import { getAllChaos } from '../utils/chaos';
import { getProvider } from '../providers/llmProviders';

const REJECTED_PREFIX = 'stats:rejected:';

/** Count a 429 in a per-second bucket hash (last 60s are summed for display). */
export async function recordRejection(tenantId: string): Promise<void> {
  const key = REJECTED_PREFIX + tenantId;
  const now = Math.floor(Date.now() / 1000);
  await getRedis().multi().hincrby(key, String(now), 1).expire(key, 65).exec();
}

async function rejectedLastMinute(tenantId: string): Promise<number> {
  const data = await getRedis().hgetall(REJECTED_PREFIX + tenantId);
  const cutoff = Math.floor(Date.now() / 1000) - 60;
  return Object.entries(data).reduce((sum, [sec, n]) => (Number(sec) > cutoff ? sum + Number(n) : sum), 0);
}

export async function getTenantLiveStats() {
  const [tenants, laneDepths, perf] = await Promise.all([
    query<{ id: string; name: string; tpm_limit: number; rpm_limit: number }>(
      'SELECT id, name, tpm_limit, rpm_limit FROM tenants WHERE is_active = true ORDER BY name'
    ),
    getLaneDepths(),
    query<{
      tenant_id: string;
      in_flight: string;
      completed_recent: string;
      avg_wait_ms: string | null;
      p95_wait_ms: string | null;
    }>(`
      SELECT tenant_id,
        COUNT(*) FILTER (WHERE status IN ('queued', 'processing')) AS in_flight,
        COUNT(*) FILTER (WHERE status = 'completed' AND completed_at > NOW() - INTERVAL '2 minutes') AS completed_recent,
        ROUND(AVG(EXTRACT(EPOCH FROM (processing_started_at - queued_at)) * 1000)
          FILTER (WHERE processing_started_at > NOW() - INTERVAL '2 minutes')) AS avg_wait_ms,
        ROUND((PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (processing_started_at - queued_at)) * 1000)
          FILTER (WHERE processing_started_at > NOW() - INTERVAL '2 minutes'))::numeric) AS p95_wait_ms
      FROM gateway_requests
      WHERE created_at > NOW() - INTERVAL '1 hour'
      GROUP BY tenant_id
    `),
  ]);

  return Promise.all(
    tenants.map(async (t) => {
      const [usage, rejected] = await Promise.all([getWindowUsage(t.id), rejectedLastMinute(t.id)]);
      const p = perf.find((row) => row.tenant_id === t.id);
      return {
        id: t.id,
        name: t.name,
        tpmLimit: t.tpm_limit,
        rpmLimit: t.rpm_limit,
        tpmUsed: usage.tpmUsed,
        rpmUsed: usage.rpmUsed,
        rejectedLastMinute: rejected,
        laneDepth: laneDepths[t.id] ?? 0,
        inFlight: Number(p?.in_flight ?? 0),
        completedRecent: Number(p?.completed_recent ?? 0),
        avgWaitMs: p?.avg_wait_ms != null ? Number(p.avg_wait_ms) : null,
        p95WaitMs: p?.p95_wait_ms != null ? Number(p.p95_wait_ms) : null,
      };
    })
  );
}

export async function getProviderControlState() {
  const providers = await query<{ name: string }>('SELECT name FROM providers ORDER BY priority');
  const chaos = await getAllChaos();
  return Promise.all(
    providers.map(async ({ name }) => ({
      name,
      mode: getProvider(name).mode,
      breaker: await circuitBreaker.getStatus(name),
      chaos: chaos[name] ?? { failureRate: 0, latencyMs: 0 },
    }))
  );
}

export async function getLiveSnapshot() {
  const [queue, providers, controls, tenants, fairShare] = await Promise.all([
    getQueueMetrics(),
    query(`
      SELECT name, display_name, health_status, error_rate, avg_latency_ms, is_active
      FROM providers ORDER BY priority
    `),
    getProviderControlState(),
    getTenantLiveStats(),
    isFairShareEnabled(),
  ]);

  return {
    queue,
    providers,
    controls,
    tenants,
    fairShare,
    timestamp: new Date().toISOString(),
  };
}
