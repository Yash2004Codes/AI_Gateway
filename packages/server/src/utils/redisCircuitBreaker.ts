import { getRedis } from '../db/redis';
import { logger } from './logger';

export type CircuitState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

export interface CircuitBreakerConfig {
  failureThreshold: number;        // Consecutive failures to open circuit (default: 3)
  cooldownMs: number;              // Cooldown time in OPEN state before trying HALF_OPEN (default: 10000ms)
  halfOpenSuccessThreshold: number; // Consecutive successes in HALF_OPEN to close circuit (default: 2)
  halfOpenMaxTrials: number;       // Max concurrent probe requests allowed in HALF_OPEN (default: 3)
}

const DEFAULT_CONFIG: CircuitBreakerConfig = {
  failureThreshold: 3,
  cooldownMs: 10000,
  halfOpenSuccessThreshold: 2,
  halfOpenMaxTrials: 3,
};

export interface CircuitBreakerStatus {
  provider: string;
  state: CircuitState;
  consecutiveFailures: number;
  consecutiveSuccesses: number;
  lastStateChange: string;
  openedAt?: string;
  halfOpenTrials: number;
  lastError?: string;
}

// ─────────────────────────────────────────────
// Every transition is a single Lua script: state is shared by all workers,
// and read-then-write in application code would let two workers race
// (e.g. both admitted as the "only" HALF_OPEN probe).
// Each script returns { allowedOrIgnored, newState, transitioned }.
// ─────────────────────────────────────────────

const CAN_EXECUTE = `
local k = KEYS[1]
local now = tonumber(ARGV[1])
local cooldown = tonumber(ARGV[2])
local maxTrials = tonumber(ARGV[3])
local state = redis.call('HGET', k, 'state') or 'CLOSED'

if state == 'CLOSED' then return {1, state, 0} end

if state == 'OPEN' then
  local openedAt = tonumber(redis.call('HGET', k, 'opened_at') or '0')
  if now - openedAt >= cooldown then
    redis.call('HSET', k, 'state', 'HALF_OPEN', 'half_open_trials', 1,
      'consecutive_successes', 0, 'last_state_change', now)
    return {1, 'HALF_OPEN', 1}
  end
  return {0, state, 0}
end

local trials = tonumber(redis.call('HGET', k, 'half_open_trials') or '0')
if trials < maxTrials then
  redis.call('HINCRBY', k, 'half_open_trials', 1)
  return {1, state, 0}
end
return {0, state, 0}
`;

const RECORD_SUCCESS = `
local k = KEYS[1]
local now = tonumber(ARGV[1])
local needed = tonumber(ARGV[2])
local state = redis.call('HGET', k, 'state') or 'CLOSED'

if state == 'HALF_OPEN' then
  local s = redis.call('HINCRBY', k, 'consecutive_successes', 1)
  if s >= needed then
    redis.call('HSET', k, 'state', 'CLOSED', 'consecutive_failures', 0,
      'consecutive_successes', 0, 'half_open_trials', 0, 'last_state_change', now)
    return {1, 'CLOSED', 1}
  end
  return {1, state, 0}
end

if state == 'CLOSED' then
  redis.call('HSET', k, 'consecutive_failures', 0)
end
return {1, state, 0}
`;

const RECORD_FAILURE = `
local k = KEYS[1]
local now = tonumber(ARGV[1])
local threshold = tonumber(ARGV[2])
local reason = ARGV[3]
local state = redis.call('HGET', k, 'state') or 'CLOSED'

if state == 'HALF_OPEN' then
  redis.call('HSET', k, 'state', 'OPEN', 'opened_at', now, 'consecutive_successes', 0,
    'half_open_trials', 0, 'last_state_change', now, 'last_error', reason)
  return {1, 'OPEN', 1}
end

if state == 'CLOSED' then
  local f = redis.call('HINCRBY', k, 'consecutive_failures', 1)
  redis.call('HSET', k, 'last_error', reason)
  if f >= threshold then
    redis.call('HSET', k, 'state', 'OPEN', 'opened_at', now, 'last_state_change', now)
    return {1, 'OPEN', 1}
  end
end
return {1, state, 0}
`;

