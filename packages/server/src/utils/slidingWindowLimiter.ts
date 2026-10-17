import { getRedis } from '../db/redis';

// ─────────────────────────────────────────────
// Sliding-window rate limiter (TPM + RPM), atomic in one Lua script.
//
// Each tenant has two Redis hashes of 1-second buckets: field = epoch second,
// value = tokens (or requests) admitted in that second. Usage is the sum of
// buckets newer than (now - window). Buckets that slide out are deleted on read.
//
// Compared with a fixed window this has no boundary burst (a tenant cannot
// spend 2x its limit across a minute boundary), and because check + admit
// happen in a single script, concurrent API replicas cannot over-admit.
// Rejected requests are NOT counted.
// ─────────────────────────────────────────────

export const WINDOW_SECONDS = 60;

const tpmKey = (tenantId: string) => `rl:tpm:${tenantId}`;
const rpmKey = (tenantId: string) => `rl:rpm:${tenantId}`;

const CHECK_AND_ADMIT = `
local now = tonumber(ARGV[1])
local win = tonumber(ARGV[2])
local tokens = tonumber(ARGV[3])
local tpmLimit = tonumber(ARGV[4])
local rpmLimit = tonumber(ARGV[5])

local oldest = now
local function usage(key)
  local total = 0
  local data = redis.call('HGETALL', key)
  for i = 1, #data, 2 do
    local sec = tonumber(data[i])
    if sec <= now - win then
      redis.call('HDEL', key, data[i])
    else
      total = total + tonumber(data[i + 1])
      if sec < oldest then oldest = sec end
    end
  end
  return total
end

local tpm = usage(KEYS[1])
local rpm = usage(KEYS[2])

-- reason: 1 = RPM exceeded, 2 = TPM exceeded
if rpm + 1 > rpmLimit then return {0, tpm, rpm, 1, oldest} end
if tpm + tokens > tpmLimit then return {0, tpm, rpm, 2, oldest} end

redis.call('HINCRBY', KEYS[1], now, tokens)
redis.call('HINCRBY', KEYS[2], now, 1)
redis.call('EXPIRE', KEYS[1], win + 5)
redis.call('EXPIRE', KEYS[2], win + 5)
return {1, tpm + tokens, rpm + 1, 0, oldest}
`;

// Give back over-reserved tokens once the real count is known,
// only if that second's bucket is still inside the window.
const RECONCILE = `
if redis.call('HEXISTS', KEYS[1], ARGV[1]) == 1 then
  return redis.call('HINCRBY', KEYS[1], ARGV[1], ARGV[2])
end
return 0
`;

const READ_USAGE = `
local now = tonumber(ARGV[1])
local win = tonumber(ARGV[2])
local function usage(key)
  local total = 0
  local data = redis.call('HGETALL', key)
  for i = 1, #data, 2 do
    if tonumber(data[i]) > now - win then total = total + tonumber(data[i + 1]) end
  end
  return total
end
return {usage(KEYS[1]), usage(KEYS[2])}
`;

export interface RateLimitResult {
  allowed: boolean;
  tpmUsed: number;
  rpmUsed: number;
  reason: 'RPM_EXCEEDED' | 'TPM_EXCEEDED' | null;
  retryAfterSeconds: number;
  /** Epoch second the tokens were admitted into, used for later reconciliation */
  admittedAt: number;
}

export async function checkRateLimit(
  tenantId: string,
  estimatedTokens: number,
  tpmLimit: number,
  rpmLimit: number
): Promise<RateLimitResult> {
  const now = Math.floor(Date.now() / 1000);
  const [allowed, tpmUsed, rpmUsed, reason, oldest] = (await getRedis().eval(
    CHECK_AND_ADMIT,
    2,
    tpmKey(tenantId),
    rpmKey(tenantId),
    now,
    WINDOW_SECONDS,
    estimatedTokens,
    tpmLimit,
    rpmLimit
  )) as number[];

  return {
    allowed: allowed === 1,
    tpmUsed,
    rpmUsed,
    reason: reason === 1 ? 'RPM_EXCEEDED' : reason === 2 ? 'TPM_EXCEEDED' : null,
    // When the oldest bucket slides out, capacity frees up
    retryAfterSeconds: Math.max(1, oldest + WINDOW_SECONDS - now),
    admittedAt: now,
  };
}

export async function reconcileTokens(
  tenantId: string,
  admittedAt: number,
  reservedTokens: number,
  actualTokens: number
): Promise<void> {
  const delta = actualTokens - reservedTokens;
  if (delta === 0) return;
  await getRedis().eval(RECONCILE, 1, tpmKey(tenantId), admittedAt, delta);
}

export async function getWindowUsage(tenantId: string): Promise<{ tpmUsed: number; rpmUsed: number }> {
  const now = Math.floor(Date.now() / 1000);
  const [tpmUsed, rpmUsed] = (await getRedis().eval(
    READ_USAGE,
    2,
    tpmKey(tenantId),
    rpmKey(tenantId),
    now,
    WINDOW_SECONDS
  )) as number[];
  return { tpmUsed, rpmUsed };
}
