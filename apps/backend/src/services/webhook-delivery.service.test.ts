// @vitest-environment node
/**
 * WebhookDeliveryService Tests
 *
 * Tests persistent webhook delivery tracking for idempotency and replay.
 *
 * Run: vitest run src/services/webhook-delivery.service.test.ts
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { WebhookDeliveryService } from './webhook-delivery.service';

// ── Mock Supabase ─────────────────────────────────────────────────────────────

const mockRpc = vi.fn();
const mockFrom = vi.fn();
const mockSelect = vi.fn();
const mockInsert = vi.fn();
const mockUpdate = vi.fn();
const mockEq = vi.fn();
const mockOrder = vi.fn();
const mockLimit = vi.fn();
const mockSingle = vi.fn();

vi.mock('@/lib/supabase/server', () => ({
    createClient: vi.fn(() => ({
        rpc: mockRpc,
        from: mockFrom,
    })),
}));

// ── Setup ─────────────────────────────────────────────────────────────────────

beforeEach(() => {
    vi.clearAllMocks();

    // Default mock chain setup
    mockFrom.mockReturnValue({
        select: mockSelect,
        insert: mockInsert,
        update: mockUpdate,
    });

    mockSelect.mockReturnValue({
        eq: mockEq,
        order: mockOrder,
        limit: mockLimit,
    });

    mockInsert.mockReturnValue({
        select: mockSelect,
    });

    mockUpdate.mockReturnValue({
        eq: mockEq,
    });

    mockEq.mockReturnValue({
        single: mockSingle,
        select: mockSelect,
    });

    mockOrder.mockReturnValue({
        limit: mockLimit,
    });

    mockLimit.mockResolvedValue({
        data: [],
        error: null,
    });

    mockSingle.mockResolvedValue({
        data: null,
        error: null,
    });
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('WebhookDeliveryService', () => {
    describe('recordDelivery', () => {
        it('records a new delivery successfully with installation scoping', async () => {
            const service = new WebhookDeliveryService();

            const mockDelivery = {
                id: 'uuid-1',
                delivery_id: 'del-123',
                installation_id: 12345,
                event_type: 'push',
                payload: { ref: 'refs/heads/main' },
                headers: { 'x-github-event': 'push' },
                status: 'received',
                created_at: '2024-01-01T00:00:00Z',
                updated_at: '2024-01-01T00:00:00Z',
            };

            mockRpc.mockResolvedValue({ data: mockDelivery, error: null });

            const result = await service.recordDelivery({
                deliveryId: 'del-123',
                installationId: 12345,
                eventType: 'push',
                payload: { ref: 'refs/heads/main' },
                headers: { 'x-github-event': 'push' },
            });

            expect(result.success).toBe(true);
            expect(result.delivery).toBeDefined();
            expect(result.delivery?.deliveryId).toBe('del-123');
            expect(result.delivery?.installationId).toBe(12345);
            expect(result.delivery?.eventType).toBe('push');
            expect(mockRpc).toHaveBeenCalledWith('record_webhook_delivery', {
                p_delivery_id: 'del-123',
                p_installation_id: 12345,
                p_event_type: 'push',
                p_payload: { ref: 'refs/heads/main' },
                p_headers: { 'x-github-event': 'push' },
            });
        });

        it('handles duplicate delivery (conflict)', async () => {
            const service = new WebhookDeliveryService();

            mockRpc.mockResolvedValue({
                data: null,
                error: { code: '23505', message: 'duplicate key value' },
            });

            const result = await service.recordDelivery({
                deliveryId: 'del-123',
                eventType: 'push',
                payload: {},
                headers: {},
            });

            expect(result.success).toBe(true);
            expect(result.alreadyExists).toBe(true);
        });

        it('handles database error', async () => {
            const service = new WebhookDeliveryService();

            mockRpc.mockResolvedValue({
                data: null,
                error: { code: 'PGRST116', message: 'Database error' },
            });

            const result = await service.recordDelivery({
                deliveryId: 'del-123',
                eventType: 'push',
                payload: {},
                headers: {},
            });

            expect(result.success).toBe(false);
            expect(result.error).toBe('Database error');
        });

        it('handles null data (ON CONFLICT DO NOTHING)', async () => {
            const service = new WebhookDeliveryService();

            mockRpc.mockResolvedValue({ data: null, error: null });

            const result = await service.recordDelivery({
                deliveryId: 'del-123',
                eventType: 'push',
                payload: {},
                headers: {},
            });

            expect(result.success).toBe(true);
            expect(result.alreadyExists).toBe(true);
        });
    });

    describe('markProcessed', () => {
        it('marks a delivery as processed', async () => {
            const service = new WebhookDeliveryService();

            mockRpc.mockResolvedValue({ data: null, error: null });

            const result = await service.markProcessed('del-123');

            expect(result.success).toBe(true);
            expect(mockRpc).toHaveBeenCalledWith('mark_delivery_processed', {
                p_delivery_id: 'del-123',
            });
        });

        it('handles database error', async () => {
            const service = new WebhookDeliveryService();

            mockRpc.mockResolvedValue({
                data: null,
                error: { message: 'Database error' },
            });

            const result = await service.markProcessed('del-123');

            expect(result.success).toBe(false);
            expect(result.error).toBe('Database error');
        });
    });

    describe('markFailed', () => {
        it('marks a delivery as failed with error message', async () => {
            const service = new WebhookDeliveryService();

            mockRpc.mockResolvedValue({ data: null, error: null });

            const result = await service.markFailed('del-123', 'Processing failed');

            expect(result.success).toBe(true);
            expect(mockRpc).toHaveBeenCalledWith('mark_delivery_failed', {
                p_delivery_id: 'del-123',
                p_error_message: 'Processing failed',
            });
        });

        it('handles database error', async () => {
            const service = new WebhookDeliveryService();

            mockRpc.mockResolvedValue({
                data: null,
                error: { message: 'Database error' },
            });

            const result = await service.markFailed('del-123', 'Processing failed');

            expect(result.success).toBe(false);
            expect(result.error).toBe('Database error');
        });
    });

    describe('hasReceivedDelivery', () => {
        it('returns true when delivery exists', async () => {
            const service = new WebhookDeliveryService();

            mockRpc.mockResolvedValue({ data: true, error: null });

            const result = await service.hasReceivedDelivery('del-123');

            expect(result.received).toBe(true);
            expect(mockRpc).toHaveBeenCalledWith('has_received_delivery', {
                p_delivery_id: 'del-123',
            });
        });

        it('returns false when delivery does not exist', async () => {
            const service = new WebhookDeliveryService();

            mockRpc.mockResolvedValue({ data: false, error: null });

            const result = await service.hasReceivedDelivery('del-123');

            expect(result.received).toBe(false);
        });

        it('handles database error', async () => {
            const service = new WebhookDeliveryService();

            mockRpc.mockResolvedValue({
                data: null,
                error: { message: 'Database error' },
            });

            const result = await service.hasReceivedDelivery('del-123');

            expect(result.received).toBe(false);
            expect(result.error).toBe('Database error');
        });
    });

    describe('getDeliveriesForReplay', () => {
        it('returns failed and missed deliveries', async () => {
            const service = new WebhookDeliveryService();

            const mockDeliveries = [
                {
                    delivery_id: 'del-failed-1',
                    event_type: 'push',
                    payload: { ref: 'refs/heads/main' },
                    headers: { 'x-github-event': 'push' },
                    source: 'failed',
                },
                {
                    delivery_id: 'del-missed-1',
                    event_type: 'installation',
                    payload: null,
                    headers: null,
                    source: 'missed',
                },
            ];

            mockRpc.mockResolvedValue({ data: mockDeliveries, error: null });

            const result = await service.getDeliveriesForReplay();

            expect(result.success).toBe(true);
            expect(result.deliveries).toHaveLength(2);
            expect(result.deliveries?.[0].deliveryId).toBe('del-failed-1');
            expect(result.deliveries?.[0].source).toBe('failed');
            expect(result.deliveries?.[1].deliveryId).toBe('del-missed-1');
            expect(result.deliveries?.[1].source).toBe('missed');
        });

        it('returns empty array when no deliveries need replay', async () => {
            const service = new WebhookDeliveryService();

            mockRpc.mockResolvedValue({ data: [], error: null });

            const result = await service.getDeliveriesForReplay();

            expect(result.success).toBe(true);
            expect(result.deliveries).toHaveLength(0);
        });

        it('handles database error', async () => {
            const service = new WebhookDeliveryService();

            mockRpc.mockResolvedValue({
                data: null,
                error: { message: 'Database error' },
            });

            const result = await service.getDeliveriesForReplay();

            expect(result.success).toBe(false);
            expect(result.error).toBe('Database error');
        });
    });

    describe('replayDelivery', () => {
        it('creates a new delivery for replay scoped to installation', async () => {
            const service = new WebhookDeliveryService();

            const originalDelivery = {
                id: 'uuid-1',
                delivery_id: 'del-original',
                installation_id: 12345,
                event_type: 'push',
                payload: { ref: 'refs/heads/main' },
                headers: { 'x-github-event': 'push' },
                status: 'failed',
            };

            const replayedDelivery = {
                id: 'uuid-2',
                delivery_id: 'replay-123-abc',
                installation_id: 12345,
                event_type: 'push',
                payload: { ref: 'refs/heads/main' },
                headers: { 'x-github-event': 'push' },
                status: 'received',
                replayed_from_delivery_id: 'del-original',
            };

            // Mock getting original delivery
            mockFrom.mockReturnValueOnce({
                select: vi.fn().mockReturnValue({
                    eq: vi.fn().mockReturnValue({
                        single: vi.fn().mockResolvedValue({
                            data: originalDelivery,
                            error: null,
                        }),
                    }),
                }),
            });

            // Mock inserting replay delivery
            mockFrom.mockReturnValueOnce({
                insert: vi.fn().mockReturnValue({
                    select: vi.fn().mockReturnValue({
                        single: vi.fn().mockResolvedValue({
                            data: replayedDelivery,
                            error: null,
                        }),
                    }),
                }),
            });

            const result = await service.replayDelivery('del-original', 12345);

            expect(result.success).toBe(true);
            expect(result.newDeliveryId).toMatch(/^replay-/);
        });

        it('produces a replay-<timestamp>-<8charhex> style delivery ID', async () => {
            const service = new WebhookDeliveryService();

            const originalDelivery = {
                id: 'uuid-1',
                delivery_id: 'del-original',
                installation_id: 12345,
                event_type: 'push',
                payload: {},
                headers: {},
                status: 'failed',
            };

            const replayedDelivery = {
                id: 'uuid-2',
                delivery_id: 'replay-placeholder',
                installation_id: 12345,
                event_type: 'push',
                payload: {},
                headers: {},
                status: 'received',
                replayed_from_delivery_id: 'del-original',
            };

            mockFrom.mockReturnValueOnce({
                select: vi.fn().mockReturnValue({
                    eq: vi.fn().mockReturnValue({
                        single: vi.fn().mockResolvedValue({
                            data: originalDelivery,
                            error: null,
                        }),
                    }),
                }),
            });

            const insertMock = vi.fn().mockReturnValue({
                select: vi.fn().mockReturnValue({
                    single: vi.fn().mockResolvedValue({
                        data: replayedDelivery,
                        error: null,
                    }),
                }),
            });
            mockFrom.mockReturnValueOnce({
                insert: insertMock,
            });

            const before = Date.now();
            const result = await service.replayDelivery('del-original', 12345);
            const after = Date.now();

            expect(result.success).toBe(true);
            expect(result.newDeliveryId).toBeDefined();
            const id = result.newDeliveryId!;
            expect(id.startsWith('replay-')).toBe(true);
            const parts = id.split('-');
            expect(parts.length).toBe(3);
            const timestamp = Number(parts[1]);
            expect(timestamp).toBeGreaterThanOrEqual(before);
            expect(timestamp).toBeLessThanOrEqual(after);
            expect(parts[2].length).toBe(8);
            expect(/^[0-9a-f]{8}$/.test(parts[2])).toBe(true);
        });

        it('handles original delivery not found', async () => {
            const service = new WebhookDeliveryService();

            mockFrom.mockReturnValueOnce({
                select: vi.fn().mockReturnValue({
                    eq: vi.fn().mockReturnValue({
                        single: vi.fn().mockResolvedValue({
                            data: null,
                            error: { message: 'Not found' },
                        }),
                    }),
                }),
            });

            const result = await service.replayDelivery('del-nonexistent', 12345);

            expect(result.success).toBe(false);
            expect(result.error).toBe('Original delivery not found');
        });

        it('does not replay delivery from different installation', async () => {
            const service = new WebhookDeliveryService();

            mockFrom.mockReturnValueOnce({
                select: vi.fn().mockReturnValue({
                    eq: vi.fn().mockReturnValue({
                        single: vi.fn().mockResolvedValue({
                            data: null,
                            error: { message: 'Not found' },
                        }),
                    }),
                }),
            });

            const result = await service.replayDelivery('del-123', 99999);

            expect(result.success).toBe(false);
            expect(result.error).toBe('Original delivery not found');
        });

        it('handles insert error during replay', async () => {
            const service = new WebhookDeliveryService();

            const originalDelivery = {
                id: 'uuid-1',
                delivery_id: 'del-original',
                installation_id: 12345,
                event_type: 'push',
                payload: {},
                headers: {},
                status: 'failed',
            };

            mockFrom.mockReturnValueOnce({
                select: vi.fn().mockReturnValue({
                    eq: vi.fn().mockReturnValue({
                        single: vi.fn().mockResolvedValue({
                            data: originalDelivery,
                            error: null,
                        }),
                    }),
                }),
            });

            mockFrom.mockReturnValueOnce({
                insert: vi.fn().mockReturnValue({
                    select: vi.fn().mockReturnValue({
                        single: vi.fn().mockResolvedValue({
                            data: null,
                            error: { message: 'Insert failed' },
                        }),
                    }),
                }),
            });

            const result = await service.replayDelivery('del-original', 12345);

            expect(result.success).toBe(false);
            expect(result.error).toBe('Insert failed');
        });
    });

    describe('getDelivery', () => {
        it('retrieves a delivery by delivery ID scoped to installation', async () => {
            const service = new WebhookDeliveryService();

            const mockDelivery = {
                id: 'uuid-1',
                delivery_id: 'del-123',
                installation_id: 12345,
                event_type: 'push',
                payload: {},
                headers: {},
                status: 'processed',
                created_at: '2024-01-01T00:00:00Z',
                updated_at: '2024-01-01T00:00:00Z',
            };

            mockSingle.mockResolvedValue({ data: mockDelivery, error: null });

            const result = await service.getDelivery('del-123', 12345);

            expect(result).toBeDefined();
            expect(result?.deliveryId).toBe('del-123');
            expect(result?.installationId).toBe(12345);
            expect(result?.status).toBe('processed');
            expect(mockEq).toHaveBeenCalledWith('installation_id', 12345);
        });

        it('returns null when delivery not found', async () => {
            const service = new WebhookDeliveryService();

            mockSingle.mockResolvedValue({ data: null, error: { message: 'Not found' } });

            const result = await service.getDelivery('del-nonexistent', 12345);

            expect(result).toBeNull();
        });

        it('does not return a delivery belonging to a different installation', async () => {
            const service = new WebhookDeliveryService();

            mockSingle.mockResolvedValue({ data: null, error: { message: 'Not found' } });

            const result = await service.getDelivery('del-123', 99999);

            expect(result).toBeNull();
            expect(mockEq).toHaveBeenCalledWith('installation_id', 99999);
        });
    });

    describe('getRecentDeliveries', () => {
        it('retrieves recent deliveries scoped to installation with default limit', async () => {
            const service = new WebhookDeliveryService();

            const mockDeliveries = [
                {
                    id: 'uuid-1',
                    delivery_id: 'del-1',
                    installation_id: 12345,
                    event_type: 'push',
                    payload: {},
                    headers: {},
                    status: 'processed',
                    created_at: '2024-01-01T00:00:00Z',
                    updated_at: '2024-01-01T00:00:00Z',
                },
                {
                    id: 'uuid-2',
                    delivery_id: 'del-2',
                    installation_id: 12345,
                    event_type: 'installation',
                    payload: {},
                    headers: {},
                    status: 'processed',
                    created_at: '2024-01-01T00:00:00Z',
                    updated_at: '2024-01-01T00:00:00Z',
                },
            ];

            mockLimit.mockResolvedValue({ data: mockDeliveries, error: null });

            const result = await service.getRecentDeliveries(12345);

            expect(result).toHaveLength(2);
            expect(result[0].deliveryId).toBe('del-1');
            expect(result[0].installationId).toBe(12345);
            expect(result[1].deliveryId).toBe('del-2');
            expect(mockEq).toHaveBeenCalledWith('installation_id', 12345);
        });

        it('retrieves recent deliveries with custom limit', async () => {
            const service = new WebhookDeliveryService();

            mockLimit.mockResolvedValue({ data: [], error: null });

            const result = await service.getRecentDeliveries(12345, 10);

            expect(result).toHaveLength(0);
            expect(mockLimit).toHaveBeenCalledWith(10);
        });

        it('returns empty array on error', async () => {
            const service = new WebhookDeliveryService();

            mockLimit.mockResolvedValue({ data: null, error: { message: 'Database error' } });

            const result = await service.getRecentDeliveries(12345);

            expect(result).toHaveLength(0);
        });
    });
});
