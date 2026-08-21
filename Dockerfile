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
ARG NEXT_PUBLIC_REGISTRATION_DISABLED=false
# CLI adapter tools (optional)
ARG ENABLE_CLAUDE=false
ARG ENABLE_CODEX=false
ARG ENABLE_GEMINI=false
ARG ENABLE_OPENCODE=false
ENV NEXT_PUBLIC_COMING_SOON=$NEXT_PUBLIC_COMING_SOON
ENV NEXT_PUBLIC_REGISTRATION_DISABLED=$NEXT_PUBLIC_REGISTRATION_DISABLED
RUN npm run build

FROM base AS runner
WORKDIR /app
ENV NODE_ENV=production
# CLI adapter tools (optional; re-declared for runner stage)
ARG ENABLE_CLAUDE=false
ARG ENABLE_CODEX=false
ARG ENABLE_GEMINI=false
ARG ENABLE_OPENCODE=false
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
COPY --from=builder /app/src/lib/runtime-paths.js ./src/lib/runtime-paths.js
COPY --from=builder /app/src/lib/task-parser.js ./src/lib/task-parser.js
COPY --from=builder /app/src/lib/task-block-utils.js ./src/lib/task-block-utils.js
COPY --from=builder /app/src/lib/task-manager.js ./src/lib/task-manager.js
COPY --from=builder /app/src/db/server-db.js ./src/db/server-db.js
COPY --from=builder /app/src/db/schema.pg.cjs ./src/db/schema.pg.cjs
COPY --from=builder /app/src/db/schema.sqlite.cjs ./src/db/schema.sqlite.cjs
COPY --from=builder /app/src/db/sqlite-base-schema.js ./src/db/sqlite-base-schema.js
COPY --from=builder /app/src/db/normalize.js ./src/db/normalize.js
COPY --from=builder /app/src/lib/task-prompt.js ./src/lib/task-prompt.js
COPY --from=builder /app/src/lib/i18n/task-prompt-messages.js ./src/lib/i18n/task-prompt-messages.js
COPY --from=builder /app/src/lib/internal-transport.js ./src/lib/internal-transport.js
COPY --from=builder /app/src/lib/task-reporting.ts ./src/lib/task-reporting.ts
COPY --from=builder /app/src/lib/rbac/channel-access.ts ./src/lib/rbac/channel-access.ts
COPY --from=builder /app/src/server/meeting-socket.ts ./src/server/meeting-socket.ts
COPY --from=builder /app/src/server/meeting-discussion.ts ./src/server/meeting-discussion.ts

# conversation-engine.ts and its sibling modules (meeting-discussion.ts's deps,
# not traced by Next.js standalone, same reason as the files above)
COPY --from=builder /app/src/lib/conversation/conversation-engine.ts ./src/lib/conversation/conversation-engine.ts
COPY --from=builder /app/src/lib/conversation/transcript.ts ./src/lib/conversation/transcript.ts
COPY --from=builder /app/src/lib/conversation/turn-policy.ts ./src/lib/conversation/turn-policy.ts
COPY --from=builder /app/src/lib/conversation/turn-timeout.ts ./src/lib/conversation/turn-timeout.ts

# socket-handlers.ts (server.js entrypoint) and its transitive TS deps
# (not traced by Next.js standalone, same reason as the files above)
COPY --from=builder /app/src/server/socket-handlers.ts ./src/server/socket-handlers.ts
COPY --from=builder /app/src/server/hermes-dispatch.ts ./src/server/hermes-dispatch.ts
COPY --from=builder /app/src/db/index.ts ./src/db/index.ts
COPY --from=builder /app/src/db/schema.ts ./src/db/schema.ts
COPY --from=builder /app/src/db/schema-sqlite.ts ./src/db/schema-sqlite.ts
COPY --from=builder /app/src/lib/file-extractor.ts ./src/lib/file-extractor.ts
COPY --from=builder /app/src/lib/db-json.ts ./src/lib/db-json.ts
# NOTE: src/lib/runtime-paths.ts (ESM) is distinct from src/lib/runtime-paths.js
# (CJS, copied above for openclaw-gateway.js's require()). db/index.ts imports the
# extensionless "../lib/runtime-paths", which TypeScript resolves to the .ts file.
COPY --from=builder /app/src/lib/runtime-paths.ts ./src/lib/runtime-paths.ts
COPY --from=builder /app/src/lib/gateway-resources.ts ./src/lib/gateway-resources.ts
COPY --from=builder /app/src/lib/gateway-runtime-cache.ts ./src/lib/gateway-runtime-cache.ts
COPY --from=builder /app/src/lib/npc-response-messages.ts ./src/lib/npc-response-messages.ts
COPY --from=builder /app/src/lib/dev-constants.ts ./src/lib/dev-constants.ts
COPY --from=builder /app/src/lib/i18n/error-codes.ts ./src/lib/i18n/error-codes.ts
# Whole-directory copies (not per-file): this project has missed individual files in
# these two directories five times (most recently local-discovery-gate.ts and
# profile-name.ts, neither of which had its own COPY line before this fix).
COPY --from=builder /app/src/lib/adapters ./src/lib/adapters
COPY --from=builder /app/src/lib/hermes-profiles.ts ./src/lib/hermes-profiles.ts
COPY --from=builder /app/src/lib/hermes ./src/lib/hermes

# .dockerignore does NOT apply to `COPY --from=<stage>` — it filters the build context
# sent to the daemon, not files already inside a stage. Verified by inspecting a built
# image: all seven *.test.ts under src/lib/hermes shipped despite the .dockerignore
# entries. Strip them here, after the directory copies, where it actually takes effect.
RUN find ./src -name '*.test.ts' -o -name '*.test.tsx' -o -name '*.test.js' | xargs -r rm -f

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
RUN sed -i 's/\r$//' ./docker-entrypoint.sh && chmod +x ./docker-entrypoint.sh
RUN mkdir -p /app/data && chown -R nextjs:nodejs /app/data

# Install CLI adapters based on build args
RUN if [ "$ENABLE_CLAUDE" = "true" ]; then npm install -g @anthropic-ai/claude-code && echo 'Claude Code installed'; fi
RUN if [ "$ENABLE_CODEX" = "true" ]; then npm install -g @openai/codex && echo 'Codex CLI installed'; fi
RUN if [ "$ENABLE_GEMINI" = "true" ]; then echo 'TODO: gemini CLI install command'; fi
RUN if [ "$ENABLE_OPENCODE" = "true" ]; then npm install -g opencode && echo 'OpenCode installed'; fi

# Data directories for adapter auth and workspaces
RUN mkdir -p /var/deskrpg/users /var/deskrpg/workspaces && chown -R nextjs:nodejs /var/deskrpg
VOLUME /var/deskrpg/users
VOLUME /var/deskrpg/workspaces
ENV DESKRPG_HOME=/app/data
ENV DESKRPG_DATA_DIR=/var/deskrpg
ENV INTERNAL_HOSTNAME="0.0.0.0"

USER nextjs
EXPOSE 3000 3001
ENV PORT=3000
ENV HOSTNAME="0.0.0.0"
ENTRYPOINT ["./docker-entrypoint.sh"]
