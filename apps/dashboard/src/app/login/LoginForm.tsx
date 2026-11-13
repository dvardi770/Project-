'use client';

import { useActionState } from 'react';
import { signInAction, type LoginState } from './actions';

export function LoginForm() {
  const [state, action, pending] = useActionState<LoginState, FormData>(signInAction, {});
  return (
    <form action={action}>
      {state.error ? (
        <p className="notice error" role="alert" style={{ margin: 0 }}>
          {state.error}
        </p>
      ) : null}
      <label className="field">
        Secret API key
        <input name="key" type="password" autoComplete="off" spellCheck={false} placeholder="sk_live_…" required autoFocus />
      </label>
      <button type="submit" className="btn" disabled={pending}>
        {pending ? 'Signing in…' : 'Sign in'}
      </button>
    </form>
  );
}
