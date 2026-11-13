/**
 * Compile-time proof that what the routes return is what the widget expects.
 * If a route's response type stops being assignable to the shared contract,
 * `pnpm typecheck` fails here. Nothing in this file runs.
 */
import type * as Contract from '@jewelry/shared/storefront';
import type { BundleResponse, CartItemResponse, CheckoutResponse } from './routes/cart';
import type { DiamondDto } from './routes/diamonds';
import type { SettingDto } from './routes/settings';

type Assert<Actual extends Expected, Expected> = Actual;

export type ContractChecks = [
  Assert<DiamondDto, Contract.Diamond>,
  Assert<SettingDto, Contract.Setting>,
  Assert<BundleResponse, Contract.Bundle>,
  Assert<CartItemResponse, Contract.CartItem>,
  Assert<CheckoutResponse, Contract.Checkout>,
];
