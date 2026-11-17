/**
 * Issue an API key for a tenant and, optionally, register the storefront
 * domains a publishable key may be used from.
 *
 *   pnpm --filter @jewelry/api issue-key <tenant-slug> --domain shop.example.com [--domain www.shop.example.com]
 *   pnpm --filter @jewelry/api issue-key <tenant-slug> --secret          # server-to-server key
 *
 * The key is printed once. Only its hash is stored; a lost key is replaced,
 * not recovered. Needs DATABASE_URL.
 */
import { randomBytes } from 'node:crypto';
import { prisma } from '@jewelry/db';
import { hashApiKey } from '../src/common/tenantAuth';

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const slug = args.find((a) => !a.startsWith('--') && args[args.indexOf(a) - 1] !== '--domain');
  const secret = args.includes('--secret');
  const domains = args
    .flatMap((a, i) => (a === '--domain' ? [args[i + 1] ?? ''] : []))
    .map((d) => d.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/[/:].*$/, ''));
  if (!slug) throw new Error('usage: issue-key <tenant-slug> [--secret] [--domain host ...]');
  const bad = domains.find((d) => !/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(d));
  if (bad !== undefined) throw new Error(`"${bad}" is not a hostname`);

  const tenant = await prisma.tenant.findUnique({ where: { slug } });
  if (!tenant) throw new Error(`no tenant with slug "${slug}"`);

  for (const hostname of domains) {
    const existing = await prisma.tenantDomain.findUnique({ where: { hostname } });
    if (existing && existing.tenantId !== tenant.id) throw new Error(`${hostname} already belongs to another tenant`);
    if (!existing) await prisma.tenantDomain.create({ data: { tenantId: tenant.id, hostname } });
  }

  const key = `${secret ? 'sk' : 'pk'}_live_${randomBytes(24).toString('base64url')}`;
  await prisma.apiKey.create({
    data: {
      tenantId: tenant.id,
      type: secret ? 'SECRET' : 'PUBLISHABLE',
      prefix: key.slice(0, 12),
      keyHash: hashApiKey(key),
    },
  });

  const all = await prisma.tenantDomain.findMany({ where: { tenantId: tenant.id }, orderBy: { hostname: 'asc' } });
  console.log(`${secret ? 'Secret' : 'Publishable'} key for ${tenant.name} (shown once):\n\n  ${key}\n`);
  if (!secret) {
    console.log(
      all.length
        ? `It works from: ${all.map((d) => d.hostname).join(', ')}`
        : 'No domains are registered yet, so this key will be refused. Run again with --domain <storefront host>.',
    );
  }
}

main()
  .catch((err) => {
    console.error(`Error: ${(err as Error).message}`);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
