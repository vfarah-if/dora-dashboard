#!/usr/bin/env bash
# Keeps the dashboard running on macOS without a terminal or an editor open.
#
# The API and the web app each get a launchd agent that starts at login and is started again if it stops. They serve
# the last build rather than watching the source, so a half-finished edit never takes them down; run install again
# after pulling or changing code. They use the same ports as `make dev`, so the sign-in callbacks registered for
# :5181 keep working, which means only one of the two can run at a time.
#
#   scripts/service.sh install     write both agents and (re)start them from the current build
#   scripts/service.sh uninstall   stop both and remove them from login
#   scripts/service.sh start       start them again after stop
#   scripts/service.sh stop        stop them until the next login or start
#   scripts/service.sh status      show whether each is running
#   scripts/service.sh logs        follow both logs
#   scripts/service.sh running     exit 0 when either agent is loaded, for the Makefile's port guard
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PREFIX="local.dora-dashboard"
AGENTS="$HOME/Library/LaunchAgents"
LOGS="$ROOT/.run"
SERVICES=(api web)

die() {
  printf '%s\n' "$*" >&2
  exit 1
}

[[ "$(uname -s)" == Darwin ]] || die "The always-on service uses launchd, so it runs on macOS only. Use make dev-bg instead."
DOMAIN="gui/$(id -u)"

label() { printf '%s.%s' "$PREFIX" "$1"; }
plist() { printf '%s/%s.plist' "$AGENTS" "$(label "$1")"; }
log_file() { printf '%s/service-%s.log' "$LOGS" "$1"; }
loaded() { launchctl print "$DOMAIN/$(label "$1")" > /dev/null 2>&1; }

xml() {
  local s=$1
  s=${s//&/&amp;}
  s=${s//</&lt;}
  s=${s//>/&gt;}
  printf '%s' "$s"
}

# $1 the service, $2 its working directory, then the program and its arguments. PATH is the one install ran under,
# because launchd's own holds none of node, gh or lizard.
write_plist() {
  local service=$1 dir=$2 arg args=""
  shift 2
  for arg in "$@"; do args+="    <string>$(xml "$arg")</string>"$'\n'; done
  cat > "$(plist "$service")" << EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$(label "$service")</string>
  <key>ProgramArguments</key>
  <array>
${args}  </array>
  <key>WorkingDirectory</key>
  <string>$(xml "$dir")</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>$(xml "$PATH")</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>$(xml "$(log_file "$service")")</string>
  <key>StandardErrorPath</key>
  <string>$(xml "$(log_file "$service")")</string>
</dict>
</plist>
EOF
}

start() {
  local service
  for service in "${SERVICES[@]}"; do
    [[ -f "$(plist "$service")" ]] || die "Not installed. Run make service-install."
    loaded "$service" || launchctl bootstrap "$DOMAIN" "$(plist "$service")"
  done
  echo "Running at http://localhost:5181 (make service-status, make service-logs)"
}

stop() {
  local service
  for service in "${SERVICES[@]}"; do
    if loaded "$service"; then launchctl bootout "$DOMAIN/$(label "$service")"; fi
  done
}

install() {
  local node tool
  node=$(command -v node) || die "node is not on PATH, so the service could not find it either."
  for tool in gh git; do
    command -v "$tool" > /dev/null || echo "Warning: $tool is not on PATH, so the service will not find it either." >&2
  done
  [[ -f "$ROOT/apps/api/dist/main.js" && -f "$ROOT/apps/web/dist/index.html" ]] || die "No build found. Run make build."
  mkdir -p "$AGENTS" "$LOGS"
  stop
  # The same commands as the api start and web preview scripts, run by node directly so launchd's stop signal
  # reaches the server rather than an npm wrapper.
  write_plist api "$ROOT/apps/api" "$node" --env-file-if-exists=../../.env dist/main.js
  write_plist web "$ROOT/apps/web" "$node" "$ROOT/node_modules/vite/bin/vite.js" preview
  start
}

uninstall() {
  local service
  stop
  for service in "${SERVICES[@]}"; do rm -f "$(plist "$service")"; done
  echo "Removed. Nothing starts at login now."
}

status() {
  local service pid
  for service in "${SERVICES[@]}"; do
    if loaded "$service"; then
      pid=$(launchctl print "$DOMAIN/$(label "$service")" | awk '$1 == "pid" { print $3; exit }')
      if [[ -n "$pid" ]]; then
        echo "$service: running (pid $pid)"
      else
        echo "$service: waiting to restart, see $(log_file "$service")"
      fi
    elif [[ -f "$(plist "$service")" ]]; then
      echo "$service: stopped until the next login or make service-start"
    else
      echo "$service: not installed"
    fi
  done
}

running() {
  local service
  for service in "${SERVICES[@]}"; do loaded "$service" && return 0; done
  return 1
}

case "${1:-}" in
  install | uninstall | start | status | running) "$1" ;;
  stop) stop && echo "Stopped until the next login or make service-start." ;;
  logs) tail -F "$(log_file api)" "$(log_file web)" ;;
  *) die "Usage: scripts/service.sh install|uninstall|start|stop|status|logs|running" ;;
esac
