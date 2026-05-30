#!/usr/bin/env bash
set -euo pipefail

ACTION="${1:-start}"
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUNTIME_DIR="$ROOT_DIR/.runtime"
PID_FILE="$RUNTIME_DIR/memoryd.pid"
LOG_FILE="$RUNTIME_DIR/memoryd.log"

ensure_runtime_dir() {
  mkdir -p "$RUNTIME_DIR"
}

get_pid() {
  if [[ -f "$PID_FILE" ]]; then
    tr -d '[:space:]' <"$PID_FILE"
  fi
}

is_running() {
  local pid
  pid="$(get_pid || true)"
  [[ -n "${pid:-}" ]] && kill -0 "$pid" >/dev/null 2>&1
}

wait_health() {
  local attempts="${1:-20}"
  local delay="${2:-2}"
  local i
  for ((i=1; i<=attempts; i++)); do
    if curl -fsS "http://127.0.0.1:42690/health" >/dev/null 2>&1; then
      return 0
    fi
    sleep "$delay"
  done
  return 1
}

start_memoryd() {
  ensure_runtime_dir

  if [[ ! -d "$ROOT_DIR/node_modules" ]]; then
    echo "Installing dependencies..."
    (cd "$ROOT_DIR" && npm install)
  fi

  if is_running; then
    echo "memoryd already running (PID=$(get_pid))"
    return 0
  fi

  (
    cd "$ROOT_DIR"
    export OCM_BACKEND_MODE="graphiti-neo4j"
    export OCM_GRAPHITI_URL="http://127.0.0.1:18000"
    export OCM_NEO4J_URI="bolt://127.0.0.1:7687"
    export OCM_NEO4J_USER="neo4j"
    export OCM_NEO4J_PASSWORD="reflection123"
    export OCM_NEO4J_DATABASE="neo4j"
    export OCM_NEO4J_WORKSPACE="main"
    nohup npm run service >>"$LOG_FILE" 2>&1 &
    echo $! >"$PID_FILE"
  )

  if wait_health; then
    echo "memoryd started (PID=$(get_pid))"
    return 0
  fi

  echo "memoryd failed to become healthy"
  tail -n 120 "$LOG_FILE" || true
  return 1
}

stop_memoryd() {
  if ! is_running; then
    echo "memoryd is not running"
    rm -f "$PID_FILE"
    return 0
  fi
  kill -9 "$(get_pid)" || true
  rm -f "$PID_FILE"
  echo "memoryd stopped"
}

status_memoryd() {
  if ! is_running; then
    echo "memoryd status: stopped"
    return 0
  fi
  echo "memoryd status: running (PID=$(get_pid))"
  curl -fsS "http://127.0.0.1:42690/health" || true
  echo
}

case "$ACTION" in
  start) start_memoryd ;;
  stop) stop_memoryd ;;
  status) status_memoryd ;;
  restart)
    stop_memoryd
    start_memoryd
    ;;
  *)
    echo "Usage: $0 {start|stop|status|restart}"
    exit 1
    ;;
esac
