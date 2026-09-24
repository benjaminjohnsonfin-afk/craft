/**
 * Webhook Delivery Service
 *
 * Provides persistent tracking of GitHub webhook deliveries for idempotency
 * and replay functionality. Replaces in-memory delivery tracking with database
 * persistence that survives server restarts.
 *
 * Responsibilities:
 *   - Record received webhook deliveries with payload and headers
 *   - Track delivery processing status (received, processed, failed, replayed)
 *   - Provide idempotency checks using delivery_id
 *   - Support replay of failed or missed deliveries
 *   - Query deliveries for monitoring and troubleshooting
 *
 * Database schema: supabase/migrations/013_github_webhook_delivery_tracking.sql
 */

import { createClient } from '@/lib/supabase/server';
import { createLogger } from '@/lib/api/logger';
import { randomUUID } from 'node:crypto';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface WebhookDelivery {
    id: string;
    deliveryId: string;
    installationId: number;
    eventType: string;
    payload: Record<string, unknown>;
    headers: Record<string, string>;
    status: 'received' | 'processed' | 'failed' | 'replayed';
    processingError?: string;
    processedAt?: string;
    replayedFromDeliveryId?: string;
    createdAt: string;
    updatedAt: string;
}

export interface RecordDeliveryRequest {
    deliveryId: string;
    installationId: number;
    eventType: string;
    payload: Record<string, unknown>;
    headers: Record<string, string>;
}

export interface RecordDeliveryResult {
    success: boolean;
    delivery?: WebhookDelivery;
    alreadyExists?: boolean;
    error?: string;
}

export interface MarkProcessedResult {
    success: boolean;
    error?: string;
}

export interface MarkFailedResult {
    success: boolean;
    error?: string;
}

export interface HasReceivedDeliveryResult {
    received: boolean;
    error?: string;
}

export interface GetDeliveriesForReplayResult {
    success: boolean;
    deliveries?: Array<{
        deliveryId: string;
        eventType: string;
        payload: Record<string, unknown> | null;
        headers: Record<string, string> | null;
        source: 'failed' | 'missed';
    }>;
    error?: string;
}

export interface ReplayDeliveryResult {
    success: boolean;
    newDeliveryId?: string;
    error?: string;
}

export type WebhookDeliveryProcessor = (delivery: WebhookDelivery) => Promise<void>;

// ── Service ───────────────────────────────────────────────────────────────────

export class WebhookDeliveryService {
    private readonly log = createLogger({
        correlationId: 'webhook-delivery-service',
        service: 'webhook-delivery',
    });
    private processor: WebhookDeliveryProcessor | null = null;

    /**
     * Registers a processor function to handle downstream processing of replayed webhook deliveries.
     */
    registerProcessor(processor: WebhookDeliveryProcessor): void {
        this.processor = processor;
    }

    /**
     * Returns the registered processor, if any.
     */
    getProcessor(): WebhookDeliveryProcessor | null {
        return this.processor;
    }

    /**
     * Records a new webhook delivery in the database.
     *
     * This should be called at the start of webhook processing to establish
     * idempotency and enable replay if processing fails.
     *
     * @param request - Delivery details including deliveryId, eventType, payload, headers
     * @returns Result indicating success and the created delivery record
     */
    async recordDelivery(request: RecordDeliveryRequest): Promise<RecordDeliveryResult> {
        try {
            const supabase = createClient();

            // Use the database function for atomic insert with conflict handling
            const { data, error } = await supabase.rpc('record_webhook_delivery', {
                p_delivery_id: request.deliveryId,
                p_installation_id: request.installationId,
                p_event_type: request.eventType,
                p_payload: request.payload as any,
                p_headers: request.headers as any,
            });

            if (error) {
                // Check if this is a duplicate delivery (conflict on unique constraint)
                if (error.code === '23505') {
                    this.log.info('Delivery already recorded (duplicate)', {
                        deliveryId: request.deliveryId,
                    });
                    return { success: true, alreadyExists: true };
                }

                this.log.error('Failed to record delivery', error, {
                    deliveryId: request.deliveryId,
                });
                return { success: false, error: error.message };
            }

            // If data is null, it means the delivery already existed (ON CONFLICT DO NOTHING)
            if (!data) {
                this.log.info('Delivery already recorded (conflict)', {
                    deliveryId: request.deliveryId,
                });
                return { success: true, alreadyExists: true };
            }

            this.log.info('Delivery recorded', {
                deliveryId: request.deliveryId,
                eventType: request.eventType,
            });

            return {
                success: true,
                delivery: this.mapToWebhookDelivery(data),
            };
        } catch (error: any) {
            this.log.error('Unexpected error recording delivery', error);
            return { success: false, error: error.message || 'Unknown error' };
        }
    }

