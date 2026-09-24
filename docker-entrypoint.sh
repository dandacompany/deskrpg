#!/bin/sh
set -e

# PostgreSQL installs state the dialect in the environment. On start, the runtime home bootstrap
# (src/lib/runtime-env-bootstrap.js → ensureDeskRpgHome) writes DB_TYPE=sqlite to the home's .env.local and,
# when DB_TYPE is not in the environment, promotes that value. Migrations would then run on PostgreSQL while the app
# writes to SQLite inside the container (not the volume), and data vanishes on recreate (2026-09-18 production measurement).
# If the user set DB_TYPE, leave it alone.
if [ -z "${DB_TYPE:-}" ] && [ -n "${DATABASE_URL:-}" ]; then
  export DB_TYPE=postgresql
fi

# Auto-migrate: run Drizzle PostgreSQL migrations before starting the server
if [ -d "/app/drizzle" ] && [ "$DB_TYPE" != "sqlite" ]; then
  node /app/migrate.js
fi

# Treat placeholder secrets the same as "no value".
#
# Hostinger's Docker Manager fills the environment fields straight from the repo's `.env.example`,
# so deploying without edits starts the container with the guidance text as JWT_SECRET. Environment variables
# win over files, so that hides the real key `ensureDeskRpgHome` stored in the volume, and
# startup-check rejects the placeholder, sending the container into a restart loop (2026-09-16 measurement).
#
# Unsetting it here restores the intended precedence:
#   1. A value the user set          → used as is (not a placeholder, so it stays)
#   2. A previously generated value in the volume → the same key across restarts
#   3. Neither                       → generate a new one and store it in the volume
#
# Leave the decision to `isPlaceholderSecret` alone. Restating the pattern in shell would let the two drift apart.
if [ -n "${JWT_SECRET+x}" ]; then
  if node -e 'const {isPlaceholderSecret}=require("/app/src/lib/runtime-paths.js");process.exit(isPlaceholderSecret(process.env.JWT_SECRET||"")?0:1)'; then
    echo "[entrypoint] JWT_SECRET 이 자리표시자라 무시합니다 — 런타임이 키를 만들어 데이터 볼륨에 보관합니다."
    unset JWT_SECRET
  fi
fi

exec node --import tsx server.js
