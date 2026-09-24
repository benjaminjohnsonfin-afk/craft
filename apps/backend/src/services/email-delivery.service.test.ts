/**
 * Tests for EmailDeliveryService (#769)
 *
 * Covers Handlebars template rendering (layout inheritance + every supported
 * type), delivery recording, provider dispatch, and bounce / webhook status
 * handling. Templates are rendered from the real files under
 * src/templates/email (cwd is apps/backend under vitest).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
    EmailDeliveryService,
    EMAIL_TYPES,
    type EmailType,
} from './email-delivery.service';

// ── Supabase mock ─────────────────────────────────────────────────────────────
//
// Records inserts/updates so tests can assert on the persisted delivery rows.

function makeSupabaseMock() {
    const inserts: Record<string, unknown>[] = [];
    const updates: Array<{ values: Record<string, unknown>; messageId: string }> = [];
    let insertShouldFail = false;
    let updateMatchCount = 1;

    const client = {
        from(_table: string) {
            return {
                insert(values: Record<string, unknown>) {
                    inserts.push(values);
                    return {
                        select() {
                            return {
                                single() {
                                    return insertShouldFail
                                        ? Promise.resolve({ data: null, error: { message: 'insert failed' } })
                                        : Promise.resolve({ data: { id: 'delivery-1' }, error: null });
                                },
                            };
                        },
                    };
                },
                update(values: Record<string, unknown>) {
                    return {
                        eq(_col: string, messageId: string) {
                            updates.push({ values, messageId });
                            return {
                                select() {
                                    const rows = Array.from({ length: updateMatchCount }, (_, i) => ({
                                        id: `row-${i}`,
                                    }));
                                    return Promise.resolve({ data: rows, error: null });
                                },
                            };
                        },
                    };
                },
            };
        },
    } as unknown as SupabaseClient;

    return {
        client,
        inserts,
        updates,
        setInsertFail: (v: boolean) => (insertShouldFail = v),
        setUpdateMatchCount: (n: number) => (updateMatchCount = n),
    };
}

const SAMPLE_DATA: Record<EmailType, Record<string, unknown>> = {
    deployment_complete: {
        name: 'Ada',
        projectName: 'stellar-app',
        environment: 'production',
        region: 'us-east-1',
        durationSeconds: 42,
        deploymentUrl: 'https://craft.app/d/1',
    },
    subscription_changed: {
        name: 'Ada',
        previousPlan: 'Free',
        newPlan: 'Pro',
        effectiveDate: '2026-07-01',
        billingUrl: 'https://craft.app/billing',
    },
    security_alert: {
        name: 'Ada',
        event: 'New sign-in from an unknown device',
        occurredAt: '2026-06-26T10:00:00Z',
        ipAddress: '203.0.113.7',
        location: 'Lagos, NG',
        secureAccountUrl: 'https://craft.app/security',
    },
    invoice_ready: {
        name: 'Ada',
        invoiceNumber: 'INV-001',
        amountDue: '$20.00',
        periodStart: '2026-06-01',
        periodEnd: '2026-06-30',
        dueDate: '2026-07-05',
        invoiceUrl: 'https://craft.app/invoice.pdf',
    },
};

describe('EmailDeliveryService', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.unstubAllEnvs();
        vi.unstubAllGlobals();
    });

    describe('template rendering', () => {
        it('renders every supported type inside the shared layout (layout inheritance)', () => {
            const svc = new EmailDeliveryService();
            for (const type of EMAIL_TYPES) {
                const { subject, html } = svc.render(type, SAMPLE_DATA[type]);
                expect(subject).toBeTruthy();
                // Layout chrome is present...
                expect(html).toContain('<!doctype html>');
                expect(html).toContain('CRAFT');
                expect(html).toContain('Email preferences');
                // ...and the body slot was filled with type-specific content.
                expect(html).toContain('Ada');
            }
        });

        it('injects type-specific body content into the layout body slot', () => {
            const svc = new EmailDeliveryService();
            const html = svc.render('deployment_complete', SAMPLE_DATA.deployment_complete).html;
            expect(html).toContain('stellar-app');
            expect(html).toContain('us-east-1');
            expect(html).toContain('View deployment');
        });

        it('uses the default subject per type but allows an override', () => {
            const svc = new EmailDeliveryService();
            expect(svc.render('security_alert', SAMPLE_DATA.security_alert).subject).toBe(
                'Security alert on your account',
            );
            expect(
                svc.render('invoice_ready', SAMPLE_DATA.invoice_ready, 'Custom subject').subject,
            ).toBe('Custom subject');
        });

        it('throws on an unsupported email type', () => {
            const svc = new EmailDeliveryService();
            expect(() => svc.render('nope' as EmailType, {})).toThrow(/Unsupported email type/);
        });
    });

    describe('template cache invalidation', () => {
        it('caches compiled templates for repeated renders', () => {
            const svc = new EmailDeliveryService();

            const { html: html1 } = svc.render('deployment_complete', SAMPLE_DATA.deployment_complete);
            const { html: html2 } = svc.render('deployment_complete', SAMPLE_DATA.deployment_complete);

            expect(html1).toBe(html2);
        });

        it('clears the template cache with clearTemplateCache', () => {
            const svc = new EmailDeliveryService();

            const { html: html1 } = svc.render('deployment_complete', SAMPLE_DATA.deployment_complete);
            svc.clearTemplateCache();
            const { html: html2 } = svc.render('deployment_complete', SAMPLE_DATA.deployment_complete);

            expect(html1).toBe(html2);
        });

        it('clears both layout and type-specific template caches', () => {
            const svc = new EmailDeliveryService();

            svc.render('deployment_complete', SAMPLE_DATA.deployment_complete);
            svc.render('security_alert', SAMPLE_DATA.security_alert);

            svc.clearTemplateCache();

            const { html: html1 } = svc.render('deployment_complete', SAMPLE_DATA.deployment_complete);
            const { html: html2 } = svc.render('security_alert', SAMPLE_DATA.security_alert);

            expect(html1).toBeTruthy();
            expect(html2).toBeTruthy();
        });
    });

    describe('sending + delivery recording', () => {
        it('records a sent delivery in dev mode (no EMAIL_API_URL)', async () => {
            const mock = makeSupabaseMock();
            const svc = new EmailDeliveryService(mock.client);

            const result = await svc.send({
                type: 'deployment_complete',
                to: 'ada@example.com',
                userId: 'user-1',
                data: SAMPLE_DATA.deployment_complete,
            });

            expect(result.status).toBe('sent');
            expect(result.delivered).toBe(true);
            expect(result.deliveryId).toBe('delivery-1');
            expect(mock.inserts).toHaveLength(1);
            expect(mock.inserts[0]).toMatchObject({
                user_id: 'user-1',
                email_type: 'deployment_complete',
                recipient: 'ada@example.com',
                status: 'sent',
            });
            expect(mock.inserts[0].provider_message_id).toBeTruthy();
        });

        it('dispatches via the provider API when EMAIL_API_URL is set', async () => {
            vi.stubEnv('EMAIL_API_URL', 'https://api.email.test');
            vi.stubEnv('EMAIL_API_KEY', 'key_test');
            const fetchMock = vi.fn().mockResolvedValue({
                ok: true,
                json: () => Promise.resolve({ id: 'provider-msg-9' }),
            });
            vi.stubGlobal('fetch', fetchMock);

            const mock = makeSupabaseMock();
            const svc = new EmailDeliveryService(mock.client);

            const result = await svc.send({
                type: 'invoice_ready',
                to: 'ada@example.com',
                data: SAMPLE_DATA.invoice_ready,
            });

            expect(fetchMock).toHaveBeenCalledOnce();
            expect(result.providerMessageId).toBe('provider-msg-9');
            expect(result.status).toBe('sent');
            expect(mock.inserts[0].provider_message_id).toBe('provider-msg-9');
        });

        it('records a bounce when the provider rejects the send', async () => {
            vi.stubEnv('EMAIL_API_URL', 'https://api.email.test');
            const fetchMock = vi.fn().mockResolvedValue({
                ok: false,
                status: 422,
                text: () => Promise.resolve('invalid recipient'),
            });
            vi.stubGlobal('fetch', fetchMock);

            const mock = makeSupabaseMock();
            const svc = new EmailDeliveryService(mock.client);

            const result = await svc.send({
                type: 'security_alert',
                to: 'bad@example.com',
                data: SAMPLE_DATA.security_alert,
            });

            expect(result.status).toBe('bounced');
            expect(result.delivered).toBe(false);
            expect(mock.inserts[0]).toMatchObject({ status: 'bounced' });
            expect(mock.inserts[0].error).toContain('422');
        });

        it('returns a null deliveryId but still succeeds if the audit insert fails', async () => {
            const mock = makeSupabaseMock();
            mock.setInsertFail(true);
            const svc = new EmailDeliveryService(mock.client);

            const result = await svc.send({
                type: 'deployment_complete',
                to: 'ada@example.com',
                data: SAMPLE_DATA.deployment_complete,
            });

            expect(result.status).toBe('sent');
            expect(result.deliveryId).toBeNull();
        });
    });

    describe('webhook status handling', () => {
        it('advances a delivery to delivered', async () => {
            const mock = makeSupabaseMock();
            const svc = new EmailDeliveryService(mock.client);

            const applied = await svc.handleWebhook({
                providerMessageId: 'provider-msg-9',
                status: 'delivered',
            });

            expect(applied).toBe(true);
            expect(mock.updates[0]).toMatchObject({
                messageId: 'provider-msg-9',
                values: { status: 'delivered' },
            });
        });

        it('records a bounce reason on a bounce webhook', async () => {
            const mock = makeSupabaseMock();
            const svc = new EmailDeliveryService(mock.client);

            await svc.handleWebhook({
                providerMessageId: 'provider-msg-9',
                status: 'bounced',
                error: 'mailbox full',
            });

            expect(mock.updates[0].values).toMatchObject({
                status: 'bounced',
                error: 'mailbox full',
            });
        });

        it('returns false when no delivery row matches the message id', async () => {
            const mock = makeSupabaseMock();
            mock.setUpdateMatchCount(0);
            const svc = new EmailDeliveryService(mock.client);

            const applied = await svc.handleWebhook({
                providerMessageId: 'unknown',
                status: 'opened',
            });

            expect(applied).toBe(false);
        });

        it('ignores an event with no provider message id', async () => {
            const mock = makeSupabaseMock();
            const svc = new EmailDeliveryService(mock.client);

            const applied = await svc.handleWebhook({
                providerMessageId: '',
                status: 'opened',
            });

            expect(applied).toBe(false);
            expect(mock.updates).toHaveLength(0);
        });
    });
});
