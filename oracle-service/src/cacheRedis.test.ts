import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Redis-backed cache paths.
 *
 * `redis` is mocked rather than run against a real server so these run in CI
 * with no service dependency; the fake implements only the four commands the
 * cache uses.
 */

interface FakeRedis {
  store: Map<string, string>;
  connected: boolean;
  quit: ReturnType<typeof vi.fn>;
  on: ReturnType<typeof vi.fn>;
  connect: ReturnType<typeof vi.fn>;
  get: ReturnType<typeof vi.fn>;
  set: ReturnType<typeof vi.fn>;
  scan: ReturnType<typeof vi.fn>;
  del: ReturnType<typeof vi.fn>;
  handlers: Record<string, (arg: unknown) => void>;
}

let fake: FakeRedis;

function createFake(): FakeRedis {
  const store = new Map<string, string>();
  const handlers: Record<string, (arg: unknown) => void> = {};

  return {
    store,
    connected: false,
    handlers,
    on: vi.fn((event: string, handler: (arg: unknown) => void) => {
      handlers[event] = handler;
    }),
    connect: vi.fn(async function (this: FakeRedis) {
      fake.connected = true;
    }),
    quit: vi.fn(async () => {
      fake.connected = false;
    }),
    get: vi.fn(async (key: string) => store.get(key) ?? null),
    set: vi.fn(async (key: string, value: string) => {
      store.set(key, value);
      return 'OK';
    }),
    scan: vi.fn(async (cursor: number, opts: { MATCH: string; COUNT: number }) => {
      const prefix = opts.MATCH.replace(/\*$/, '');
      const keys = [...store.keys()].filter((key) => key.startsWith(prefix));
      return { cursor: 0, keys };
    }),
    del: vi.fn(async (keys: string[]) => {
      let removed = 0;
      for (const key of keys) {
        if (store.delete(key)) removed += 1;
      }
      return removed;
    }),
  };
}

vi.mock('redis', () => ({
  createClient: vi.fn(() => fake),
}));

const { buildOracleCacheKey, buildOraclePayerKeyPrefix, createOracleCache } = await import(
  './cache'
);
const { TEST_PAYER, makeResponse } = await import('./testFixtures');

const key = buildOracleCacheKey({ payer: TEST_PAYER, amount: '10000000', invoiceId: '42' });

beforeEach(() => {
  fake = createFake();
});

describe('redis cache backend', () => {
  it('connects when a redis url is supplied', async () => {
    const resolved = await createOracleCache({ redisUrl: 'redis://localhost:6379' });

    expect(resolved.kind).toBe('redis');
    expect(fake.connect).toHaveBeenCalled();

    await resolved.close();
    expect(fake.quit).toHaveBeenCalled();
  });

  it('falls back to memory when no redis url is supplied', async () => {
    const resolved = await createOracleCache({});

    expect(resolved.kind).toBe('memory');
    // close() on the memory backend is a no-op that must still resolve.
    await expect(resolved.close()).resolves.toBeUndefined();
  });

  it('round-trips a response through redis', async () => {
    const { cache } = await createOracleCache({ redisUrl: 'redis://localhost:6379' });
    const response = makeResponse({ trustScore: 77 });

    await cache.set(key, response, 60);
    expect(fake.set).toHaveBeenCalledWith(key, expect.any(String), { EX: 60 });

    const entry = await cache.get(key);
    expect(entry?.response.trustScore).toBe(77);
    expect(entry?.key).toBe(key);
  });

  it('returns null for a missing key', async () => {
    const { cache } = await createOracleCache({ redisUrl: 'redis://localhost:6379' });
    expect(await cache.get('oracle:v1:absent')).toBeNull();
  });

  it('returns null rather than throwing on corrupt JSON', async () => {
    const { cache } = await createOracleCache({ redisUrl: 'redis://localhost:6379' });
    fake.store.set(key, '{not json');

    expect(await cache.get(key)).toBeNull();
  });

  it('derives generatedAtMs from the response, falling back to now', async () => {
    const { cache } = await createOracleCache({ redisUrl: 'redis://localhost:6379' });

    await cache.set(key, makeResponse({ generatedAt: 'not-a-date' }), 60);
    const entry = await cache.get(key);

    expect(entry?.generatedAtMs).toBeGreaterThan(0);
  });

  it('invalidates every key for a payer by prefix scan', async () => {
    const { cache } = await createOracleCache({ redisUrl: 'redis://localhost:6379' });

    await cache.set(buildOracleCacheKey({ payer: TEST_PAYER, amount: '1', invoiceId: '1' }), makeResponse(), 60);
    await cache.set(buildOracleCacheKey({ payer: TEST_PAYER, amount: '2', invoiceId: '2' }), makeResponse(), 60);
    await cache.set('oracle:v1:someoneelse:1:1', makeResponse(), 60);

    const removed = await cache.invalidateByPrefix?.(buildOraclePayerKeyPrefix(TEST_PAYER));

    expect(removed).toBe(4);
    expect(fake.store.has('oracle:v1:someoneelse:1:1')).toBe(true);
  });

  it('handles an empty scan result without calling del', async () => {
    const { cache } = await createOracleCache({ redisUrl: 'redis://localhost:6379' });

    const removed = await cache.invalidateByPrefix?.('oracle:v1:nobody');

    expect(removed).toBe(0);
    expect(fake.del).not.toHaveBeenCalled();
  });

  it('logs redis errors rather than crashing the process', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    await createOracleCache({ redisUrl: 'redis://localhost:6379' });

    fake.handlers.error?.(new Error('connection reset'));

    expect(spy).toHaveBeenCalledWith('[oracle-cache] redis error', expect.any(Error));
    spy.mockRestore();
  });
});

describe('in-memory cache expiry', () => {
  it('drops an entry once its TTL has elapsed', async () => {
    vi.useFakeTimers();
    const { cache } = await createOracleCache({});

    await cache.set(key, makeResponse(), 1);
    expect(await cache.get(key)).not.toBeNull();

    vi.advanceTimersByTime(1_500);
    expect(await cache.get(key)).toBeNull();

    vi.useRealTimers();
  });

  it('returns null for a key that was never written', async () => {
    const { cache } = await createOracleCache({});
    expect(await cache.get('oracle:v1:never-written')).toBeNull();
  });
});
