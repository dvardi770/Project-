/**
 * Store a tenant's storefront credentials and webhook secret, encrypted.
 * Secrets are read from a JSON file so they never appear in shell history:
 *
 *   pnpm --filter @jewelry/api set-credentials <tenant-slug> ./secrets.json
 *
 * secrets.json:
 *   {
 *     "credentials": { …platform-specific, see README… },
 *     "webhookSecret": "…"
 *   }
 *
 * Needs DATABASE_URL and CREDENTIALS_ENCRYPTION_KEY. Delete the file afterwards.
 */
import { readFileSync } from 'node:fs';
import { prisma } from '@jewelry/db';
import { createConnector, encryptJson, encryptSecret, parseEncryptionKey } from '@jewelry/platforms';

async function main(): Promise<void> {
  const [slug, file] = process.argv.slice(2);
  if (!slug || !file) throw new Error('usage: set-credentials <tenant-slug> <secrets.json>');
  if (!process.env.CREDENTIALS_ENCRYPTION_KEY) throw new Error('CREDENTIALS_ENCRYPTION_KEY is not set');
  const key = parseEncryptionKey(process.env.CREDENTIALS_ENCRYPTION_KEY);

  const { credentials, webhookSecret } = JSON.parse(readFileSync(file, 'utf8')) as {
    credentials?: unknown;
    webhookSecret?: string;
  };
  if (!credentials && !webhookSecret) throw new Error('secrets file has neither "credentials" nor "webhookSecret"');

  const tenant = await prisma.tenant.findUnique({ where: { slug } });
  if (!tenant) throw new Error(`no tenant with slug "${slug}"`);
  if (credentials) createConnector(tenant.platformType, credentials); // validates the shape, makes no request

  await prisma.tenant.update({
    where: { id: tenant.id },
    data: {
      ...(credentials ? { platformCredentialsEnc: encryptJson(credentials, key) } : {}),
      ...(webhookSecret ? { platformWebhookSecretEnc: encryptSecret(webhookSecret, key) } : {}),
    },
  });

  const platform = tenant.platformType.toLowerCase();
  console.log(`Stored ${[credentials && 'credentials', webhookSecret && 'webhook secret'].filter(Boolean).join(' and ')} for ${tenant.name}.`);
  console.log(`Webhook URL to register on the store: https://<api-host>/webhooks/${platform}/${tenant.id}`);
}

main()
  .catch((err) => {
    console.error(`Error: ${(err as Error).message}`);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
