import { idempotencyMiddleware } from '../../src/middleware/idempotency.middleware';

class MockRedisStore {
  private store = new Map<string, { value: string; ttl: number }>();

  async set(key: string, value: string, opt1?: string, ttl?: number, opt2?: string): Promise<'OK' | null> {
    if (opt2 === 'NX' && this.store.has(key)) {
      return null;
    }
    this.store.set(key, { value, ttl: ttl ?? 86400 });
    return 'OK';
  }

  async get(key: string): Promise<string | null> {
    const item = this.store.get(key);
    return item ? item.value : null;
  }

  async del(key: string): Promise<number> {
    return this.store.delete(key) ? 1 : 0;
  }
}

const mockRedis = new MockRedisStore();

jest.mock('../../src/db/redis', () => ({
  getRedis: () => mockRedis,
}));

describe('Idempotency-Key Middleware', () => {
  let req: any;
  let res: any;
  let next: jest.Mock;

  beforeEach(() => {
    req = {
      headers: {
        'idempotency-key': 'test-uuid-key-12345',
      },
      tenant: { id: 'tenant-abc' },
    };

    res = {
      statusCode: 200,
      headers: {},
      setHeader: jest.fn((k: string, v: string) => {
        res.headers[k] = v;
      }),
      status: jest.fn((code: number) => {
        res.statusCode = code;
        return res;
      }),
      json: jest.fn((data: any) => data),
    };

    next = jest.fn();
  });

  it('passes through and caches response when new Idempotency-Key is supplied', async () => {
    await idempotencyMiddleware(req, res, next);
    expect(next).toHaveBeenCalled();

    // Simulate completion
    const responseData = { requestId: 'req-1', message: 'Success' };
    res.json(responseData);

    // Verify key in Redis
    const cached = await mockRedis.get('idempotency:tenant-abc:test-uuid-key-12345');
    expect(cached).not.toBeNull();
    expect(JSON.parse(cached!).body).toEqual(responseData);
  });

  it('returns cached response directly on duplicate Idempotency-Key', async () => {
    // Populate cache first
    await mockRedis.set(
      'idempotency:tenant-abc:duplicate-key-99',
      JSON.stringify({
        status: 'COMPLETED',
        statusCode: 200,
        headers: {},
        body: { requestId: 'cached-req-99', responseText: 'Cached result' },
        savedAt: new Date().toISOString(),
      })
    );

    req.headers['idempotency-key'] = 'duplicate-key-99';

    await idempotencyMiddleware(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.setHeader).toHaveBeenCalledWith('X-Cache-Lookup', 'HIT (Idempotent)');
    expect(res.json).toHaveBeenCalledWith({
      requestId: 'cached-req-99',
      responseText: 'Cached result',
    });
  });

  it('returns 409 Conflict when concurrent request with same Idempotency-Key is IN_PROGRESS', async () => {
    await mockRedis.set('idempotency:tenant-abc:in-progress-key', 'IN_PROGRESS');

    req.headers['idempotency-key'] = 'in-progress-key';

    await idempotencyMiddleware(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        error: 'Idempotency Conflict',
      })
    );
  });
});
