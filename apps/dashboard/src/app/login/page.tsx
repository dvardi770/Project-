import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { currentTenant } from '../../lib/session';
import { LoginForm } from './LoginForm';

export const metadata: Metadata = { title: 'Sign in' };

export default async function LoginPage() {
  if (await currentTenant()) redirect('/fulfillment');
  return (
    <main className="login">
      <div className="card">
        <h1>Jewelry Builder</h1>
        <p className="lede">Sign in with the secret key for your store&rsquo;s account.</p>
        <LoginForm />
      </div>
    </main>
  );
}
