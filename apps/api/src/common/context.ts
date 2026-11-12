import type { PrismaClient } from '@jewelry/db';
import type { AppConfig } from '../config/env';
import type { Cache } from './cache';
import type { MarkupMatrixLoader } from './markupMatrix';

/** Everything a route needs, passed explicitly so tests can substitute parts. */
export interface AppDeps {
  db: PrismaClient;
  cache: Cache;
  config: AppConfig;
  markupMatrix: MarkupMatrixLoader;
  /** HTTP client used to call storefront platforms; replaceable in tests. */
  fetch?: typeof fetch;
}
