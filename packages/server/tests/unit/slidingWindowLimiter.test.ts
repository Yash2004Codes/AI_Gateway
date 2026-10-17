import { createTestRedis } from './redisTestClient';
import { checkRateLimit, reconcileTokens, getWindowUsage } from '../../src/utils/slidingWindowLimiter';

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

describe('Sliding-window rate limiter', () => {
  it('admits requests until the token budget is used, then rejects with TPM_EXCEEDED', async () => {
    expect((await checkRateLimit('t1', 400, 1000, 100)).allowed).toBe(true);
    expect((await checkRateLimit('t1', 400, 1000, 100)).allowed).toBe(true);

    const third = await checkRateLimit('t1', 400, 1000, 100);
    expect(third.allowed).toBe(false);
    expect(third.reason).toBe('TPM_EXCEEDED');
    expect(third.retryAfterSeconds).toBeGreaterThan(0);
  });

  it('does not count rejected requests against the window', async () => {
    await checkRateLimit('t2', 900, 1000, 100);
    await checkRateLimit('t2', 500, 1000, 100); // rejected
    await checkRateLimit('t2', 500, 1000, 100); // rejected
    expect(await getWindowUsage('t2')).toEqual({ tpmUsed: 900, rpmUsed: 1 });
  });

  it('enforces the requests-per-minute limit independently of tokens', async () => {
    for (let i = 0; i < 3; i++) {
      expect((await checkRateLimit('t3', 1, 1_000_000, 3)).allowed).toBe(true);
    }
    const fourth = await checkRateLimit('t3', 1, 1_000_000, 3);
    expect(fourth.allowed).toBe(false);
    expect(fourth.reason).toBe('RPM_EXCEEDED');
  });

  it('never over-admits under concurrent requests (atomic check-and-admit)', async () => {
    const results = await Promise.all(
      Array.from({ length: 50 }, () => checkRateLimit('t4', 100, 1000, 1000))
    );
    expect(results.filter((r) => r.allowed)).toHaveLength(10);
    expect((await getWindowUsage('t4')).tpmUsed).toBe(1000);
  });

  it('slides: buckets older than 60s no longer count', async () => {
    const old = Math.floor(Date.now() / 1000) - 61;
    await mockRedis.hset('rl:tpm:t5', String(old), 1000);
    await mockRedis.hset('rl:rpm:t5', String(old), 1);
    expect((await checkRateLimit('t5', 1000, 1000, 100)).allowed).toBe(true);
  });

  it('reconciles the reservation to actual usage', async () => {
    const admitted = await checkRateLimit('t6', 1000, 5000, 100);
    await reconcileTokens('t6', admitted.admittedAt, 1000, 250);
    expect((await getWindowUsage('t6')).tpmUsed).toBe(250);
  });
});
