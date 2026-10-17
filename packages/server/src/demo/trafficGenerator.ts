// ═══════════════════════════════════════════════════════
// Demo traffic generator
// Calls the public gateway API over HTTP with real tenant keys, so every
// request goes through auth → idempotency → sliding-window limiter → lanes.
//   steady: two well-behaved tenants, one request each every 1.5s
//   burst:  the noisy tenant fires 300 requests as fast as possible
// ═══════════════════════════════════════════════════════

import { DEMO_TENANTS, DemoTenantId, SAMPLE_PROMPTS } from './demoTenants';
import { getSocketIO } from '../socket/socket.server';
import { logger } from '../utils/logger';

interface TenantCounters {
  sent: number;
  accepted: number;
  rateLimited: number;
  errors: number;
}

const STEADY_INTERVAL_MS = 1500;
const STEADY_MAX_DURATION_MS = 10 * 60 * 1000;
const BURST_SIZE = 300;
const BURST_CONCURRENCY = 25;

let steadyTimer: NodeJS.Timeout | null = null;
let steadyStopAt = 0;
let burstRunning = false;
let lastEmit = 0;

const counters: Record<DemoTenantId, TenantCounters> = {
  acme: { sent: 0, accepted: 0, rateLimited: 0, errors: 0 },
  globex: { sent: 0, accepted: 0, rateLimited: 0, errors: 0 },
  initech: { sent: 0, accepted: 0, rateLimited: 0, errors: 0 },
};

export function getTrafficStatus() {
  return {
    steady: steadyTimer !== null,
    burst: burstRunning,
    tenants: Object.fromEntries(
      (Object.keys(DEMO_TENANTS) as DemoTenantId[]).map((id) => [
        id,
        { name: DEMO_TENANTS[id].name, ...counters[id] },
      ])
    ),
  };
}

function emitStatus(force = false) {
  const now = Date.now();
  if (!force && now - lastEmit < 500) return;
  lastEmit = now;
  getSocketIO()?.emit('demo:traffic', getTrafficStatus());
}

async function sendOne(tenant: DemoTenantId, maxTokens: number): Promise<void> {
  const port = process.env.PORT ?? '3001';
  const c = counters[tenant];
  c.sent++;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/v1/gateway/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Api-Key': DEMO_TENANTS[tenant].apiKey },
      body: JSON.stringify({
        userMessage: SAMPLE_PROMPTS[Math.floor(Math.random() * SAMPLE_PROMPTS.length)],
        maxTokens,
      }),
    });
    if (res.status === 202) c.accepted++;
    else if (res.status === 429) c.rateLimited++;
    else c.errors++;
  } catch {
    c.errors++;
  }
  emitStatus();
}

export function startSteady(): void {
  steadyStopAt = Date.now() + STEADY_MAX_DURATION_MS;
  if (steadyTimer) return;
  steadyTimer = setInterval(() => {
    if (Date.now() > steadyStopAt) return stopTraffic();
    sendOne('acme', 256);
    sendOne('globex', 256);
  }, STEADY_INTERVAL_MS);
  logger.info('Demo: steady traffic started');
  emitStatus(true);
}

export async function startBurst(): Promise<void> {
  if (burstRunning) return;
  burstRunning = true;
  emitStatus(true);
  logger.info('Demo: noisy-neighbour burst started', { size: BURST_SIZE });

  let remaining = BURST_SIZE;
  const workers = Array.from({ length: BURST_CONCURRENCY }, async () => {
    while (remaining > 0 && burstRunning) {
      remaining--;
      await sendOne('initech', 64);
    }
  });
  await Promise.all(workers);

  burstRunning = false;
  emitStatus(true);
  logger.info('Demo: burst finished', counters.initech);
}

export function stopTraffic(): void {
  if (steadyTimer) clearInterval(steadyTimer);
  steadyTimer = null;
  burstRunning = false;
  emitStatus(true);
}

export function resetCounters(): void {
  for (const c of Object.values(counters)) {
    c.sent = c.accepted = c.rateLimited = c.errors = 0;
  }
  emitStatus(true);
}
