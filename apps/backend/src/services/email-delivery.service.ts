/**
 * EmailDeliveryService
 *
 * Renders transactional emails with Handlebars (layout inheritance), dispatches
 * them through the configured transactional email provider, and records a
 * delivery audit trail in Supabase. Delivery status is later advanced by the
 * provider's webhook (sent → delivered / bounced / opened).
 *
 * Supported email types:
 *   - deployment_complete   Deployment finished successfully
 *   - subscription_changed  Billing plan changed
 *   - security_alert        Suspicious account activity
 *   - invoice_ready         New invoice available
 *
 * Template rendering:
 *   Each type has its own partial in templates/email/<type>.hbs. The partial is
 *   rendered first, then injected into the shared layout.hbs via its {{{body}}}
 *   slot — a simple form of layout inheritance. Compiled templates are cached.
 *
 * Email provider (mirrors invoice-delivery.service.ts):
 *   EMAIL_API_URL   — Base URL of the email API (e.g. https://api.resend.com)
 *   EMAIL_API_KEY   — API key for the provider
 *   EMAIL_FROM      — Sender address (e.g. notifications@craft.app)
 *   When EMAIL_API_URL is unset, the message is logged instead of sent (dev mode).
 *
 * Issue: #769 — Email Notification Delivery Service with Template Rendering
 *               and Delivery Tracking
 */

import { readFileSync } from 'fs';
import { join } from 'path';
import Handlebars from 'handlebars';
import type { SupabaseClient } from '@supabase/supabase-js';
import { createClient } from '@/lib/supabase/server';

// ── Types ─────────────────────────────────────────────────────────────────────

export type EmailType =
    | 'deployment_complete'
    | 'subscription_changed'
    | 'security_alert'
    | 'invoice_ready';

export type DeliveryStatus = 'sent' | 'delivered' | 'bounced' | 'opened';

/** The four supported email types, exported for validation/iteration. */
export const EMAIL_TYPES: readonly EmailType[] = [
    'deployment_complete',
    'subscription_changed',
    'security_alert',
    'invoice_ready',
];

/** Default subject lines per type (overridable via SendEmailInput.subject). */
const DEFAULT_SUBJECTS: Record<EmailType, string> = {
    deployment_complete: 'Your deployment is live',
    subscription_changed: 'Your subscription was updated',
    security_alert: 'Security alert on your account',
    invoice_ready: 'Your invoice is ready',
};

export interface SendEmailInput {
    type: EmailType;
    to: string;
    /** Template variables consumed by the Handlebars template + layout. */
    data: Record<string, unknown>;
    /** Recipient user id, persisted on the delivery record. */
    userId?: string;
    /** Overrides the default subject for the type. */
    subject?: string;
}

export interface RenderedEmail {
    subject: string;
    html: string;
}

export interface EmailDeliveryResult {
    deliveryId: string | null;
    providerMessageId: string | null;
    recipient: string;
    type: EmailType;
    status: DeliveryStatus;
    delivered: boolean;
}

/** Normalised provider webhook event. */
export interface DeliveryWebhookEvent {
    /** Provider message id; joins back to email_deliveries.provider_message_id. */
    providerMessageId: string;
    /** New status to record. */
    status: DeliveryStatus;
    /** Bounce / failure reason, if any. */
    error?: string;
}

// ── Service ───────────────────────────────────────────────────────────────────

export class EmailDeliveryService {
    private readonly templateDir: string;
    private layoutCache: HandlebarsTemplateDelegate | null = null;
    private readonly templateCache = new Map<EmailType, HandlebarsTemplateDelegate>();

    constructor(
        private readonly supabase?: SupabaseClient,
        templateDir?: string,
    ) {
        this.templateDir = templateDir ?? join(process.cwd(), 'src/templates/email');
    }

    private db(): SupabaseClient {
        return this.supabase ?? (createClient() as unknown as SupabaseClient);
    }

    // ── Template caching and invalidation ──────────────────────────────────────

    /**
     * Clear all cached compiled templates. Useful in development or test environments
     * where templates may change without a process restart.
     */
    clearTemplateCache(): void {
        this.layoutCache = null;
        this.templateCache.clear();
    }

    // ── Template rendering ────────────────────────────────────────────────────

    private compileLayout(): HandlebarsTemplateDelegate {
        if (!this.layoutCache) {
            const src = readFileSync(join(this.templateDir, 'layout.hbs'), 'utf8');
            this.layoutCache = Handlebars.compile(src);
        }
        return this.layoutCache;
    }

    private compileTemplate(type: EmailType): HandlebarsTemplateDelegate {
        const cached = this.templateCache.get(type);
        if (cached) return cached;

        const file = `${type.replace(/_/g, '-')}.hbs`;
        const src = readFileSync(join(this.templateDir, file), 'utf8');
        const compiled = Handlebars.compile(src);
        this.templateCache.set(type, compiled);
        return compiled;
    }

