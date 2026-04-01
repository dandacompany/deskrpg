# Dockerfile
FROM node:20-bookworm-slim AS base

FROM base AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

FROM base AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
ARG NEXT_PUBLIC_COMING_SOON=false
ENV NEXT_PUBLIC_COMING_SOON=$NEXT_PUBLIC_COMING_SOON
RUN npm run build

FROM base AS runner
WORKDIR /app
ENV NODE_ENV=production
RUN addgroup --system --gid 1001 nodejs
RUN adduser --system --uid 1001 nextjs
COPY --from=builder /app/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static

# Custom server with Socket.io (replaces default standalone server.js)
COPY --from=builder /app/server.js ./server.js

# CommonJS modules required by server.js (not traced by Next.js standalone)
COPY --from=builder /app/src/lib/meeting-broker.js ./src/lib/meeting-broker.js
COPY --from=builder /app/src/lib/meeting-formatter.js ./src/lib/meeting-formatter.js
COPY --from=builder /app/src/lib/openclaw-gateway.js ./src/lib/openclaw-gateway.js
COPY --from=builder /app/src/lib/task-parser.js ./src/lib/task-parser.js
COPY --from=builder /app/src/lib/task-block-utils.js ./src/lib/task-block-utils.js
COPY --from=builder /app/src/lib/task-manager.js ./src/lib/task-manager.js
COPY --from=builder /app/src/db/server-db.js ./src/db/server-db.js
COPY --from=builder /app/src/db/sqlite-base-schema.js ./src/db/sqlite-base-schema.js
COPY --from=builder /app/src/db/normalize.js ./src/db/normalize.js
COPY --from=builder /app/src/lib/task-prompt.js ./src/lib/task-prompt.js
COPY --from=builder /app/src/lib/i18n/task-prompt-messages.js ./src/lib/i18n/task-prompt-messages.js
COPY --from=builder /app/src/lib/internal-transport.js ./src/lib/internal-transport.js
COPY --from=builder /app/src/lib/task-reporting.ts ./src/lib/task-reporting.ts
COPY --from=builder /app/src/lib/rbac/channel-access.ts ./src/lib/rbac/channel-access.ts
COPY --from=builder /app/src/server/meeting-socket.ts ./src/server/meeting-socket.ts
COPY --from=builder /app/src/server/meeting-discussion.ts ./src/server/meeting-discussion.ts
COPY --from=builder /app/tsconfig.json ./tsconfig.json

# Drizzle ORM + PostgreSQL driver (used by server.js, task-manager.js, server-db.js)
COPY --from=builder /app/node_modules/drizzle-orm ./node_modules/drizzle-orm
COPY --from=builder /app/node_modules/pg ./node_modules/pg
COPY --from=builder /app/node_modules/pg-connection-string ./node_modules/pg-connection-string
COPY --from=builder /app/node_modules/pg-int8 ./node_modules/pg-int8
COPY --from=builder /app/node_modules/pg-pool ./node_modules/pg-pool
COPY --from=builder /app/node_modules/pg-protocol ./node_modules/pg-protocol
COPY --from=builder /app/node_modules/pg-types ./node_modules/pg-types
COPY --from=builder /app/node_modules/pgpass ./node_modules/pgpass
COPY --from=builder /app/node_modules/postgres-array ./node_modules/postgres-array
COPY --from=builder /app/node_modules/postgres-bytea ./node_modules/postgres-bytea
COPY --from=builder /app/node_modules/postgres-date ./node_modules/postgres-date
COPY --from=builder /app/node_modules/postgres-interval ./node_modules/postgres-interval
COPY --from=builder /app/node_modules/split2 ./node_modules/split2
COPY --from=builder /app/node_modules/xtend ./node_modules/xtend

# Socket.io runtime dependencies (not traced by Next.js standalone)
COPY --from=builder /app/node_modules/socket.io ./node_modules/socket.io
COPY --from=builder /app/node_modules/socket.io-adapter ./node_modules/socket.io-adapter
COPY --from=builder /app/node_modules/socket.io-parser ./node_modules/socket.io-parser
COPY --from=builder /app/node_modules/engine.io ./node_modules/engine.io
COPY --from=builder /app/node_modules/engine.io-parser ./node_modules/engine.io-parser
COPY --from=builder /app/node_modules/ws ./node_modules/ws
COPY --from=builder /app/node_modules/@socket.io ./node_modules/@socket.io
COPY --from=builder /app/node_modules/cors ./node_modules/cors
COPY --from=builder /app/node_modules/vary ./node_modules/vary
COPY --from=builder /app/node_modules/object-assign ./node_modules/object-assign
COPY --from=builder /app/node_modules/debug ./node_modules/debug
COPY --from=builder /app/node_modules/ms ./node_modules/ms
COPY --from=builder /app/node_modules/base64id ./node_modules/base64id
COPY --from=builder /app/node_modules/cookie ./node_modules/cookie
COPY --from=builder /app/node_modules/accepts ./node_modules/accepts
COPY --from=builder /app/node_modules/negotiator ./node_modules/negotiator
COPY --from=builder /app/node_modules/mime-types ./node_modules/mime-types
COPY --from=builder /app/node_modules/mime-db ./node_modules/mime-db
COPY --from=builder /app/node_modules/jose ./node_modules/jose
COPY --from=builder /app/node_modules/tsx ./node_modules/tsx
COPY --from=builder /app/node_modules/esbuild ./node_modules/esbuild
COPY --from=builder /app/node_modules/get-tsconfig ./node_modules/get-tsconfig
COPY --from=builder /app/node_modules/resolve-pkg-maps ./node_modules/resolve-pkg-maps

# Migration runner + SQL files
COPY --from=builder /app/migrate.js ./migrate.js
COPY --from=builder /app/drizzle ./drizzle
COPY --from=builder /app/docker-entrypoint.sh ./docker-entrypoint.sh
RUN chmod +x ./docker-entrypoint.sh
RUN mkdir -p /app/data && chown -R nextjs:nodejs /app/data

USER nextjs
EXPOSE 3000 3001
ENV PORT=3000
ENV HOSTNAME="0.0.0.0"
ENTRYPOINT ["./docker-entrypoint.sh"]
