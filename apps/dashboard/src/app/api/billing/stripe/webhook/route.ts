import { NextResponse, type NextRequest } from 'next/server';
import { handleStripeWebhook } from '../../../../../lib/billing';
import { billingDeps, webhookResponse } from '../../../../../lib/billing-http';

/**
 * POST /api/billing/stripe/webhook
 * Register this URL in Stripe for: checkout.session.completed,
 * customer.subscription.created / updated / deleted / paused / resumed,
 * invoice.paid and invoice.payment_failed.
 *
 * The signature covers the exact bytes Stripe sent, so the body is read as
 * text and never re-serialised. A 5xx makes Stripe retry later.
 */
export async function POST(request: NextRequest) {
  const rawBody = await request.text();
  try {
    return webhookResponse(await handleStripeWebhook(billingDeps(), rawBody, request.headers.get('stripe-signature')));
  } catch (err) {
    console.error('[billing] stripe webhook failed', err);
    return NextResponse.json({ error: 'Temporary failure' }, { status: 500 });
  }
}
