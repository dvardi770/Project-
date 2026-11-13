import { NextResponse, type NextRequest } from 'next/server';
import { openBillingPortal } from '../../../../lib/billing';
import { billingDeps, billingFailure, sameOrigin } from '../../../../lib/billing-http';
import { currentTenant } from '../../../../lib/session';

/**
 * POST /api/billing/portal
 * Opens Stripe's hosted page for changing the card, viewing invoices or cancelling.
 */
export async function POST(request: NextRequest) {
  if (!sameOrigin(request)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  const tenant = await currentTenant();
  if (!tenant) return NextResponse.redirect(new URL('/login', request.url), 303);
  try {
    return NextResponse.redirect(await openBillingPortal(billingDeps(), tenant), 303);
  } catch (err) {
    return billingFailure(err);
  }
}
