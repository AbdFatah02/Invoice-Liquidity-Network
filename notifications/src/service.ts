import type { InvoiceEvent, Subscription, DeliveryResult, ActorRole, WebhookStatus } from './types';
import {
  buildFundedSubject,
  buildPaymentSubject,
  buildDisputeSubject,
  buildDueWarningSubject,
  renderFundedEmail,
  renderPaymentEmail,
  renderDisputeEmail,
  renderDueWarningEmail,
} from './templates';
import { getDeadLetterEntries, replayDeadLetter as replayDlqEntry } from './delivery';

// ─── NOTE ─────────────────────────────────────────────────────────────────────
// This file contains an injectable NotificationService used by
// notifications/tests/delivery.test.ts and notifications/tests/triggers.test.ts.
//
// It is NOT currently wired into the production path (src/index.ts). Production
// delivery uses src/delivery.ts + src/processor.ts with direct Resend calls.
//
// Consolidating this injectable layer with the production path is tracked as a
// follow-up to issue #662. Until then, this file must not be deleted — the test
// suite depends on it.
// ──────────────────────────────────────────────────────────────────────────────

// ─── Dependency interfaces (injectable for testing) ────────────────────────────

export interface EmailClient {
  send(to: string, subject: string, body: string): Promise<void>;
}

export interface HttpClient {
  post(url: string, payload: unknown): Promise<{ status: number }>;
}

export interface SubscriptionStore {
  getByAddress(address: string): Promise<Subscription[]>;
  updateSubscription(id: string, updates: Partial<Subscription>): Promise<void>;
}

export interface ProcessedEventStore {
  hasProcessed(eventId: string): Promise<boolean>;
  markProcessed(eventId: string): Promise<void>;
}

// ─── Constants ────────────────────────────────────────────────────────────────

const WEBHOOK_MAX_RETRIES = 3;

// Which event types each actor role should receive
const ROLE_EVENT_ALLOWLIST: Record<ActorRole, string[]> = {
  freelancer: ['funded', 'paid', 'defaulted', 'due_date_warning'],
  lp: ['funded', 'paid', 'defaulted'],
  payer: ['funded', 'paid'],
};

// ─── Service ─────────────────────────────────────────────────────────────────

export class NotificationService {
  constructor(
    private readonly email: EmailClient,
    private readonly http: HttpClient,
    private readonly subscriptions: SubscriptionStore,
    private readonly processedEvents: ProcessedEventStore,
    private readonly clock: () => number = () => Date.now()
  ) {}

  async handleEvent(event: InvoiceEvent): Promise<DeliveryResult[]> {
    // Idempotency: skip duplicate events
    if (await this.processedEvents.hasProcessed(event.eventId)) {
      return [];
    }

    const results: DeliveryResult[] = [];

    const actors: Array<{ address: string; role: ActorRole }> = [
      { address: event.freelancer, role: 'freelancer' },
      { address: event.payer, role: 'payer' },
      ...(event.funder ? [{ address: event.funder, role: 'lp' as ActorRole }] : []),
    ];

    for (const { address, role } of actors) {
      const allowed = ROLE_EVENT_ALLOWLIST[role] ?? [];
      if (!allowed.includes(event.type)) continue;

      const subs = await this.subscriptions.getByAddress(address);

      for (const sub of subs) {
        if (!sub.active) continue;
        if (sub.role !== role) continue;

        if (sub.channel === 'email' && sub.email) {
          results.push(await this.deliverEmail(sub, event));
        } else if (sub.channel === 'webhook' && sub.webhookUrl) {
          results.push(await this.deliverWebhook(sub, event));
        }
      }
    }

    // Issue #1272: Persist notification processing state atomically
    try {
      await this.processedEvents.markProcessed(event.eventId);
    } catch (err) {
      console.error(`Failed to atomically persist notification state for event ${event.eventId}`, err);
    }
    return results;
  }

  isDueDateWarningDue(dueDateUnixSeconds: number): boolean {
    const warningAt = dueDateUnixSeconds * 1000 - 48 * 60 * 60 * 1000;
    return this.clock() >= warningAt;
  }

  inspectDeadLetter(): ReturnType<typeof getDeadLetterEntries> {
    return getDeadLetterEntries();
  }

  replayDeadLetter(entryId: string): Promise<void> {
    return new Promise((resolve, reject) => {
      try {
        replayDlqEntry(entryId);
        resolve();
      } catch (error: unknown) {
        reject(error);
      }
    });
  }

  private async deliverEmail(sub: Subscription, event: InvoiceEvent): Promise<DeliveryResult> {
    const subject = this.buildEmailSubject(event);
    const body = this.buildEmailBody(sub.role, event);
    await this.email.send(sub.email!, subject, body);
    return { success: true, channel: 'email', subscriptionId: sub.id };
  }

  private async deliverWebhook(sub: Subscription, event: InvoiceEvent): Promise<DeliveryResult> {
    const payload = {
      eventId: event.eventId,
      type: event.type,
      invoiceId: event.invoiceId,
      role: sub.role,
      timestamp: this.clock(),
    };

    for (let attempt = 0; attempt < WEBHOOK_MAX_RETRIES; attempt++) {
      try {
        const response = await this.http.post(sub.webhookUrl!, payload);
        if (response.status >= 200 && response.status < 300) {
          return { success: true, channel: 'webhook', subscriptionId: sub.id };
        }
      } catch {
        // network error — retry
      }
    }

    await this.subscriptions.updateSubscription(sub.id, {
      webhookStatus: 'failed' as WebhookStatus,
    });
    return { success: false, channel: 'webhook', subscriptionId: sub.id };
  }

  private buildEmailSubject(event: InvoiceEvent): string {
    switch (event.type) {
      case 'funded':
        return buildFundedSubject(event);
      case 'paid':
        return buildPaymentSubject(event);
      case 'defaulted':
        return buildDisputeSubject(event);
      case 'due_date_warning':
        return buildDueWarningSubject(event);
      default:
        return `Invoice #${event.invoiceId} update`;
    }
  }

  private buildEmailBody(role: string, event: InvoiceEvent): string {
    const actorRole = role as ActorRole;
    switch (event.type) {
      case 'funded':
        return renderFundedEmail({
          event,
          recipientRole: actorRole === 'payer' ? 'payer' : 'freelancer',
        });
      case 'paid':
        return renderPaymentEmail({
          event,
          recipientRole: actorRole === 'lp' ? 'lp' : 'freelancer',
        });
      case 'defaulted':
        return renderDisputeEmail({
          event,
          recipientRole: actorRole === 'lp' ? 'lp' : 'freelancer',
        });
      case 'due_date_warning':
        return renderDueWarningEmail({ event });
      default: {
        const roleLabel =
          actorRole === 'lp'
            ? 'Liquidity Provider'
            : actorRole.charAt(0).toUpperCase() + actorRole.slice(1);
        return [
          `Hello ${roleLabel},`,
          ``,
          `Invoice #${event.invoiceId} status: ${event.type}`,
          `Amount: ${event.amount}`,
          `Freelancer: ${event.freelancer}`,
          `Payer: ${event.payer}`,
        ].join('\n');
      }
    }
  }
}
