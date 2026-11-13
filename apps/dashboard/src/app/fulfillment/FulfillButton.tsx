'use client';

import { useActionState } from 'react';
import { fulfillAction, type FulfillState } from './actions';

export function FulfillButton({ orderId, jobBagNumber }: { orderId: string; jobBagNumber: string }) {
  const [state, action, pending] = useActionState<FulfillState, FormData>(fulfillAction, {});
  return (
    <form action={action}>
      <input type="hidden" name="orderId" value={orderId} />
      <button type="submit" className="btn small" disabled={pending} aria-label={`Fulfill casting for ${jobBagNumber} via Platform Foundry`}>
        {pending ? 'Sending…' : 'Fulfill Casting via Platform Foundry'}
      </button>
      {state.error ? (
        <p className="hold-note" role="alert">
          {state.error}
        </p>
      ) : null}
    </form>
  );
}
