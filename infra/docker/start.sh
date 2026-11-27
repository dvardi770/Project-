#!/bin/sh
# Starts the API (ROLE=api, the default) or the merchant dashboard (ROLE=dashboard).
# The API first brings the database up to date and, when PRACTICE_SITE is set, makes sure the
# practice store exists (keys are printed in the log the first time only).
set -e
cd /app
if [ "${ROLE:-api}" = "dashboard" ]; then
  exec pnpm --filter @jewelry/dashboard exec next start -p "${PORT:-3100}"
fi
pnpm --filter @jewelry/db migrate:deploy
if [ -n "$PRACTICE_SITE" ]; then
  pnpm --filter @jewelry/api -s practice --ensure
fi
exec pnpm --filter @jewelry/api -s start
