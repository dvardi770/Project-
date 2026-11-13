import { NextResponse, type NextRequest } from 'next/server';
import { startSubscription } from '../../../../lib/billing';
import { billingDeps, billingFailure, sameOrigin } from '../../../../lib/billing-http';
import { currentTenant } from '../../../../lib/session';

/**
 * POST /api/billing/subscribe
 * Starts the subscription and sends the merchant to the provider's own page:
 * Shopify's charge approval screen, or Stripe Checkout.
 */
export async function POST(request: NextRequest) {
  if (!sameOrigin(request)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  const tenant = await currentTenant();
  if (!tenant) return NextResponse.redirect(new URL('/login', request.url), 303);
  try {
    return NextResponse.redirect(await startSubscription(billingDeps(), tenant.id), 303);
  } catch (err) {
    return billingFailure(err);
  }
}
