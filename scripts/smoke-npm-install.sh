#!/usr/bin/env bash
# Put the npm package into a real global install layout (node_modules) and check the CLI starts.
set -euo pipefail

if [ "$#" -ne 1 ]; then
  echo "Usage: bash scripts/smoke-npm-install.sh <tarball-or-npm-spec>" >&2
  exit 2
fi

smoke_spec="$1"
smoke_prefix="$(mktemp -d)"
smoke_home="$(mktemp -d)"
smoke_port=13102
smoke_pid=""
# EXIT trap calls this function.
# shellcheck disable=SC2329
cleanup() {
  if [ -n "$smoke_pid" ]; then
    kill "$smoke_pid" 2>/dev/null || true
  fi
  rm -rf -- "$smoke_prefix" "$smoke_home"
}
trap cleanup EXIT

npm install --global --prefix "$smoke_prefix" "$smoke_spec"
test -f "$smoke_prefix/lib/node_modules/deskrpg/server.js" || {
  echo "Package was not installed under node_modules" >&2
  exit 1
}

DESKRPG_HOME="$smoke_home" "$smoke_prefix/bin/deskrpg" init
DESKRPG_HOME="$smoke_home" "$smoke_prefix/bin/deskrpg" start -p "$smoke_port" > "$smoke_home/start.log" 2>&1 &
smoke_pid=$!

for smoke_attempt in $(seq 1 60); do
  if curl --fail --silent --show-error "http://127.0.0.1:$smoke_port/auth" > /dev/null 2>&1; then
    echo "npm package booted from node_modules; /auth reachable after attempt $smoke_attempt"
    exit 0
  fi
  if ! kill -0 "$smoke_pid" 2>/dev/null; then
    echo "npm CLI exited before /auth became reachable" >&2
    tail -80 "$smoke_home/start.log" >&2
    exit 1
  fi
  sleep 2
done

echo "npm CLI did not serve /auth within 120s" >&2
tail -80 "$smoke_home/start.log" >&2
exit 1
