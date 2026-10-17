import { createTestRedis } from './redisTestClient';

const mockRedis = createTestRedis();

jest.mock('../../src/db/redis', () => ({
  getRedis: () => mockRedis,
}));

import { enqueueToLane, getLaneDepths, startFairScheduler } from '../../src/queue/fairQueue';

beforeEach(async () => {
  await mockRedis.flushdb();
});

afterAll(async () => {
  await mockRedis.quit();
});

// Minimal stand-in for a BullMQ Queue: records the order jobs are handed over
function fakeQueue() {
  const added: string[] = [];
  return {
    added,
    queue: {
      getWaitingCount: async () => 0,
      add: async (_name: string, data: { tenantId: string }) => {
        added.push(data.tenantId);
      },
    },
  };
}

async function drain(expected: number) {
  const { added, queue } = fakeQueue();
  const stop = startFairScheduler(queue as any, 1);
  const deadline = Date.now() + 5000;
  while (added.length < expected && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 10));
  }
  stop();
  return added;
}

describe('Fair-share lanes', () => {
  it('interleaves tenants round-robin even when one tenant floods the queue', async () => {
    for (let i = 0; i < 20; i++) await enqueueToLane('noisy', 5, { requestId: `n${i}`, tenantId: 'noisy' });
    for (let i = 0; i < 3; i++) await enqueueToLane('quiet', 5, { requestId: `q${i}`, tenantId: 'quiet' });

    const order = await drain(23);

    // All quiet jobs are served within the first 6 dispatches, not after the 20 noisy ones
    expect(order.slice(0, 6)).toEqual(['noisy', 'quiet', 'noisy', 'quiet', 'noisy', 'quiet']);
    expect(order).toHaveLength(23);
  });

  it('orders by priority within a tenant lane', async () => {
    await enqueueToLane('t', 9, { requestId: 'low', tenantId: 't' });
    await enqueueToLane('t', 1, { requestId: 'high', tenantId: 't' });

    const ids: string[] = [];
    const stop = startFairScheduler(
      {
        getWaitingCount: async () => 0,
        add: async (_n: string, data: { requestId: string }) => {
          ids.push(data.requestId);
        },
      } as any,
      1
    );
    while (ids.length < 2) await new Promise((r) => setTimeout(r, 10));
    stop();
    expect(ids).toEqual(['high', 'low']);
  });

  it('removes tenants from the ring once their lane is empty', async () => {
    await enqueueToLane('a', 5, { requestId: 'a1', tenantId: 'a' });
    expect(await getLaneDepths()).toEqual({ a: 1 });
    await drain(1);
    expect(await getLaneDepths()).toEqual({});
    expect(await mockRedis.llen('fair:ring')).toBe(0);
  });
});
