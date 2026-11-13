import type { Metadata } from 'next';
import type { SubscriptionStatus } from '@jewelry/db';
import { Shell } from '../../components/Shell';
import { providerFor } from '../../lib/billing';
import { billingConfig } from '../../lib/env';
import { requireTenant } from '../../lib/session';

export const metadata: Metadata = { title: 'Billing' };

const STATUS: Record<SubscriptionStatus, { label: string; tone: string; help: string }> = {
  TRIALING: { label: 'Trial', tone: 'info', help: 'Your ring builder is live while the trial lasts.' },
  ACTIVE: { label: 'Active', tone: 'ok', help: 'Your ring builder is live.' },
  PAST_DUE: { label: 'Payment overdue', tone: 'warn', help: 'The last payment failed, so the ring builder is switched off until it goes through.' },
  PAUSED: { label: 'Paused', tone: 'warn', help: 'The ring builder is switched off while the subscription is paused.' },
  CANCELED: { label: 'Cancelled', tone: 'danger', help: 'The ring builder is switched off. Subscribe to turn it back on.' },
};

const MESSAGES: Record<string, { tone: string; text: string }> = {
  success: { tone: 'ok', text: 'Thank you. Your subscription is being activated; this page updates within a minute.' },
  canceled: { tone: 'warn', text: 'Checkout was cancelled. Nothing was charged.' },
  approved: { tone: 'ok', text: 'Your subscription is active.' },
  declined: { tone: 'warn', text: 'The charge was not approved in Shopify. Nothing was charged.' },
};

const day = (date: Date) => date.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' });

export default async function BillingPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const tenant = await requireTenant();
  const params = await searchParams;
  const config = billingConfig();
  const provider = providerFor(tenant.platformType);
  const status = STATUS[tenant.subscriptionStatus];
  const message = MESSAGES[String(params.checkout ?? '')];
  const error = typeof params.error === 'string' ? params.error.slice(0, 300) : null;
  const subscribed = !!tenant.billingSubscriptionId && tenant.subscriptionStatus !== 'CANCELED';

  return (
    <Shell tenant={tenant} current="/billing">
      <h1>Billing</h1>
      <p className="lede">
        {config.planName}: ${config.priceUsd} per month, billed{' '}
        {provider === 'SHOPIFY' ? 'on your Shopify invoice' : 'to your card through Stripe'}.
      </p>

      {message ? (
        <p className={`notice ${message.tone}`} role="status">
          {message.text}
        </p>
      ) : null}
      {error ? (
        <p className="notice error" role="alert">
          {error}
        </p>
      ) : null}

      <div className="card">
        <dl className="kv">
          <dt>Status</dt>
          <dd>
            <span className={`badge ${status.tone}`}>{status.label}</span>
          </dd>
          {tenant.subscriptionStatus === 'TRIALING' && tenant.trialEndsAt ? (
            <>
              <dt>Trial ends</dt>
              <dd>{day(tenant.trialEndsAt)}</dd>
            </>
          ) : null}
          {subscribed && tenant.currentPeriodEndsAt ? (
            <>
              <dt>Next payment</dt>
              <dd>{day(tenant.currentPeriodEndsAt)}</dd>
            </>
          ) : null}
          <dt>Billed through</dt>
          <dd>{provider === 'SHOPIFY' ? 'Shopify' : 'Stripe'}</dd>
        </dl>
        <p className="muted" style={{ margin: '16px 0 0' }}>
          {status.help}
        </p>

        <div className="row-actions">
          {!subscribed ? (
            <form method="post" action="/api/billing/subscribe">
              <button type="submit" className="btn">
                Subscribe for ${config.priceUsd} a month
              </button>
            </form>
          ) : provider === 'STRIPE' ? (
            <form method="post" action="/api/billing/portal">
              <button type="submit" className="btn ghost">
                Manage card, invoices or cancel
              </button>
            </form>
          ) : (
            <span className="muted small">To change or cancel, open your Shopify admin and go to Settings, then Apps.</span>
          )}
        </div>
      </div>
    </Shell>
  );
}
