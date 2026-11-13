#!/usr/bin/env bash

set -euo pipefail

ARCHIVE_PATH="${ARCHIVE_PATH:-emergent-release.tgz}"
DEPLOY_PORT="${DEPLOY_PORT:-22}"
DEPLOY_KEEP="${DEPLOY_KEEP_RELEASES:-5}"
DEPLOY_HOST="${DEPLOY_HOST:?DEPLOY_HOST is required}"
DEPLOY_USER="${DEPLOY_USER:?DEPLOY_USER is required}"
DEPLOY_BASE="${DEPLOY_BASE:?DEPLOY_BASE is required}"
DEPLOY_URL="${DEPLOY_URL:?DEPLOY_URL is required}"
RELEASE_ID="${GITHUB_SHA:?GITHUB_SHA is required}"
SERVICE_NAME="${SERVICE_NAME:-emergent}"

SSH_OPTS=(-o StrictHostKeyChecking=yes -o BatchMode=yes -p "$DEPLOY_PORT")
SCP_OPTS=(-o StrictHostKeyChecking=yes -o BatchMode=yes -P "$DEPLOY_PORT")
REMOTE="${DEPLOY_USER}@${DEPLOY_HOST}"
REMOTE_RELEASE="${DEPLOY_BASE}/releases/${RELEASE_ID}"
CURRENT_LINK="${DEPLOY_BASE}/current"
LOCK_DIR="${DEPLOY_BASE}/.deploy-lock"
LOCK_HELD=0

run_remote() {
  ssh "${SSH_OPTS[@]}" "$REMOTE" "$1"
}

release_lock() {
  if [ "$LOCK_HELD" -eq 1 ]; then
    run_remote "rmdir '${LOCK_DIR}'" >/dev/null 2>&1 || true
    LOCK_HELD=0
  fi
}

trap release_lock EXIT

case "$DEPLOY_BASE" in
  /|*"/../"*|*"/.."|*"./"*|*"."|*".."*) echo "DEPLOY_BASE points to an unsafe path" >&2; exit 1 ;;
  /*) ;;
  *) echo "DEPLOY_BASE must be an absolute path" >&2; exit 1 ;;
esac

if [[ ! "$RELEASE_ID" =~ ^[0-9a-f]{7,40}$ ]]; then
  echo "GITHUB_SHA must be a hexadecimal commit SHA" >&2
  exit 1
fi

if [[ ! "$DEPLOY_PORT" =~ ^[0-9]+$ ]] || [ "$DEPLOY_PORT" -lt 1 ] || [ "$DEPLOY_PORT" -gt 65535 ]; then
  echo "DEPLOY_PORT must be a number between 1 and 65535" >&2
  exit 1
fi

if [ ! -f "$ARCHIVE_PATH" ]; then
  echo "Release archive does not exist: ${ARCHIVE_PATH}" >&2
  exit 1
fi

run_remote "umask 077 && mkdir '${LOCK_DIR}'"
LOCK_HELD=1
PREVIOUS_TARGET="$(run_remote "if [ -L '${CURRENT_LINK}' ]; then readlink '${CURRENT_LINK}'; fi")"

run_remote "mkdir -p '${DEPLOY_BASE}/releases' && rm -rf '${REMOTE_RELEASE}' && mkdir -p '${REMOTE_RELEASE}'"
scp "${SCP_OPTS[@]}" "$ARCHIVE_PATH" "$REMOTE:${REMOTE_RELEASE}/release.tgz"
run_remote "cd '${REMOTE_RELEASE}' && tar -xzf release.tgz && rm release.tgz && /usr/local/bin/npm ci"

# Provision outside releases before switching. Only a non-authenticating verifier is shipped.
run_remote "cd '${REMOTE_RELEASE}' && /usr/local/bin/node --import tsx server/provision-admin.ts /var/lib/emergent"

RELATIVE_TARGET="releases/${RELEASE_ID}"
run_remote "ln -sfn '${RELATIVE_TARGET}' '${DEPLOY_BASE}/.current-link' && mv -Tf '${DEPLOY_BASE}/.current-link' '${CURRENT_LINK}' && sudo systemctl restart '${SERVICE_NAME}'"

if ! curl -fsSL --retry 5 --retry-delay 2 "$DEPLOY_URL" >/dev/null; then
  if [ -n "$PREVIOUS_TARGET" ] && run_remote "test -f '${DEPLOY_BASE}/${PREVIOUS_TARGET}/server/provision-admin.ts'"; then
    run_remote "ln -sfn '${PREVIOUS_TARGET}' '${DEPLOY_BASE}/.current-link' && mv -Tf '${DEPLOY_BASE}/.current-link' '${CURRENT_LINK}' && sudo systemctl restart '${SERVICE_NAME}'"
  else
    run_remote "sudo systemctl stop '${SERVICE_NAME}' && rm -f '${CURRENT_LINK}'"
  fi
  echo "Smoke test failed; restored a compatible release or stopped the service safely" >&2
  exit 1
fi

ACTIVE_TARGET="$(run_remote "readlink '${CURRENT_LINK}'")"
ACTIVE_SHA="$(basename "${ACTIVE_TARGET%/}")"
run_remote "cd '${DEPLOY_BASE}/releases' && ls -1t | tail -n +$((DEPLOY_KEEP + 1)) | while read -r old; do if [ \"\$old\" != '${RELEASE_ID}' ] && [ \"\$old\" != '${ACTIVE_SHA}' ]; then rm -rf \"\$old\"; fi; done"

echo "Deployed ${RELEASE_ID} to ${CURRENT_LINK}"
