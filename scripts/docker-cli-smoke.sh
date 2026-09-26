#!/usr/bin/env bash
# Boot the image on SQLite, then run the CLI commands that need runtime-only modules.
# Usage: scripts/docker-cli-smoke.sh <image>
set -euo pipefail

image="${1:?usage: docker-cli-smoke.sh <image>}"
name="deskrpg-cli-smoke-$$"
cleanup() {
  status=$?
  if [ "$status" -ne 0 ]; then docker logs "$name" 2>&1 | tail -40 || true; fi
  docker rm -f "$name" >/dev/null 2>&1 || true
  exit "$status"
}
trap cleanup EXIT

docker run -d --name "$name" -p 127.0.0.1::3000 "$image" >/dev/null
port="$(docker port "$name" 3000/tcp | head -1 | sed 's/.*://')"

# The server creates the SQLite runtime home (and its users table) on its first start.
for _ in $(seq 1 90); do
  if curl -fsS "http://127.0.0.1:${port}/api/health" >/dev/null 2>&1; then break; fi
  if [ "$(docker inspect -f '{{.State.Running}}' "$name")" != "true" ]; then
    echo "container exited before becoming healthy" >&2
    exit 1
  fi
  sleep 2
done
curl -fsS "http://127.0.0.1:${port}/api/health" >/dev/null

printf 'smoke-password-1\n' |
  docker exec -i "$name" node bin/deskrpg.js create-user \
    --login-id smoke-admin --nickname "Smoke Admin" --password-stdin --role admin

reset_output="$(docker exec "$name" node bin/deskrpg.js reset-password smoke-admin)"
# The temporary password is printed once; confirm the reset without echoing it.
if ! printf '%s\n' "$reset_output" | grep -q "Login ID:  smoke-admin"; then
  printf '%s\n' "$reset_output" | grep -v "Temporary:" >&2
  echo "reset-password did not report the user" >&2
  exit 1
fi
echo "CLI smoke passed"
