#!/usr/bin/env bash
set -euo pipefail

MEMORYD_URL="${OCM_MEMORYD_URL:-http://127.0.0.1:42690}"

wait_http_ready() {
  local url="$1"
  local attempts="${2:-20}"
  local delay="${3:-2}"
  local i
  for ((i=1; i<=attempts; i++)); do
    if curl -fsS "$url" >/dev/null 2>&1; then
      return 0
    fi
    if [ "$i" -eq "$attempts" ]; then
      return 1
    fi
    sleep "$delay"
  done
}

echo "Running OpenClaw Memory DomFirst smoke test..."
echo "Memoryd: $MEMORYD_URL"
echo

wait_http_ready "$MEMORYD_URL/health"

CTX_JSON='{"sessionId":"smoke-session","agentId":"smoke-agent","projectId":"smoke-project","teamId":"smoke-team"}'
MESSAGE_JSON='{"role":"user","content":"Yesterday we hit a skill build failure in openclaw-memory-domfirst. The root cause was a missing Neo4j index bootstrap, and we fixed it by adding automatic schema initialization during backend startup."}'

echo "[1/5] Health"
curl -fsS "$MEMORYD_URL/health"
echo
echo

echo "[2/5] Ingest sample event"
curl -fsS "$MEMORYD_URL/ingest" \
  -H "content-type: application/json" \
  -d "{\"ctx\":$CTX_JSON,\"message\":$MESSAGE_JSON}"
echo
echo

echo "Waiting for afterTurn extraction..."
sleep 2
echo

echo "[3/5] Confirmation-style recall (expected shallow)"
curl -fsS "$MEMORYD_URL/search" \
  -H "content-type: application/json" \
  -d "{\"ctx\":$CTX_JSON,\"query\":\"Yesterday we hit that skill build failure, right?\"}"
echo
echo

echo "[4/5] Detail-style recall (expected deeper)"
curl -fsS "$MEMORYD_URL/search" \
  -H "content-type: application/json" \
  -d "{\"ctx\":$CTX_JSON,\"query\":\"What exactly was the skill build failure yesterday and how did we fix it?\"}"
echo
echo

echo "[5/5] Combined diagnostics"
curl -fsS "$MEMORYD_URL/diagnostics?sessionId=smoke-session&agentId=smoke-agent&projectId=smoke-project&teamId=smoke-team"
echo
echo
echo "Smoke test finished."
