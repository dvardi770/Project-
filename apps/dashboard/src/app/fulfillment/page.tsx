import type { Metadata } from 'next';
import { prisma, type CastingOrderStatus } from '@jewelry/db';
import { Shell } from '../../components/Shell';
import { listOrders, stageLabel } from '../../lib/fulfillment';
import { requireTenant } from '../../lib/session';
import { FulfillButton } from './FulfillButton';

export const metadata: Metadata = { title: 'Orders' };

const STATUS: Record<CastingOrderStatus, { label: string; tone: string }> = {
  PENDING: { label: 'Awaiting payment', tone: '' },
  CONFIRMED: { label: 'Ready to send', tone: 'info' },
  IN_PRODUCTION: { label: 'In production', tone: 'ok' },
  ON_HOLD: { label: 'On hold', tone: 'warn' },
  QC_FAILED: { label: 'Failed quality check', tone: 'danger' },
  READY_TO_SHIP: { label: 'Ready to ship', tone: 'ok' },
  SHIPPED: { label: 'Shipped', tone: 'ok' },
  DELIVERED: { label: 'Delivered', tone: '' },
  CANCELED: { label: 'Cancelled', tone: '' },
};

const money = (amount: string, currency: string) =>
  Number(amount).toLocaleString('en-US', { style: 'currency', currency });

const day = (date: Date) => date.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' });

export default async function FulfillmentPage() {
  const tenant = await requireTenant();
  const orders = await listOrders(prisma, tenant.id);
  const waiting = orders.filter((o) => o.status === 'CONFIRMED').length;
  const held = orders.filter((o) => o.status === 'ON_HOLD').length;

  return (
    <Shell tenant={tenant} current="/fulfillment">
      <h1>Orders</h1>
      <p className="lede">
        Custom rings bought through your store.{' '}
        {orders.length === 0
          ? ''
          : `${waiting} ready to send to the foundry${held ? `, ${held} on hold and needing your attention` : ''}.`}
      </p>

      {orders.length === 0 ? (
        <div className="card">
          <h2>No orders yet</h2>
          <p className="muted" style={{ margin: 0 }}>
            When a shopper pays for a ring built on your store, it appears here with a job bag number.
          </p>
        </div>
      ) : (
        <div className="card table-wrap" style={{ padding: 0 }}>
          <table>
            <thead>
              <tr>
                <th scope="col">Job bag</th>
                <th scope="col">Ring</th>
                <th scope="col" className="num">
                  Total
                </th>
                <th scope="col">Status</th>
                <th scope="col">Action</th>
              </tr>
            </thead>
            <tbody>
              {orders.map((o) => (
                <tr key={o.id}>
                  <td>
                    <span className="order-main">
                      <strong>{o.jobBagNumber}</strong>
                      <span className="muted small">{day(o.createdAt)}</span>
                      <span className="muted small">Store order {o.externalOrderId}</span>
                    </span>
                  </td>
                  <td>
                    <span className="order-main">
                      <strong>{o.settingName}</strong>
                      <span className="small">
                        {o.metal}, size {o.ringSize}
                      </span>
                      <span className="small">{o.stone}</span>
                      {o.engraving ? <span className="muted small">Engraving: &ldquo;{o.engraving}&rdquo;</span> : null}
                    </span>
                  </td>
                  <td className="num">{money(o.total, o.currency)}</td>
                  <td>
                    <span className={`badge ${STATUS[o.status].tone}`}>{STATUS[o.status].label}</span>
                    {o.status === 'IN_PRODUCTION' && o.currentStage ? (
                      <>
                        <div className="small" style={{ marginTop: 6 }}>
                          {stageLabel(o.currentStage)}
                          {o.vendorName ? ` at ${o.vendorName}` : ''}
                        </div>
                        <div
                          className="progress"
                          role="img"
                          aria-label={`${o.progress.done} of ${o.progress.total} production steps complete`}
                        >
                          <i style={{ width: `${o.progress.total ? (o.progress.done / o.progress.total) * 100 : 0}%` }} />
                        </div>
                      </>
                    ) : null}
                    {o.status === 'ON_HOLD' && o.notes ? <div className="hold-note">{o.notes}</div> : null}
                  </td>
                  <td>
                    {o.status === 'CONFIRMED' ? (
                      <FulfillButton orderId={o.id} jobBagNumber={o.jobBagNumber} />
                    ) : o.status === 'ON_HOLD' ? (
                      <span className="muted small">Resolve the hold first</span>
                    ) : (
                      <span className="muted small">&mdash;</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Shell>
  );
}
