import { NextResponse, type NextRequest } from 'next/server';
import { syncShopifySubscription } from '../../../../../lib/billing';
import { billingDeps, billingFailure, toBilling } from '../../../../../lib/billing-http';
import { currentTenant } from '../../../../../lib/session';

/**
 * GET /api/billing/shopify/return
 * Where Shopify sends the merchant after the charge approval screen. Nothing
 * in the URL is trusted: Shopify is asked directly whether a subscription is
 * now active, and the answer is recorded.
 */
export async function GET(request: NextRequest) {
  const tenant = await currentTenant();
  if (!tenant) return NextResponse.redirect(new URL('/login', request.url), 303);
  try {
    const status = await syncShopifySubscription(billingDeps(), tenant);
    return toBilling({ checkout: status === 'ACTIVE' ? 'approved' : 'declined' });
  } catch (err) {
    return billingFailure(err);
  }
}
