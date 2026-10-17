import { getRedis } from '../db/redis';

// ─────────────────────────────────────────────
// Fault injection per provider, shared by all workers through Redis.
// Used to demonstrate failover and the circuit breaker on demand:
// failureRate 1.0 = every call to that vendor fails with a simulated 503.
// Applies to live and mock providers alike, before any vendor call is made.
// ─────────────────────────────────────────────

const CHAOS_KEY = 'chaos:providers';

export interface ChaosConfig {
  failureRate: number; // 0..1
  latencyMs: number;   // extra latency added before the call
}

const NONE: ChaosConfig = { failureRate: 0, latencyMs: 0 };

export async function getChaos(provider: string): Promise<ChaosConfig> {
  const raw = await getRedis().hget(CHAOS_KEY, provider);
  return raw ? { ...NONE, ...JSON.parse(raw) } : NONE;
}

export async function getAllChaos(): Promise<Record<string, ChaosConfig>> {
  const all = await getRedis().hgetall(CHAOS_KEY);
  return Object.fromEntries(Object.entries(all).map(([k, v]) => [k, { ...NONE, ...JSON.parse(v) }]));
}

export async function setChaos(provider: string, config: Partial<ChaosConfig>): Promise<ChaosConfig> {
  const next: ChaosConfig = {
    failureRate: Math.min(1, Math.max(0, Number(config.failureRate ?? 0))),
    latencyMs: Math.min(30000, Math.max(0, Number(config.latencyMs ?? 0))),
  };
  if (next.failureRate === 0 && next.latencyMs === 0) {
    await getRedis().hdel(CHAOS_KEY, provider);
  } else {
    await getRedis().hset(CHAOS_KEY, provider, JSON.stringify(next));
  }
  return next;
}

/** Throws a simulated vendor outage if chaos is configured for this provider. */
export async function applyChaos(provider: string): Promise<void> {
  const chaos = await getChaos(provider);
  if (chaos.latencyMs > 0) await new Promise((r) => setTimeout(r, chaos.latencyMs));
  if (chaos.failureRate > 0 && Math.random() < chaos.failureRate) {
    throw Object.assign(new Error(`[chaos] injected ${provider} outage (503)`), { status: 503 });
  }
}
