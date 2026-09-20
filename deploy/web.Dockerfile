# Web app image. Build context: the repository root.
#
#   docker build -f deploy/web.Dockerfile -t <registry>/workspace-video-web:<commit> .
#
# One stage, boring on purpose: install, build, run `next start`. CI builds one image
# per commit and the deploy script runs exactly that image. The same image also runs
# the database migrations (the `migrate` service in docker-compose.prod.yml).

FROM node:22-bookworm-slim

# Prisma's engines need OpenSSL and CA certificates on Debian slim.
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && npm install -g pnpm@12.4.1

RUN mkdir /repo && chown node:node /repo
USER node
WORKDIR /repo

# Dependencies first, so this layer is reused until a package.json or the lockfile changes.
COPY --chown=node:node package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY --chown=node:node apps/web/package.json apps/web/
COPY --chown=node:node apps/realtime/package.json apps/realtime/
COPY --chown=node:node packages/db/package.json packages/db/
COPY --chown=node:node packages/proximity/package.json packages/proximity/
COPY --chown=node:node packages/realtime-core/package.json packages/realtime-core/
COPY --chown=node:node packages/shared/package.json packages/shared/
RUN pnpm install --frozen-lockfile

COPY --chown=node:node . .

# `next build` loads route modules, and env.ts refuses missing or public-default
# secrets in production. These are throwaway values for the BUILD ONLY: set on this
# one command, so they are not stored in the image's environment and are never used
# at run time (the real values come from the server's .env).
RUN pnpm --filter @workspace-video/db run generate \
    && NODE_ENV=production \
       AUTH_SECRET=build-only-not-a-real-secret-0123456789abcdef0123 \
       REALTIME_JWT_SECRET=build-only-a-different-not-real-0123456789abcdef \
       LIVEKIT_API_KEY=build-only-key \
       LIVEKIT_API_SECRET=build-only-not-a-real-livekit-secret-0123456789 \
       DATABASE_URL=postgresql://build:build-only@localhost:5432/build \
       APP_URL=https://build-only.invalid \
       pnpm --filter @workspace-video/web run build

ENV NODE_ENV=production
EXPOSE 3000
CMD ["pnpm", "--filter", "@workspace-video/web", "run", "start"]
