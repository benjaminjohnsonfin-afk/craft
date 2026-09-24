/**
 * Request deduplication middleware using client-supplied idempotency keys.
 *
 * Reads the `Idempotency-Key` header on incoming requests. When a key is
 * present and a response for the same (userId, key) pair has been stored
 * within the TTL window, the cached response is returned immediately without
 * executing the handler again.
 *
 * Cache entries are scoped per authenticated user — keys from different users
 * never collide even if the raw key string is identical.
 *
 * Caching policy:
 *   - 2xx (200-299): Always cached (successful responses)
 *   - 4xx (400-499): Cached for permanent client errors (400, 401, 403, 404, 422, etc.)
 *                    NOT cached for transient errors (408, 429)
 *   - 5xx (500-599): Never cached (transient server errors that may succeed on retry)
 *
 * Configuration:
 *   IDEMPOTENCY_TTL_MS      — Cache TTL in milliseconds. Default: 86_400_000 (24 h)
 *   IDEMPOTENCY_MAX_ENTRIES — Hard cap on cached entries; when exceeded the
 *                             oldest entry (by storedAt) is evicted. Default: 10_000
 *   IDEMPOTENCY_SWEEP_MS    — Interval at which a background sweep evicts
 *                             expired entries independently of new keyed
 *                             requests, bounding memory even for one-shot keys.
 *                             Default: 60_000 (60 s). Disabled under NODE_ENV=test.
 *
 * Eviction strategy:
 *   - Every keyed request that misses the cache prunes expired entries first
 *     (lazy sweep), so a hot key never accumulates stale data.
 *   - A periodic background sweep runs on an interval to evict entries that
 *     have fully expired even when no further request arrives on that key
 *     (the common one-shot checkout case), preventing unbounded growth.
 *   - A max-size cap provides a hard backstop: if the sweep lags, the oldest
 *     stored entry is evicted on write.
 *
 * Usage:
 *   const handler = withIdempotency(userId, async (req) => { ... });
 *   return handler(req);
 *
 * See "Rate Limiting, Idempotency, and Tier Enforcement" in CONTRIBUTING.md
 * for the full env-var reference.
 */

import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

export const IDEMPOTENCY_KEY_HEADER = 'idempotency-key';

interface CachedResponse {
    status: number;
    body: unknown;
    storedAt: number;
}

// Module-level cache: survives across requests within a process.
const cache = new Map<string, CachedResponse>();

function ttlMs(): number {
    const val = parseInt(process.env.IDEMPOTENCY_TTL_MS ?? '86400000', 10);
    return Number.isFinite(val) && val > 0 ? val : 86_400_000;
}

function maxEntries(): number {
    const val = parseInt(process.env.IDEMPOTENCY_MAX_ENTRIES ?? '10000', 10);
    return Number.isFinite(val) && val > 0 ? val : 10_000;
}

function sweepIntervalMs(): number {
    const val = parseInt(process.env.IDEMPOTENCY_SWEEP_MS ?? '60000', 10);
    return Number.isFinite(val) && val > 0 ? val : 60_000;
}

function cacheKey(userId: string, idempotencyKey: string): string {
    return `${userId}:${idempotencyKey}`;
}

/**
 * Determine if a response status code should be cached.
 * - 2xx: Always cached (success)
 * - 4xx: Cached for permanent errors (400, 401, 403, 404, 422, etc.)
 *        NOT cached for transient errors (408, 429)
 * - 5xx: Never cached (transient server errors)
 */
function shouldCacheResponse(status: number): boolean {
    if (status >= 200 && status < 300) return true;
    if (status >= 400 && status < 500) {
        const transientClientErrors = new Set([408, 429]);
        return !transientClientErrors.has(status);
    }
    return false;
}

/** Remove every cache entry whose TTL has elapsed. */
export function evictExpired(): void {
    const now = Date.now();
    const ttl = ttlMs();
    for (const [key, entry] of cache) {
        if (now - entry.storedAt > ttl) cache.delete(key);
    }
}

/**
 * Bound the cache size by evicting the oldest entry when over the cap. Used as
 * a backstop so memory stays bounded even if the periodic sweep has not yet
 * reclaimed entries.
 */
function enforceMaxSize(): void {
    const cap = maxEntries();
    if (cache.size <= cap) return;
    let oldestKey: string | null = null;
    let oldestTime = Infinity;
    for (const [key, entry] of cache) {
        if (entry.storedAt < oldestTime) {
            oldestTime = entry.storedAt;
            oldestKey = key;
        }
    }
    if (oldestKey) cache.delete(oldestKey);
}

// ── Periodic sweep ────────────────────────────────────────────────────────────
// Evicts expired entries on a timer so the cache cannot grow without bound for
// one-shot keys that are never re-requested. Disabled under test environments
// to avoid open-handle leaks in the test runner.

let sweepHandle: ReturnType<typeof setInterval> | null = null;

function startSweep(): void {
    if (sweepHandle) return;
    if (process.env.NODE_ENV === 'test' || process.env.VITEST) return;
    sweepHandle = setInterval(() => {
        evictExpired();
    }, sweepIntervalMs());
}

export type IdempotentHandler = (req: NextRequest) => Promise<NextResponse>;

/**
 * Wrap a handler with idempotency deduplication.
 * If the request carries an `Idempotency-Key` header and a cached response
 * exists for (userId, key), returns the cached response. Otherwise executes
 * the handler and caches a 2xx response.
 */
export function withIdempotency(
    userId: string,
    handler: IdempotentHandler,
): IdempotentHandler {
    return async (req: NextRequest): Promise<NextResponse> => {
        startSweep();
        const rawKey = req.headers.get(IDEMPOTENCY_KEY_HEADER);
        if (!rawKey) return handler(req);

        evictExpired();

        const key = cacheKey(userId, rawKey);
        const cached = cache.get(key);

        if (cached && Date.now() - cached.storedAt <= ttlMs()) {
            return NextResponse.json(cached.body, {
                status: cached.status,
                headers: { 'Idempotent-Replayed': 'true' },
            });
        }

        const response = await handler(req);

        if (shouldCacheResponse(response.status)) {
            const body = await response.clone().json().catch(() => null);
            if (cache.size >= maxEntries()) evictExpired();
            cache.set(key, { status: response.status, body, storedAt: Date.now() });
            enforceMaxSize();
        }

        return response;
    };
}

/** Exposed for testing — clears all cached entries. */
export function clearIdempotencyCache(): void {
    cache.clear();
}

/** Exposed for testing — returns the current number of cached entries. */
export function _cacheSize(): number {
    return cache.size;
}
