import Link from 'next/link';
import type { ReactNode } from 'react';
import type { Tenant } from '@jewelry/db';
import { signOutAction } from '../app/login/actions';
import { hasActiveSubscription } from '../lib/session';

const LINKS = [
  ['/fulfillment', 'Orders'],
  ['/markup-settings', 'Markup'],
  ['/billing', 'Billing'],
] as const;

/** Page frame for signed-in merchants: navigation, account name, subscription warning. */
export function Shell({ tenant, current, children }: { tenant: Tenant; current: string; children: ReactNode }) {
  return (
    <>
      <header className="topbar">
        <Link href="/fulfillment" className="brand">
          Jewelry Builder
        </Link>
        <nav aria-label="Main">
          {LINKS.map(([href, label]) => (
            <Link key={href} href={href} aria-current={current === href ? 'page' : undefined}>
              {label}
            </Link>
          ))}
        </nav>
        <div className="who">
          <span>{tenant.name}</span>
          <form action={signOutAction}>
            <button type="submit" className="linklike">
              Sign out
            </button>
          </form>
        </div>
      </header>
      <main>
        {!hasActiveSubscription(tenant) && current !== '/billing' ? (
          <p className="notice warn" role="status">
            Your subscription is not active, so the ring builder is switched off on your store.{' '}
            <Link href="/billing">Go to billing</Link>
          </p>
        ) : null}
        {children}
      </main>
    </>
  );
}
