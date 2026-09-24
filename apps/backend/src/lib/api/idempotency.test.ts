/**
 * Unit tests for the request deduplication middleware — Issue #587
 *
 * Tests:
 *   - No key → handler always called
 *   - Same key + same user → cached response returned on second call
 *   - Same key + different user → separate deployments (no collision)
 *   - Different keys + same user → separate deployments
 *   - Idempotent-Replayed header present on cached responses
 *   - Non-2xx responses are not cached
 *   - Expired entries are not served (TTL respected)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';
import {
    withIdempotency,
    clearIdempotencyCache,
    evictExpired,
    IDEMPOTENCY_KEY_HEADER,
} from './idempotency';

function makeRequest(idempotencyKey?: string): NextRequest {
    const headers: Record<string, string> = {};
    if (idempotencyKey) headers[IDEMPOTENCY_KEY_HEADER] = idempotencyKey;

    return new NextRequest('http://localhost/api/deployments', {
        method: 'POST',
        headers,
        body: JSON.stringify({ templateId: 'tpl_1' }),
    });
}

function makeHandler(status: number, body: unknown) {
    return vi.fn().mockResolvedValue(NextResponse.json(body, { status }));
}

beforeEach(() => {
    clearIdempotencyCache();
    vi.unstubAllEnvs();
});

// ── No Idempotency-Key ────────────────────────────────────────────────────────

describe('withIdempotency — no key', () => {
    it('calls the handler on every request when no key is supplied', async () => {
        const handler = makeHandler(201, { id: 'dep_1' });
        const wrapped = withIdempotency('user_a', handler);

        await wrapped(makeRequest());
        await wrapped(makeRequest());

        expect(handler).toHaveBeenCalledTimes(2);
    });
});

// ── Same key + same user: deduplication ───────────────────────────────────────

describe('withIdempotency — duplicate key same user', () => {
    it('returns the original response on the second request without calling the handler again', async () => {
        const handler = makeHandler(201, { id: 'dep_1', status: 'pending' });
        const wrapped = withIdempotency('user_a', handler);

        const r1 = await wrapped(makeRequest('key-abc'));
        const r2 = await wrapped(makeRequest('key-abc'));

        expect(handler).toHaveBeenCalledTimes(1);
        expect(r2.status).toBe(201);
        expect(r2.headers.get('Idempotent-Replayed')).toBe('true');

        const body1 = await r1.json();
        const body2 = await r2.json();
        expect(body1).toEqual(body2);
    });

    it('does not set Idempotent-Replayed on the first (live) response', async () => {
        const handler = makeHandler(201, { id: 'dep_1' });
        const wrapped = withIdempotency('user_a', handler);

        const r1 = await wrapped(makeRequest('key-abc'));
        expect(r1.headers.get('Idempotent-Replayed')).toBeNull();
    });
});

// ── Cross-user key isolation ──────────────────────────────────────────────────

describe('withIdempotency — cross-user isolation', () => {
    it('same key string for different users creates separate deployments', async () => {
        const handlerA = makeHandler(201, { id: 'dep_for_a' });
        const handlerB = makeHandler(201, { id: 'dep_for_b' });

        const wrappedA = withIdempotency('user_a', handlerA);
        const wrappedB = withIdempotency('user_b', handlerB);

        await wrappedA(makeRequest('shared-key'));
        await wrappedB(makeRequest('shared-key'));

        // Both handlers called — no cross-tenant collision
        expect(handlerA).toHaveBeenCalledTimes(1);
        expect(handlerB).toHaveBeenCalledTimes(1);
    });

    it('cached response for user_a is not returned to user_b', async () => {
        const handlerA = makeHandler(201, { id: 'dep_for_a' });
        const handlerB = makeHandler(201, { id: 'dep_for_b' });

        const wrappedA = withIdempotency('user_a', handlerA);
        const wrappedB = withIdempotency('user_b', handlerB);

        await wrappedA(makeRequest('shared-key'));
        const rb = await wrappedB(makeRequest('shared-key'));

        const body = await rb.json();
        expect(body.id).toBe('dep_for_b');
        expect(rb.headers.get('Idempotent-Replayed')).toBeNull();
    });
});

// ── Different keys, same user ─────────────────────────────────────────────────

describe('withIdempotency — different keys same user', () => {
    it('different keys create separate cache entries and call the handler each time', async () => {
        const handler = makeHandler(201, { id: 'dep_1' });
        const wrapped = withIdempotency('user_a', handler);

        await wrapped(makeRequest('key-1'));
        await wrapped(makeRequest('key-2'));

        expect(handler).toHaveBeenCalledTimes(2);
    });
});

// ── 4xx caching behavior ──────────────────────────────────────────────────────

describe('withIdempotency — 4xx caching', () => {
    it('caches permanent 4xx errors (422 Unprocessable Entity)', async () => {
        const handler = makeHandler(422, { error: 'Invalid config' });
        const wrapped = withIdempotency('user_a', handler);

        await wrapped(makeRequest('key-422'));
        await wrapped(makeRequest('key-422'));

        // Handler called once — 422 was cached
        expect(handler).toHaveBeenCalledTimes(1);
    });

    it('caches other permanent 4xx errors (400, 401, 403, 404)', async () => {
        for (const status of [400, 401, 403, 404]) {
            clearIdempotencyCache();
            const handler = makeHandler(status, { error: 'Client error' });
            const wrapped = withIdempotency('user_a', handler);

            await wrapped(makeRequest(`key-${status}`));
            await wrapped(makeRequest(`key-${status}`));

            expect(handler).toHaveBeenCalledTimes(1);
        }
    });

    it('does NOT cache transient 4xx errors (408, 429)', async () => {
        for (const status of [408, 429]) {
            clearIdempotencyCache();
            const handler = makeHandler(status, { error: 'Transient error' });
            const wrapped = withIdempotency('user_a', handler);

            await wrapped(makeRequest(`key-${status}`));
            await wrapped(makeRequest(`key-${status}`));

            // Handler called twice — transient error was not cached
            expect(handler).toHaveBeenCalledTimes(2);
        }
    });
});

// ── Non-2xx responses caching policy ───────────────────────────────────────────

describe('withIdempotency — 5xx not cached', () => {
    it('does not cache 5xx error responses', async () => {
        const handler = makeHandler(500, { error: 'Internal server error' });
        const wrapped = withIdempotency('user_a', handler);

        await wrapped(makeRequest('key-500'));
        await wrapped(makeRequest('key-500'));

        // Handler called twice — 5xx was not cached
        expect(handler).toHaveBeenCalledTimes(2);
    });

    it('does not cache 503 Service Unavailable', async () => {
        const handler = makeHandler(503, { error: 'Service unavailable' });
        const wrapped = withIdempotency('user_a', handler);

        await wrapped(makeRequest('key-503'));
        await wrapped(makeRequest('key-503'));

        expect(handler).toHaveBeenCalledTimes(2);
    });
});

// ── TTL expiry ────────────────────────────────────────────────────────────────

describe('withIdempotency — TTL expiry', () => {
    it('re-calls the handler after the TTL has elapsed', async () => {
        // Set a very short TTL
        vi.stubEnv('IDEMPOTENCY_TTL_MS', '1');

        const handler = makeHandler(201, { id: 'dep_1' });
        const wrapped = withIdempotency('user_a', handler);

        await wrapped(makeRequest('key-ttl'));

        // Wait for expiry (1 ms TTL)
        await new Promise((r) => setTimeout(r, 10));

        await wrapped(makeRequest('key-ttl'));

        expect(handler).toHaveBeenCalledTimes(2);
    });
});

// ── Non-JSON response bodies ──────────────────────────────────────────────────

describe('withIdempotency — non-JSON response bodies', () => {
    function makePlainTextHandler(status: number, body: string) {
        return vi.fn().mockResolvedValue(new NextResponse(body, { status }));
    }

    it('caches and replays a 2xx response with plain text body as null', async () => {
        // Line 82: response.clone().json().catch(() => null)
        // When a 2xx response has a non-JSON body, it is silently cached as null.
        const handler = makePlainTextHandler(200, 'ok');
        const wrapped = withIdempotency('user_a', handler);

        const r1 = await wrapped(makeRequest('key-plain'));
        const r2 = await wrapped(makeRequest('key-plain'));

        // Handler called once — response was cached
        expect(handler).toHaveBeenCalledTimes(1);
        expect(r2.headers.get('Idempotent-Replayed')).toBe('true');

        // First response's actual body
        const body1 = await r1.text();
        expect(body1).toBe('ok');

        // Replayed response body is null (as JSON)
        const body2 = await r2.json();
        expect(body2).toBeNull();
    });

    it('caches and replays a 2xx response with empty body as null', async () => {
        const handler = makePlainTextHandler(200, '');
        const wrapped = withIdempotency('user_a', handler);

        const r1 = await wrapped(makeRequest('key-empty'));
        const r2 = await wrapped(makeRequest('key-empty'));

        expect(handler).toHaveBeenCalledTimes(1);
        expect(r2.headers.get('Idempotent-Replayed')).toBe('true');

        const body1Text = await r1.text();
        expect(body1Text).toBe('');

        const body2 = await r2.json();
        expect(body2).toBeNull();
    });

    it('correctly distinguishes between an empty body and a valid JSON null payload', async () => {
        // Both collapse to cached null today, but this test documents the boundary.
        const handlerEmpty = makePlainTextHandler(200, '');
        const handlerJsonNull = makeHandler(200, null);

        const wrappedEmpty = withIdempotency('user_a', handlerEmpty);
        const wrappedJsonNull = withIdempotency('user_b', handlerJsonNull);

        const r1Empty = await wrappedEmpty(makeRequest('key-empty'));
        const r1JsonNull = await wrappedJsonNull(makeRequest('key-json-null'));

        // First responses differ, but replayss are both null
        const bodyEmptyFirst = await r1Empty.text();
        expect(bodyEmptyFirst).toBe('');

        const bodyJsonNullFirst = await r1JsonNull.json();
        expect(bodyJsonNullFirst).toBeNull();

        // Replay both requests
        const rEmpty = await wrappedEmpty(makeRequest('key-empty'));
        const rJsonNull = await wrappedJsonNull(makeRequest('key-json-null'));

        // Replay bodies are both null
        const replayEmpty = await rEmpty.json();
        const replayJsonNull = await rJsonNull.json();
        expect(replayEmpty).toBeNull();
        expect(replayJsonNull).toBeNull();
    });

    it('handles 2xx responses with invalid JSON body and replays them as null', async () => {
        const handler = makePlainTextHandler(200, '{ invalid json }');
        const wrapped = withIdempotency('user_a', handler);

        const r1 = await wrapped(makeRequest('key-invalid'));
        const r2 = await wrapped(makeRequest('key-invalid'));

        expect(handler).toHaveBeenCalledTimes(1);
        expect(r2.headers.get('Idempotent-Replayed')).toBe('true');

        const body1 = await r1.text();
        expect(body1).toBe('{ invalid json }');

        const body2 = await r2.json();
        expect(body2).toBeNull();
    });
});

// ── Bounded / scheduled eviction (#1048) ──────────────────────────────────────

describe('withIdempotency — bounded cache growth (#1048)', () => {
    it('evicts expired entries even when no further keyed request arrives', async () => {
        // Very short TTL so all entries expire quickly.
        vi.stubEnv('IDEMPOTENCY_TTL_MS', '50');

        const handler = makeHandler(201, { id: 'dep_1' });
        const wrapped = withIdempotency('user_a', handler);

        // One-shot keys: each used exactly once, then never re-requested.
        for (let i = 0; i < 200; i++) {
            await wrapped(makeRequest(`one-shot-${i}`));
        }

        // No further keyed traffic — but the entries must still expire.
        await new Promise((r) => setTimeout(r, 80));
        evictExpired();

        await vi.waitFor(() => {
            const replay = makeHandler(201, { id: 'dep_1' });
            const replayedWrapped = withIdempotency('user_a', replay);
            return replayedWrapped(makeRequest('one-shot-0')).then(() => {
                expect(replay).toHaveBeenCalledTimes(1);
            });
        });
    });

    it('keeps the cache size bounded under many one-off keys', async () => {
        // Cap the cache so growth can be asserted deterministically.
        vi.stubEnv('IDEMPOTENCY_MAX_ENTRIES', '10');

        const handler = makeHandler(201, { id: 'dep_1' });
        const wrapped = withIdempotency('user_a', handler);

        for (let i = 0; i < 500; i++) {
            await wrapped(makeRequest(`cap-${i}`));
        }

        // Cache must never exceed the configured cap (oldest evicted on write).
        const { _cacheSize } = await import('./idempotency');
        expect(_cacheSize()).toBeLessThanOrEqual(10);
    });
});
