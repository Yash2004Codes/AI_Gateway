import { RedisCircuitBreaker } from '../../src/utils/redisCircuitBreaker';

import { createTestRedis } from './redisTestClient';

// Runs against a real Redis so the Lua transition scripts are exercised
const mockRedis = createTestRedis();

jest.mock('../../src/db/redis', () => ({
  getRedis: () => mockRedis,
}));

beforeEach(async () => {
  await mockRedis.flushdb();
});

afterAll(async () => {
  await mockRedis.quit();
});

describe('Redis Circuit Breaker State Machine', () => {
  let cb: RedisCircuitBreaker;

  beforeEach(() => {
    cb = new RedisCircuitBreaker({
      failureThreshold: 3,
      cooldownMs: 1000, // Short 1s cooldown for fast test execution
      halfOpenSuccessThreshold: 2,
      halfOpenMaxTrials: 2,
    });
  });

  it('starts in CLOSED state and allows requests', async () => {
    const allowed = await cb.canExecute('openai');
    expect(allowed).toBe(true);
    const status = await cb.getStatus('openai');
    expect(status.state).toBe('CLOSED');
  });

  it('trips from CLOSED to OPEN after 3 consecutive failures', async () => {
    await cb.recordFailure('openai', 'Error 1');
    await cb.recordFailure('openai', 'Error 2');

    let status = await cb.getStatus('openai');
    expect(status.consecutiveFailures).toBe(2);
    expect(status.state).toBe('CLOSED');

    await cb.recordFailure('openai', 'Error 3');
    status = await cb.getStatus('openai');
    expect(status.state).toBe('OPEN');

    // Subsequent call should fast fail
    const allowed = await cb.canExecute('openai');
    expect(allowed).toBe(false);
  });

  it('transitions from OPEN to HALF_OPEN after cooldown expires', async () => {
    // Trip to OPEN
    await cb.recordFailure('anthropic');
    await cb.recordFailure('anthropic');
    await cb.recordFailure('anthropic');

    let status = await cb.getStatus('anthropic');
    expect(status.state).toBe('OPEN');

    // Fast fail immediately
    expect(await cb.canExecute('anthropic')).toBe(false);

    // Wait for 1100ms cooldown
    await new Promise((r) => setTimeout(r, 1100));

    // Next call should be allowed as HALF_OPEN trial
    const allowedTrial = await cb.canExecute('anthropic');
    expect(allowedTrial).toBe(true);

    status = await cb.getStatus('anthropic');
    expect(status.state).toBe('HALF_OPEN');
  });

  it('recovers from HALF_OPEN to CLOSED after required consecutive successes', async () => {
    // Put into HALF_OPEN state
    await cb.recordFailure('gemini');
    await cb.recordFailure('gemini');
    await cb.recordFailure('gemini');
    await new Promise((r) => setTimeout(r, 1100));
    await cb.canExecute('gemini'); // Transitions OPEN -> HALF_OPEN

    // First trial success
    await cb.recordSuccess('gemini');
    let status = await cb.getStatus('gemini');
    expect(status.state).toBe('HALF_OPEN');

    // Second trial success -> Recovers to CLOSED
    await cb.recordSuccess('gemini');
    status = await cb.getStatus('gemini');
    expect(status.state).toBe('CLOSED');
  });

  it('trips back to OPEN if a probe trial fails in HALF_OPEN state', async () => {
    // Put into HALF_OPEN state
    await cb.recordFailure('mistral');
    await cb.recordFailure('mistral');
    await cb.recordFailure('mistral');
    await new Promise((r) => setTimeout(r, 1100));
    await cb.canExecute('mistral'); // OPEN -> HALF_OPEN

    // Probe trial fails!
    await cb.recordFailure('mistral', 'Probe error');
    const status = await cb.getStatus('mistral');
    expect(status.state).toBe('OPEN');

    // Fast-fails again
    expect(await cb.canExecute('mistral')).toBe(false);
  });

  it('admits at most halfOpenMaxTrials concurrent probes in HALF_OPEN', async () => {
    await cb.recordFailure('openai');
    await cb.recordFailure('openai');
    await cb.recordFailure('openai');
    await new Promise((r) => setTimeout(r, 1100));

    // 10 workers race for probe slots at the same instant
    const results = await Promise.all(Array.from({ length: 10 }, () => cb.canExecute('openai')));
    expect(results.filter(Boolean)).toHaveLength(2);
  });
});
