import crypto from 'crypto';
import { getRedis } from '../db/redis';
import { logger } from './logger';

// ─────────────────────────────────────────────
// Tenant API key helpers
//
// Keys are never stored in plaintext. Postgres stores SHA-256(key) in
// tenants.api_key_hash, plus a short non-secret prefix for identification.
// SHA-256 (rather than bcrypt/argon2) is appropriate here because keys are
// 256-bit random values — brute force is infeasible, and a fast hash allows
// an indexed equality lookup on every request.
// ─────────────────────────────────────────────

const KEY_PREFIX = 'gw_';
const DISPLAY_PREFIX_LENGTH = 11; // "gw_" + 8 chars

const CACHE_PREFIX = 'apikey:';
const POSITIVE_TTL_SECONDS = Number(process.env.API_KEY_CACHE_TTL_SECONDS) || 300;
const NEGATIVE_TTL_SECONDS = 60;
const NEGATIVE_SENTINEL = '__invalid__';

export interface CachedTenant {
  id: string;
  name: string;
  tpmLimit: number;
  rpmLimit: number;
}

/** Generate a new cryptographically secure API key, e.g. `gw_Xb3k...` */
export function generateApiKey(): { apiKey: string; hash: string; prefix: string } {
  const apiKey = KEY_PREFIX + crypto.randomBytes(32).toString('base64url');
  return {
    apiKey,
    hash: hashApiKey(apiKey),
    prefix: apiKey.slice(0, DISPLAY_PREFIX_LENGTH),
  };
}

/** SHA-256 hex digest (64 chars) of a raw API key. */
export function hashApiKey(apiKey: string): string {
  return crypto.createHash('sha256').update(apiKey, 'utf8').digest('hex');
}

/**
 * Look up a tenant in the Redis cache by key hash.
 * Returns:
 *   - CachedTenant  → cache hit, valid key
 *   - null          → cache hit, known-invalid key (negative cache)
 *   - undefined     → cache miss or Redis unavailable (caller must query DB)
 */
export async function getCachedTenant(hash: string): Promise<CachedTenant | null | undefined> {
  try {
    const raw = await getRedis().get(CACHE_PREFIX + hash);
    if (raw === null) return undefined;
    if (raw === NEGATIVE_SENTINEL) return null;
    return JSON.parse(raw) as CachedTenant;
  } catch (err) {
    // Fail open to the database — Redis outage must not break auth.
    logger.warn('API key cache read failed', { error: (err as Error).message });
    return undefined;
  }
}

/** Cache a valid tenant, or a negative result when tenant is null. */
export async function cacheTenant(hash: string, tenant: CachedTenant | null): Promise<void> {
  try {
    if (tenant) {
      await getRedis().setex(CACHE_PREFIX + hash, POSITIVE_TTL_SECONDS, JSON.stringify(tenant));
    } else {
      await getRedis().setex(CACHE_PREFIX + hash, NEGATIVE_TTL_SECONDS, NEGATIVE_SENTINEL);
    }
  } catch (err) {
    logger.warn('API key cache write failed', { error: (err as Error).message });
  }
}

/**
 * Remove a cached entry. Call this whenever a tenant is deactivated,
 * its limits change, or its key is rotated.
 */
export async function invalidateApiKeyCache(hash: string): Promise<void> {
  try {
    await getRedis().del(CACHE_PREFIX + hash);
  } catch (err) {
    logger.warn('API key cache invalidation failed', { error: (err as Error).message });
  }
}
