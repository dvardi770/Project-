import type { Metadata } from 'next';
import { prisma } from '@jewelry/db';
import { Shell } from '../../components/Shell';
import { rulesToMatrix } from '../../lib/markup';
import { requireTenant } from '../../lib/session';
import { MarkupForm } from './MarkupForm';

export const metadata: Metadata = { title: 'Markup' };

export default async function MarkupSettingsPage() {
  const tenant = await requireTenant();
  const rules = await prisma.markupRule.findMany({ where: { tenantId: tenant.id }, orderBy: { createdAt: 'asc' } });
  const { matrix, saved, otherRules } = rulesToMatrix(rules);

  return (
    <Shell tenant={tenant} current="/markup-settings">
      <h1>Markup</h1>
      <p className="lede">
        Set how much you add to the wholesale cost of each diamond. Your store shows the marked-up price; shoppers never
        see your cost.
      </p>
      {!saved ? (
        <p className="notice warn" role="status">
          No markup has been saved yet, so no diamonds are for sale on your store. These are suggested starting values:
          adjust them and save.
        </p>
      ) : null}
      {otherRules > 0 ? (
        <p className="notice warn" role="status">
          Your account also has {otherRules} custom pricing {otherRules === 1 ? 'rule' : 'rules'} set up outside this
          page. {otherRules === 1 ? 'It stays' : 'They stay'} in place and can take priority over the table below.
        </p>
      ) : null}
      <MarkupForm initial={matrix} saved={saved} />
    </Shell>
  );
}
