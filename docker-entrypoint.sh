#!/bin/sh
set -e

# Auto-migrate: run Drizzle PostgreSQL migrations before starting the server
if [ -d "/app/drizzle" ] && [ "$DB_TYPE" != "sqlite" ]; then
  node /app/migrate.js
fi

exec node --import tsx server.js
