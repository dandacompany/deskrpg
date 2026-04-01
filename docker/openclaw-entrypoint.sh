#!/bin/sh
set -eu

OPENCLAW_HOME="${OPENCLAW_HOME:-/home/node/.openclaw}"
OPENCLAW_WORKSPACE="${OPENCLAW_WORKSPACE:-/workspace}"
OPENCLAW_TOKEN="${OPENCLAW_TOKEN:-change-me-openclaw-token}"
OPENCLAW_PORT="${OPENCLAW_PORT:-18789}"
OPENCLAW_MODEL="${OPENCLAW_MODEL:-openai-codex/gpt-5.4}"
OPENCLAW_ALLOWED_ORIGINS="${OPENCLAW_ALLOWED_ORIGINS:-http://localhost:18789,http://127.0.0.1:18789,http://localhost:3102,http://127.0.0.1:3102}"
OPENCLAW_CONFIG_PATH="${OPENCLAW_CONFIG_PATH:-$OPENCLAW_HOME/openclaw.json}"

mkdir -p \
  "$OPENCLAW_HOME" \
  "$OPENCLAW_HOME/agents/main/agent" \
  "$OPENCLAW_HOME/identity" \
  "$OPENCLAW_HOME/devices" \
  "$OPENCLAW_HOME/cron" \
  "$OPENCLAW_HOME/telegram" \
  "$OPENCLAW_HOME/memory" \
  "$OPENCLAW_HOME/skills" \
  "$OPENCLAW_HOME/canvas" \
  "$OPENCLAW_WORKSPACE"

if [ ! -f "$OPENCLAW_CONFIG_PATH" ]; then
  ORIGINS_JSON="$(printf '%s' "$OPENCLAW_ALLOWED_ORIGINS" | awk -F',' '
    BEGIN { printf "[" }
    {
      for (i = 1; i <= NF; i++) {
        gsub(/^[[:space:]]+|[[:space:]]+$/, "", $i)
        if (length($i) > 0) {
          if (count > 0) printf ", "
          printf "\"%s\"", $i
          count++
        }
      }
    }
    END { printf "]" }
  ')"

  cat > "$OPENCLAW_CONFIG_PATH" <<EOF
{
  "gateway": {
    "port": $OPENCLAW_PORT,
    "auth": {
      "token": "$OPENCLAW_TOKEN"
    },
    "controlUi": {
      "allowedOrigins": $ORIGINS_JSON
    }
  },
  "agents": {
    "defaults": {
      "model": {
        "primary": "$OPENCLAW_MODEL"
      },
      "workspace": "$OPENCLAW_WORKSPACE"
    }
  }
}
EOF
fi

if [ ! -f "$OPENCLAW_WORKSPACE/BOOTSTRAP.md" ]; then
  cat > "$OPENCLAW_WORKSPACE/BOOTSTRAP.md" <<'EOF'
# BOOTSTRAP.md

<!-- Bootstrap completed. Configure OpenClaw providers from the dashboard if needed. -->
EOF
fi

exec "$@"
