'use server';

import { revalidatePath } from 'next/cache';
import { ZodError } from 'zod';
import { prisma } from '@jewelry/db';
import { saveMatrix } from '../../lib/markup';
import { requireTenant } from '../../lib/session';

export interface SaveState {
  ok?: boolean;
  errors?: string[];
}

export async function saveMarkupAction(_previous: SaveState, formData: FormData): Promise<SaveState> {
  const tenant = await requireTenant();
  let input: unknown;
  try {
    input = JSON.parse(String(formData.get('matrix') ?? ''));
  } catch {
    return { errors: ['The form could not be read. Reload the page and try again.'] };
  }
  try {
    // Validated again on the server; the browser's checks are a convenience only.
    await saveMatrix(prisma, tenant.id, input);
  } catch (err) {
    if (err instanceof ZodError) return { errors: [...new Set(err.issues.map((i) => i.message))] };
    throw err;
  }
  revalidatePath('/markup-settings');
  return { ok: true };
}
