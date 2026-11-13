import { redirect } from 'next/navigation';
import { currentTenant } from '../lib/session';

export default async function Home() {
  redirect((await currentTenant()) ? '/fulfillment' : '/login');
}
