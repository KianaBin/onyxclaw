#!/bin/bash
set -euo pipefail

: "${OPENCLAW_CONFIG_PATH:=/home/node/.openclaw/openclaw.json}"
: "${OPENCLAW_WORKSPACE_DIR:=/home/node/.openclaw/workspace}"
: "${ONYXCLAW_BOOTSTRAP_DIR:=/home/node/.openclaw/bootstrap}"

install -d -m 0700 -o node -g node \
  "${ONYXCLAW_BOOTSTRAP_DIR}" \
  "${OPENCLAW_WORKSPACE_DIR}" \
  "$(dirname "${OPENCLAW_CONFIG_PATH}")"

# The APP writes openclaw.json immediately after Sandbox.create. SOUL.md is
# written separately into the persistent workspace during bootstrap, so it
# must not block Gateway startup.
while [[ ! -s "${OPENCLAW_CONFIG_PATH}" ]]; do
  sleep 1
done

chmod 0600 "${OPENCLAW_CONFIG_PATH}"
chown node:node "${OPENCLAW_CONFIG_PATH}"

exec setpriv --reuid=node --regid=node --init-groups \
  node /app/openclaw.mjs gateway --bind lan --port 18789
