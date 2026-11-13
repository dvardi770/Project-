/**
 * Shared plumbing for the billing route handlers.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { prisma } from '@jewelry/db';
import { BillingError, type BillingDeps, type WebhookOutcome } from './billing';
import { billingConfig, dashboardUrl } from './env';

export const billingDeps = (): BillingDeps => ({ db: prisma, config: billingConfig() });

/**
 * A form post that changes something must come from this dashboard. The
 * session cookie is SameSite=Lax, which already keeps it off cross-site POSTs;
 * this is a second, explicit check.
 */
export function sameOrigin(request: NextRequest): boolean {
  const origin = request.headers.get('origin');
  return !origin || origin === new URL(dashboardUrl()).origin;
}

/** Back to the billing page, optionally with a message. 303 turns the POST into a GET. */
export function toBilling(query: Record<string, string> = {}): NextResponse {
  const url = new URL('/billing', dashboardUrl());
  for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
  return NextResponse.redirect(url, 303);
}

/** Show a billing problem to the merchant; anything unexpected is logged and stays generic. */
export function billingFailure(err: unknown): NextResponse {
  if (err instanceof BillingError) return toBilling({ error: err.message });
  console.error('[billing]', err);
  return toBilling({ error: 'Billing is temporarily unavailable. Please try again shortly.' });
}

export function webhookResponse(outcome: WebhookOutcome): NextResponse {
  return 'error' in outcome
    ? NextResponse.json({ error: outcome.error }, { status: outcome.status })
    : NextResponse.json({ received: true, handled: outcome.handled });
}
