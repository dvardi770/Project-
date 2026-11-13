import { NextResponse, type NextRequest } from 'next/server';
import { handleShopifyBillingWebhook } from '../../../../../lib/billing';
import { billingDeps, webhookResponse } from '../../../../../lib/billing-http';

/**
 * POST /api/billing/shopify/webhook
 * Subscribe the Shopify app to the `app_subscriptions/update` topic with this
 * URL. Shopify calls it when a merchant approves, cancels or stops paying.
 */
export async function POST(request: NextRequest) {
  const rawBody = await request.text();
  try {
    return webhookResponse(
      await handleShopifyBillingWebhook(billingDeps(), rawBody, {
        hmac: request.headers.get('x-shopify-hmac-sha256'),
        shop: request.headers.get('x-shopify-shop-domain'),
      }),
    );
  } catch (err) {
    console.error('[billing] shopify webhook failed', err);
    return NextResponse.json({ error: 'Temporary failure' }, { status: 500 });
  }
}
