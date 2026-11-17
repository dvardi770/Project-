'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { prisma } from '@jewelry/db';
import { foundryName } from '../../lib/env';
import { fulfillViaFoundry } from '../../lib/fulfillment';
import { hasActiveSubscription, requireTenant } from '../../lib/session';

export interface FulfillState {
  ok?: string;
  error?: string;
}

export async function fulfillAction(_previous: FulfillState, formData: FormData): Promise<FulfillState> {
  const tenant = await requireTenant();
  if (!hasActiveSubscription(tenant)) {
    return { error: 'Your subscription is not active. Reactivate it under Billing to send orders to the foundry.' };
  }
  const orderId = z.uuid().safeParse(formData.get('orderId'));
  if (!orderId.success) return { error: 'Order not found.' };

  // The tenant id comes from the session, never from the form.
  const result = await fulfillViaFoundry(prisma, tenant.id, orderId.data, foundryName());
  revalidatePath('/fulfillment');
  return result.ok ? { ok: `${result.jobBagNumber} was sent to ${result.vendorName}.` } : { error: result.message };
}
