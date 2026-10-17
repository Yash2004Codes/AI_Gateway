// ═══════════════════════════════════════════════════════
// Fair-share scheduling (per-tenant lanes + round-robin)
//
// Problem: a single FIFO queue lets one tenant that submits 500 jobs push
// every other tenant's job behind all 500 of them (noisy neighbour).
//
// Design:
//   API ──► lane per tenant (Redis ZSET, ordered by priority then time)
//                │
//   ring of tenants that have work (Redis LIST) ─ round-robin pointer
//                │
//   scheduler ──► pops ONE job from the next tenant's lane, moves that
//                 tenant to the back of the ring, hands the job to BullMQ
//                │
//   BullMQ "wait" list is kept SHORT (a small buffer), so ordering is decided
//   by the round-robin, not by arrival time. Workers stay unchanged.
//
// Both operations are single Lua scripts, so any number of API replicas and
// scheduler instances can run concurrently without double-popping.
// ═══════════════════════════════════════════════════════

import { Queue } from 'bullmq';
import { getRedis } from '../db/redis';
import { logger } from '../utils/logger';

const RING_KEY = 'fair:ring';         // LIST of tenantIds in round-robin order
const ACTIVE_KEY = 'fair:active';     // SET mirror of the ring for O(1) membership
const LANE_PREFIX = 'fair:lane:';     // ZSET per tenant: member = job JSON
const MODE_KEY = 'config:fair_share'; // 'on' | 'off'  (off = plain FIFO, for comparison)

const ENQUEUE = `
redis.call('ZADD', KEYS[3], ARGV[2], ARGV[3])
if redis.call('SADD', KEYS[2], ARGV[1]) == 1 then
  redis.call('RPUSH', KEYS[1], ARGV[1])
end
return redis.call('ZCARD', KEYS[3])
`;

// Rotate the ring until a tenant with work is found; pop its best job.
// Tenants with empty lanes are dropped from the ring.
const POP_NEXT = `
local n = redis.call('LLEN', KEYS[1])
for i = 1, n do
  local tenant = redis.call('LMOVE', KEYS[1], KEYS[1], 'LEFT', 'RIGHT')
  if not tenant then return false end
  local lane = ARGV[1] .. tenant
  local item = redis.call('ZPOPMIN', lane)
  if redis.call('ZCARD', lane) == 0 then
    redis.call('LREM', KEYS[1], 0, tenant)
    redis.call('SREM', KEYS[2], tenant)
  end
  if item[1] then return item[1] end
end
return false
`;

export async function isFairShareEnabled(): Promise<boolean> {
  return (await getRedis().get(MODE_KEY)) !== 'off';
}

export async function setFairShareEnabled(enabled: boolean): Promise<void> {
  await getRedis().set(MODE_KEY, enabled ? 'on' : 'off');
}

/** Add a job to its tenant's lane. Lower priority number = more urgent. */
export async function enqueueToLane(
  tenantId: string,
  priority: number,
  job: { requestId: string } & Record<string, unknown>
): Promise<number> {
  // priority dominates, arrival time breaks ties (FIFO within a tenant)
  const score = priority * 1e13 + Date.now();
  return (await getRedis().eval(
    ENQUEUE,
    3,
    RING_KEY,
    ACTIVE_KEY,
    LANE_PREFIX + tenantId,
    tenantId,
    score,
    JSON.stringify(job)
  )) as number;
}

async function popNext(): Promise<Record<string, any> | null> {
  const raw = (await getRedis().eval(POP_NEXT, 2, RING_KEY, ACTIVE_KEY, LANE_PREFIX)) as string | null;
  return raw ? JSON.parse(raw) : null;
}

/** Backlog per tenant lane, for the dashboard. */
export async function getLaneDepths(): Promise<Record<string, number>> {
  const redis = getRedis();
  const tenants = await redis.smembers(ACTIVE_KEY);
  if (tenants.length === 0) return {};
  const pipeline = redis.pipeline();
  tenants.forEach((t) => pipeline.zcard(LANE_PREFIX + t));
  const results = (await pipeline.exec()) ?? [];
  return Object.fromEntries(tenants.map((t, i) => [t, Number(results[i]?.[1] ?? 0)]));
}

// ─────────────────────────────────────────────
// Scheduler loop: keeps BullMQ's wait list topped up to `bufferSize`
// with jobs pulled round-robin from the lanes.
// ─────────────────────────────────────────────
export function startFairScheduler(queue: Queue, bufferSize: number): () => void {
  let stopped = false;

  const loop = async () => {
    while (!stopped) {
      try {
        const waiting = await queue.getWaitingCount();
        let moved = 0;
        for (let i = waiting; i < bufferSize; i++) {
          const job = await popNext();
          if (!job) break;
          await queue.add(`${job.tenantId}:request`, job, { jobId: job.requestId });
          moved++;
        }
        // Sleep briefly when there is nothing to move or the buffer is full
        if (moved === 0) await new Promise((r) => setTimeout(r, 50));
      } catch (err) {
        logger.error('Fair scheduler error', { error: (err as Error).message });
        await new Promise((r) => setTimeout(r, 1000));
      }
    }
  };

  loop();
  logger.info('Fair-share scheduler started', { bufferSize });
  return () => {
    stopped = true;
  };
}