    /**
     * Marks a delivery as successfully processed.
     *
     * @param deliveryId - GitHub delivery ID (x-github-delivery header)
     * @returns Result indicating success
     */
    async markProcessed(deliveryId: string): Promise<MarkProcessedResult> {
        try {
            const supabase = createClient();

            const { error } = await supabase.rpc('mark_delivery_processed', {
                p_delivery_id: deliveryId,
            });

            if (error) {
                this.log.error('Failed to mark delivery as processed', error, { deliveryId });
                return { success: false, error: error.message };
            }

            this.log.info('Delivery marked as processed', { deliveryId });
            return { success: true };
        } catch (error: any) {
            this.log.error('Unexpected error marking delivery as processed', error);
            return { success: false, error: error.message || 'Unknown error' };
        }
    }

    /**
     * Marks a delivery as failed with an error message.
     *
     * @param deliveryId - GitHub delivery ID (x-github-delivery header)
     * @param errorMessage - Error message describing the failure
     * @returns Result indicating success
     */
    async markFailed(deliveryId: string, errorMessage: string): Promise<MarkFailedResult> {
        try {
            const supabase = createClient();

            const { error } = await supabase.rpc('mark_delivery_failed', {
                p_delivery_id: deliveryId,
                p_error_message: errorMessage,
            });

            if (error) {
                this.log.error('Failed to mark delivery as failed', error, { deliveryId });
                return { success: false, error: error.message };
            }

            this.log.info('Delivery marked as failed', { deliveryId, errorMessage });
            return { success: true };
        } catch (error: any) {
            this.log.error('Unexpected error marking delivery as failed', error);
            return { success: false, error: error.message || 'Unknown error' };
        }
    }

    /**
     * Checks if a delivery has been received (idempotency check).
     *
     * @param deliveryId - GitHub delivery ID (x-github-delivery header)
     * @returns Result indicating whether the delivery has been received
     */
    async hasReceivedDelivery(deliveryId: string): Promise<HasReceivedDeliveryResult> {
        try {
            const supabase = createClient();

            const { data, error } = await supabase.rpc('has_received_delivery', {
                p_delivery_id: deliveryId,
            });

            if (error) {
                this.log.error('Failed to check if delivery was received', error, { deliveryId });
                return { received: false, error: error.message };
            }

            return { received: data === true };
        } catch (error: any) {
            this.log.error('Unexpected error checking delivery', error);
            return { received: false, error: error.message || 'Unknown error' };
        }
    }

    /**
     * Gets all deliveries that need replay (failed or missed).
     *
     * @returns Result with list of deliveries needing replay
     */
    async getDeliveriesForReplay(): Promise<GetDeliveriesForReplayResult> {
        try {
            const supabase = createClient();

            const { data, error } = await supabase.rpc('get_deliveries_for_replay');

            if (error) {
                this.log.error('Failed to get deliveries for replay', error);
                return { success: false, error: error.message };
            }

            const deliveries = (data || []).map((row: any) => ({
                deliveryId: row.delivery_id,
                eventType: row.event_type,
                payload: row.payload,
                headers: row.headers,
                source: row.source as 'failed' | 'missed',
            }));

            this.log.info('Retrieved deliveries for replay', { count: deliveries.length });

            return { success: true, deliveries };
        } catch (error: any) {
            this.log.error('Unexpected error getting deliveries for replay', error);
            return { success: false, error: error.message || 'Unknown error' };
        }
    }

