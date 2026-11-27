# The API (with the ring builder widget) and the merchant dashboard in one image.
# Build from the repository root:  docker build -f infra/docker/Dockerfile -t jewelry .
# Run:  ROLE=api (default) or ROLE=dashboard; see infra/docker/start.sh and docs/practice-wordpress.md.
# The full image already has OpenSSL, which Prisma's query engine needs.
FROM node:20-bookworm
RUN corepack enable

WORKDIR /app
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 NEXT_TELEMETRY_DISABLED=1
COPY . .
# Only what the API, the widget and the dashboard need (the ring lab is not part of the image).
RUN pnpm install --frozen-lockfile --filter "@jewelry/api..." --filter "@jewelry/widget..." --filter "@jewelry/dashboard..."
RUN pnpm --filter @jewelry/widget build && pnpm --filter @jewelry/dashboard build

ENV NODE_ENV=production HOST=0.0.0.0 PORT=4000
EXPOSE 4000
CMD ["sh", "infra/docker/start.sh"]