export class RedisCircuitBreaker {
  private config: CircuitBreakerConfig;

  constructor(config: Partial<CircuitBreakerConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  private getKey(provider: string): string {
    return `cb:provider:${provider}`;
  }

  /**
   * Evaluates if a request is allowed for the given provider.
   * Atomically transitions state from OPEN -> HALF_OPEN when cooldown expires.
   */
  async canExecute(provider: string): Promise<boolean> {
    const [allowed, , transitioned] = (await getRedis().eval(
      CAN_EXECUTE,
      1,
      this.getKey(provider),
      Date.now(),
      this.config.cooldownMs,
      this.config.halfOpenMaxTrials
    )) as [number, CircuitState, number];

    if (transitioned) {
      logger.info(`CircuitBreaker [${provider}]: OPEN cooldown expired. Transitioning to HALF_OPEN (probing)`);
    }
    return allowed === 1;
  }

  /**
   * Records a successful request for a provider.
   */
  async recordSuccess(provider: string): Promise<void> {
    const [, , transitioned] = (await getRedis().eval(
      RECORD_SUCCESS,
      1,
      this.getKey(provider),
      Date.now(),
      this.config.halfOpenSuccessThreshold
    )) as [number, CircuitState, number];

    if (transitioned) {
      logger.info(`CircuitBreaker [${provider}]: Probe successful! State recovered: HALF_OPEN -> CLOSED`);
    }
  }

  /**
   * Records a failure for a provider.
   */
  async recordFailure(provider: string, errorReason?: string): Promise<void> {
    const [, state, transitioned] = (await getRedis().eval(
      RECORD_FAILURE,
      1,
      this.getKey(provider),
      Date.now(),
      this.config.failureThreshold,
      errorReason ?? 'Request failed'
    )) as [number, CircuitState, number];

    if (transitioned && state === 'OPEN') {
      logger.warn(`CircuitBreaker [${provider}]: tripped to OPEN (cooldown ${this.config.cooldownMs}ms)`);
    }
  }

  /**
   * Fetches status of circuit breaker for a provider across all replicas.
   */
  async getStatus(provider: string): Promise<CircuitBreakerStatus> {
    const data = await getRedis().hgetall(this.getKey(provider));

    const state = (data.state as CircuitState) || 'CLOSED';
    return {
      provider,
      state,
      consecutiveFailures: data.consecutive_failures ? parseInt(data.consecutive_failures, 10) : 0,
      consecutiveSuccesses: data.consecutive_successes ? parseInt(data.consecutive_successes, 10) : 0,
      lastStateChange: data.last_state_change
        ? new Date(parseInt(data.last_state_change, 10)).toISOString()
        : new Date().toISOString(),
      openedAt: data.opened_at ? new Date(parseInt(data.opened_at, 10)).toISOString() : undefined,
      halfOpenTrials: data.half_open_trials ? parseInt(data.half_open_trials, 10) : 0,
      lastError: data.last_error,
    };
  }

  /**
   * Force reset circuit breaker state to CLOSED (Admin override)
   */
  async reset(provider: string): Promise<void> {
    await getRedis().hset(this.getKey(provider), {
      state: 'CLOSED',
      consecutive_failures: '0',
      consecutive_successes: '0',
      half_open_trials: '0',
      last_state_change: Date.now().toString(),
    });

    logger.info(`CircuitBreaker [${provider}]: Manually reset to CLOSED`);
  }
}

export const circuitBreaker = new RedisCircuitBreaker({
  cooldownMs: Number(process.env.CIRCUIT_BREAKER_COOLDOWN_MS) || DEFAULT_CONFIG.cooldownMs,
});