    /**
     * Render the email for a type: render the type's template, then inject it
     * into the shared layout (layout inheritance via the {{{body}}} slot).
     */
    render(type: EmailType, data: Record<string, unknown>, subject?: string): RenderedEmail {
        if (!EMAIL_TYPES.includes(type)) {
            throw new Error(`Unsupported email type: ${type}`);
        }

        const resolvedSubject = subject ?? DEFAULT_SUBJECTS[type];
        const body = this.compileTemplate(type)(data);
        const html = this.compileLayout()({
            ...data,
            subject: resolvedSubject,
            body,
        });

        return { subject: resolvedSubject, html };
    }

    // ── Sending ───────────────────────────────────────────────────────────────

    /**
     * Render, dispatch, and record an email. Always writes a delivery row
     * (status 'sent', or 'bounced' if the provider rejects the send) so the
     * audit trail is complete even on failure.
     */
    async send(input: SendEmailInput): Promise<EmailDeliveryResult> {
        const { subject, html } = this.render(input.type, input.data, input.subject);

        let providerMessageId: string | null = null;
        let status: DeliveryStatus = 'sent';
        let error: string | undefined;

        try {
            providerMessageId = await this.dispatch(input.to, subject, html);
        } catch (err: unknown) {
            status = 'bounced';
            error = err instanceof Error ? err.message : 'Email dispatch failed';
        }

        const deliveryId = await this.recordDelivery({
            userId: input.userId,
            type: input.type,
            recipient: input.to,
            subject,
            providerMessageId,
            status,
            error,
        });

        return {
            deliveryId,
            providerMessageId,
            recipient: input.to,
            type: input.type,
            status,
            delivered: status === 'sent',
        };
    }

    /**
     * Hand the rendered message to the email provider. Returns the provider
     * message id (used to correlate webhook status updates), or a synthetic id
     * in dev mode. Throws on provider error so send() can record a bounce.
     */
    private async dispatch(to: string, subject: string, html: string): Promise<string> {
        const apiUrl = process.env.EMAIL_API_URL;

        if (!apiUrl) {
            // Dev / test mode — log instead of sending.
            console.log(`[EmailDelivery] Would send "${subject}" to ${to}`);
            return `dev-${to}-${subject}`;
        }

        const from = process.env.EMAIL_FROM ?? 'notifications@craft.app';
        const apiKey = process.env.EMAIL_API_KEY ?? '';

        const res = await fetch(`${apiUrl}/emails`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${apiKey}`,
            },
            body: JSON.stringify({ from, to, subject, html }),
        });

        if (!res.ok) {
            const text = await res.text().catch(() => res.statusText);
            throw new Error(`Email API error ${res.status}: ${text}`);
        }

        const payload = (await res.json().catch(() => ({}))) as { id?: string };
        return payload.id ?? `sent-${to}`;
    }

    // ── Delivery tracking ─────────────────────────────────────────────────────

    /**
     * Insert a delivery audit record. Returns the new row id, or null if the
     * insert fails (logged, never throws — a failed audit write must not mask
     * a successful send).
     */
    async recordDelivery(record: {
        userId?: string;
        type: EmailType;
        recipient: string;
        subject: string;
        providerMessageId: string | null;
        status: DeliveryStatus;
        error?: string;
    }): Promise<string | null> {
        const { data, error } = await this.db()
            .from('email_deliveries')
            .insert({
                user_id: record.userId ?? null,
                email_type: record.type,
                recipient: record.recipient,
                subject: record.subject,
                provider_message_id: record.providerMessageId,
                status: record.status,
                error: record.error ?? null,
            })
            .select('id')
            .single();

        if (error) {
            console.error('[EmailDelivery] failed to record delivery:', error.message);
            return null;
        }

        return (data as { id: string } | null)?.id ?? null;
    }

    /**
     * Apply a provider delivery-status webhook event to the matching delivery
     * record (joined by provider_message_id). Returns true if a row was updated.
     */
    async handleWebhook(event: DeliveryWebhookEvent): Promise<boolean> {
        if (!event.providerMessageId) return false;

        const update: Record<string, unknown> = { status: event.status };
        if (event.error !== undefined) update.error = event.error;

        const { data, error } = await this.db()
            .from('email_deliveries')
            .update(update)
            .eq('provider_message_id', event.providerMessageId)
            .select('id');

        if (error) {
            console.error('[EmailDelivery] failed to apply webhook:', error.message);
            return false;
        }

        return Array.isArray(data) && data.length > 0;
    }
}

/** Shared singleton using the request-scoped Supabase server client. */
export const emailDeliveryService = new EmailDeliveryService();