    /**
     * Replays a delivery by creating a new delivery record with a new delivery ID.
     *
     * The new delivery is marked with replayed_from_delivery_id to track the replay chain.
     * This ensures idempotency: the original delivery ID won't be reprocessed, but the
     * new delivery ID will be processed once.
     *
     * @param originalDeliveryId - Original delivery ID to replay
     * @param installationId - GitHub App installation ID for scoping
     * @returns Result with new delivery ID for the replayed event
     */
    async replayDelivery(originalDeliveryId: string, installationId: number): Promise<ReplayDeliveryResult> {
        try {
            const supabase = createClient();

            // Get the original delivery
            const { data: original, error: fetchError } = await supabase
                .from('github_webhook_deliveries')
                .select('*')
                .eq('delivery_id', originalDeliveryId)
                .eq('installation_id', installationId)
                .single();

            if (fetchError || !original) {
                this.log.error('Original delivery not found for replay', fetchError, {
                    originalDeliveryId,
                });
                return { success: false, error: 'Original delivery not found' };
            }

            // Generate a new delivery ID for the replay
            const newDeliveryId = `replay-${Date.now()}-${randomUUID().substring(0, 8)}`;

            // Create a new delivery record for the replay
            const { data: replayed, error: insertError } = await supabase
                .from('github_webhook_deliveries')
                .insert({
                    delivery_id: newDeliveryId,
                    event_type: original.event_type,
                    payload: original.payload,
                    headers: original.headers,
                    status: 'received',
                    replayed_from_delivery_id: originalDeliveryId,
                })
                .select()
                .single();

            if (insertError || !replayed) {
                this.log.error('Failed to create replay delivery', insertError, {
                    originalDeliveryId,
                    newDeliveryId,
                });
                return { success: false, error: insertError?.message || 'Failed to create replay' };
            }

            this.log.info('Delivery replayed', {
                originalDeliveryId,
                newDeliveryId,
                eventType: original.event_type,
            });

            // Re-trigger downstream processing if a processor is registered
            if (this.processor) {
                const replayedDelivery = this.mapToWebhookDelivery(replayed);
                try {
                    await this.processor(replayedDelivery);
                    await this.markProcessed(newDeliveryId);
                } catch (procErr: any) {
                    this.log.error('Failed to process replayed webhook delivery', procErr, {
                        newDeliveryId,
                        originalDeliveryId,
                    });
                    await this.markFailed(
                        newDeliveryId,
                        procErr?.message || 'Replay processing failed'
                    );
                }
            }

            return { success: true, newDeliveryId };
        } catch (error: any) {
            this.log.error('Unexpected error replaying delivery', error);
            return { success: false, error: error.message || 'Unknown error' };
        }
    }

    /**
     * Gets a delivery by its delivery ID, scoped to the installation.
     *
     * @param deliveryId - GitHub delivery ID
     * @param installationId - GitHub App installation ID for scoping
     * @returns Delivery record or null if not found
     */
    async getDelivery(deliveryId: string, installationId: number): Promise<WebhookDelivery | null> {
        try {
            const supabase = createClient();

            const { data, error } = await supabase
                .from('github_webhook_deliveries')
                .select('*')
                .eq('delivery_id', deliveryId)
                .eq('installation_id', installationId)
                .single();

            if (error || !data) {
                return null;
            }

            return this.mapToWebhookDelivery(data);
        } catch (error: any) {
            this.log.error('Unexpected error getting delivery', error);
            return null;
        }
    }

    /**
     * Gets recent deliveries for monitoring, scoped to the installation.
     *
     * @param installationId - GitHub App installation ID for scoping
     * @param limit - Maximum number of deliveries to return
     * @returns Array of delivery records
     */
    async getRecentDeliveries(installationId: number, limit: number = 50): Promise<WebhookDelivery[]> {
        try {
            const supabase = createClient();

            const { data, error } = await supabase
                .from('github_webhook_deliveries')
                .select('*')
                .eq('installation_id', installationId)
                .order('created_at', { ascending: false })
                .limit(limit);

            if (error || !data) {
                return [];
            }

            return data.map((d: any) => this.mapToWebhookDelivery(d));
        } catch (error: any) {
            this.log.error('Unexpected error getting recent deliveries', error);
            return [];
        }
    }

    // ── Private helpers ───────────────────────────────────────────────────────

    private mapToWebhookDelivery(data: any): WebhookDelivery {
        return {
            id: data.id,
            deliveryId: data.delivery_id,
            installationId: data.installation_id,
            eventType: data.event_type,
            payload: data.payload,
            headers: data.headers,
            status: data.status,
            processingError: data.processing_error,
            processedAt: data.processed_at,
            replayedFromDeliveryId: data.replayed_from_delivery_id,
            createdAt: data.created_at,
            updatedAt: data.updated_at,
        };
    }
}

export const webhookDeliveryService = new WebhookDeliveryService();
