#!/usr/bin/env bash
set -euo pipefail

NEO4J_URI="${OCM_NEO4J_URI:-bolt://127.0.0.1:7687}"
GRAPHITI_URL="${OCM_GRAPHITI_URL:-http://127.0.0.1:8000}"
MEMORYD_URL="${OCM_MEMORYD_URL:-http://127.0.0.1:42690}"

echo "Checking OpenClaw Memory DomFirst backend..."
echo "Neo4j URI:   $NEO4J_URI"
echo "Graphiti:    $GRAPHITI_URL"
echo "Memoryd:     $MEMORYD_URL"
echo

check_http() {
  local label="$1"
  local url="$2"
  if curl -fsS "$url" >/tmp/ocm_backend_check.json 2>/dev/null; then
    echo "[ok] $label -> $url"
    cat /tmp/ocm_backend_check.json
    echo
  else
    echo "[fail] $label -> $url"
  fi
}

check_http "Graphiti service" "$GRAPHITI_URL/healthcheck"
check_http "ocm-memoryd" "$MEMORYD_URL/health"

bolt_target="${NEO4J_URI#*://}"
bolt_host="${bolt_target%%:*}"
bolt_port="${bolt_target##*:}"
if [ "$bolt_host" != "$bolt_port" ]; then
  if (echo >"/dev/tcp/$bolt_host/$bolt_port") >/dev/null 2>&1; then
    echo "[ok] Neo4j Bolt reachable -> $bolt_host:$bolt_port"
  else
    echo "[fail] Neo4j Bolt unreachable -> $bolt_host:$bolt_port"
  fi
else
  echo "[warn] Could not parse Neo4j URI: $NEO4J_URI"
fi
