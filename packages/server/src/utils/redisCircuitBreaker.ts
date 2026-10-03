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
}

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
    const redis = getRedis();
    const key = this.getKey(provider);

    const now = Date.now();
    const data = await redis.hgetall(key);

    const state = (data.state as CircuitState) || 'CLOSED';
    const openedAt = data.opened_at ? parseInt(data.opened_at, 10) : 0;
    const halfOpenTrials = data.half_open_trials ? parseInt(data.half_open_trials, 10) : 0;

    if (state === 'CLOSED') {
      return true;
    }

    if (state === 'OPEN') {
      // Check if cooldown timer has passed
      if (now - openedAt >= this.config.cooldownMs) {
        // Atomic transition to HALF_OPEN
        await redis
          .multi()
          .hset(key, {
            state: 'HALF_OPEN',
            half_open_trials: '1',
            consecutive_successes: '0',
            last_state_change: now.toString(),
          })
          .exec();

        logger.info(`CircuitBreaker [${provider}]: OPEN cooldown expired. Transitioning to HALF_OPEN (Trial 1)`);
        return true;
      }

      // Still in cooldown period - fast fail!
      return false;
    }

    if (state === 'HALF_OPEN') {
      if (halfOpenTrials < this.config.halfOpenMaxTrials) {
        await redis.hincrby(key, 'half_open_trials', 1);
        logger.info(`CircuitBreaker [${provider}]: Allowed probe trial ${halfOpenTrials + 1}/${this.config.halfOpenMaxTrials} in HALF_OPEN state`);
        return true;
      }
      return false;
    }

    return true;
  }

  /**
   * Records a successful request for a provider.
   */
  async recordSuccess(provider: string): Promise<void> {
    const redis = getRedis();
    const key = this.getKey(provider);
    const now = Date.now();

    const data = await redis.hgetall(key);
    const state = (data.state as CircuitState) || 'CLOSED';

    if (state === 'HALF_OPEN') {
      const currentSuccesses = (data.consecutive_successes ? parseInt(data.consecutive_successes, 10) : 0) + 1;

      if (currentSuccesses >= this.config.halfOpenSuccessThreshold) {
        // Circuit recovered! Transition to CLOSED
        await redis
          .multi()
          .hset(key, {
            state: 'CLOSED',
            consecutive_failures: '0',
            consecutive_successes: '0',
            half_open_trials: '0',
            last_state_change: now.toString(),
          })
          .exec();

        logger.info(`CircuitBreaker [${provider}]: Probe successful! State recovered: HALF_OPEN -> CLOSED`);
      } else {
        await redis.hset(key, 'consecutive_successes', currentSuccesses.toString());
      }
    } else if (state === 'CLOSED') {
      // Reset failure counter on success
      await redis.hset(key, 'consecutive_failures', '0');
    }
  }

  /**
   * Records a failure for a provider.
   */
  async recordFailure(provider: string, errorReason?: string): Promise<void> {
    const redis = getRedis();
    const key = this.getKey(provider);
    const now = Date.now();

    const data = await redis.hgetall(key);
    const state = (data.state as CircuitState) || 'CLOSED';

    if (state === 'HALF_OPEN') {
      // Probe failed! Immediately trip back to OPEN
      await redis
        .multi()
        .hset(key, {
          state: 'OPEN',
          opened_at: now.toString(),
          consecutive_successes: '0',
          half_open_trials: '0',
          last_state_change: now.toString(),
          last_error: errorReason ?? 'Probe trial failed',
        })
        .exec();

      logger.warn(`CircuitBreaker [${provider}]: Probe failed! Transitioning: HALF_OPEN -> OPEN (cooldown restarted)`);
    } else if (state === 'CLOSED') {
      const currentFailures = (data.consecutive_failures ? parseInt(data.consecutive_failures, 10) : 0) + 1;

      if (currentFailures >= this.config.failureThreshold) {
        // Threshold breached! Trip circuit to OPEN
        await redis
          .multi()
          .hset(key, {
            state: 'OPEN',
            opened_at: now.toString(),
            consecutive_failures: currentFailures.toString(),
            last_state_change: now.toString(),
            last_error: errorReason ?? 'Failure threshold exceeded',
          })
          .exec();

        logger.warn(`CircuitBreaker [${provider}]: Failure threshold (${currentFailures}/${this.config.failureThreshold}) reached! State tripped: CLOSED -> OPEN`);
      } else {
        await redis.hset(key, 'consecutive_failures', currentFailures.toString());
      }
    }
  }

  /**
   * Fetches status of circuit breaker for a provider across all replicas.
   */
  async getStatus(provider: string): Promise<CircuitBreakerStatus> {
    const redis = getRedis();
    const key = this.getKey(provider);
    const data = await redis.hgetall(key);

    const state = (data.state as CircuitState) || 'CLOSED';
    const failures = data.consecutive_failures ? parseInt(data.consecutive_failures, 10) : 0;
    const successes = data.consecutive_successes ? parseInt(data.consecutive_successes, 10) : 0;
    const trials = data.half_open_trials ? parseInt(data.half_open_trials, 10) : 0;
    const lastChange = data.last_state_change
      ? new Date(parseInt(data.last_state_change, 10)).toISOString()
      : new Date().toISOString();
    const openedAt = data.opened_at
      ? new Date(parseInt(data.opened_at, 10)).toISOString()
      : undefined;

    return {
      provider,
      state,
      consecutiveFailures: failures,
      consecutiveSuccesses: successes,
      lastStateChange: lastChange,
      openedAt,
      halfOpenTrials: trials,
    };
  }

  /**
   * Force reset circuit breaker state to CLOSED (Admin override)
   */
  async reset(provider: string): Promise<void> {
    const redis = getRedis();
    const key = this.getKey(provider);

    await redis
      .multi()
      .hset(key, {
        state: 'CLOSED',
        consecutive_failures: '0',
        consecutive_successes: '0',
        half_open_trials: '0',
        last_state_change: Date.now().toString(),
      })
      .exec();

    logger.info(`CircuitBreaker [${provider}]: Manually reset to CLOSED`);
  }
}

export const circuitBreaker = new RedisCircuitBreaker();
