# Dockerfile
# Match the release verifier's Node ABI so native SQLite/canvas prebuilds are available.
FROM node:22-bookworm-slim AS base

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
LABEL org.opencontainers.image.source="https://github.com/dandacompany/deskrpg"
WORKDIR /app
ENV NODE_ENV=production
# CLI adapter tools (optional; re-declared for runner stage)
ARG ENABLE_CLAUDE=false
ARG ENABLE_CODEX=false
ARG ENABLE_GEMINI=false
ARG ENABLE_OPENCODE=false
# SSH connections for the connection wizard (ssh, ssh-keygen, ssh-keyscan). python3, which runs on the target server, is not included.
RUN apt-get update \
  && apt-get install -y --no-install-recommends openssh-client \
  && rm -rf /var/lib/apt/lists/*
RUN addgroup --system --gid 1001 nodejs
RUN adduser --system --uid 1001 nextjs
COPY --from=builder /app/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static

# Custom server with Socket.io (replaces default standalone server.js)
COPY --from=builder /app/server.js ./server.js

# CommonJS modules required by server.js (not traced by Next.js standalone)
# Copy `src/lib` **as a directory**. A COPY per file adds a layer per line, pushing the image toward
# the overlay2 layer limit every time runtime dependencies grow — 2026.921.2 reached 126 layers and
# `docker pull` failed on Linux with `max depth exceeded`. It also means new dependencies need no edit here.
COPY --from=builder /app/src/lib ./src/lib

# Copy the conversation runtime and socket server **as directories**.
#
# This used to list files one per line, and that list rotted every time a file was added or renamed.
# It really did keep COPYing the deleted meeting-broker.js and openclaw-gateway.js and broke the build,
# and the eight conversation modules added in phase 2 were missing entirely — server.js imports
# socket-handlers.ts at runtime, so left as is the container dies on startup.
#
# Instead of matching a list by hand, move the whole boundary. New sibling files come along too.
COPY --from=builder /app/src/server ./src/server
# Pure shared map geometry and navigation used by channel motion coordination.
COPY --from=builder /app/src/game/navigation.ts ./src/game/navigation.ts
# Shared catalog/layout/seat modules evolve together; retain their runtime boundary.
COPY --from=builder /app/src/game/three ./src/game/three
COPY --from=builder /app/src/game/ambient-zones.ts ./src/game/ambient-zones.ts
COPY --from=builder /app/src/game/meeting-map-normalization.ts ./src/game/meeting-map-normalization.ts
COPY --from=builder /app/src/game/meeting-space.ts ./src/game/meeting-space.ts

# Move the DB boundary as a whole. As a file list, every entry point that static tracing misses,
# like `require("./sqlite-...js")`, silently drops out — in fact two migration modules
# (sqlite-npc-profile-ownership.js, sqlite-openclaw-retirement.js) were alive only by riding
# Next's standalone tracing, with no COPY line.
COPY --from=builder /app/src/db ./src/db
# The Hermes profile is the source of truth for an NPC's name and appearance — the socket server's NPC loader goes through this projection.
# The npc:set-active socket handler uses it for the clock-in/clock-out toggle.
# NOTE: src/lib/runtime-paths.ts (ESM) is distinct from src/lib/runtime-paths.js
# (CJS, copied above for openclaw-gateway.js's require()). db/index.ts imports the
# extensionless "../lib/runtime-paths", which TypeScript resolves to the .ts file.
# gateway-resources pulls this in to secure the board after binding (T4) — without it the socket server dies on startup.
# The globalThis registry through which the poller (T5) plugs itself into REST routes — without it the socket server dies on startup.
# The automation event sink (T5) pulls this in to match the origin of cron results.
# The preset and locale tree pulled in by the meeting protocol fallback (getDefaultMeetingProtocol).
# Whole-directory copies (not per-file): this project has missed individual files in
# these two directories five times (most recently local-discovery-gate.ts and
# profile-name.ts, neither of which had its own COPY line before this fix).

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

# The `deskrpg` CLI (bin/deskrpg.js) requires these at run time for create-user and reset-password.
# The app bundles bcryptjs into its server chunks, so standalone tracing never places it in
# node_modules — without this line both commands died with MODULE_NOT_FOUND inside the image.
# better-sqlite3 and pg are already here (traced by the app and copied above). The docker CI job
# runs both commands in the built image to keep this true.
COPY --from=builder /app/node_modules/bcryptjs ./node_modules/bcryptjs

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
