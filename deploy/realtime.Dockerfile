# Realtime server image. Build context: the repository root.
#
#   docker build -f deploy/realtime.Dockerfile -t <registry>/workspace-video-realtime:<commit> .
#
# The workspace packages are TypeScript sources, so the server runs through tsx
# (plain `node dist/server.js` cannot load them). That is fine for the first
# deploy; bundling it is a later optimisation, not a Phase 0 need.

FROM node:22-bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && npm install -g pnpm@12.4.1

RUN mkdir /repo && chown node:node /repo
USER node
WORKDIR /repo

COPY --chown=node:node package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY --chown=node:node apps/web/package.json apps/web/
COPY --chown=node:node apps/realtime/package.json apps/realtime/
COPY --chown=node:node packages/db/package.json packages/db/
COPY --chown=node:node packages/proximity/package.json packages/proximity/
COPY --chown=node:node packages/realtime-core/package.json packages/realtime-core/
COPY --chown=node:node packages/shared/package.json packages/shared/
RUN pnpm install --frozen-lockfile

COPY --chown=node:node . .
RUN pnpm --filter @workspace-video/db run generate

ENV NODE_ENV=production
EXPOSE 4001
WORKDIR /repo/apps/realtime
CMD ["pnpm", "exec", "tsx", "src/server.ts"]
