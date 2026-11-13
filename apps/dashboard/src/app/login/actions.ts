'use server';

import { redirect } from 'next/navigation';
import { signIn, signOut } from '../../lib/session';

export interface LoginState {
  error?: string;
}

export async function signInAction(_previous: LoginState, formData: FormData): Promise<LoginState> {
  const key = String(formData.get('key') ?? '');
  // One message for every failure: it must not reveal whether a key exists.
  if (!(await signIn(key))) return { error: 'That key was not recognised. Use your secret key, which starts with sk_.' };
  redirect('/fulfillment');
}

export async function signOutAction(): Promise<void> {
  await signOut();
  redirect('/login');
}
