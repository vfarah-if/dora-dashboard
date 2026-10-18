#!/usr/bin/env bash
# Keeps the dashboard running on macOS without a terminal or an editor open.
#
# The API and the web app each get a launchd agent that starts at login and is started again if it stops. They serve
# the last build rather than watching the source, so a half-finished edit never takes them down; run install again
# after pulling or changing code. They use the same ports as `make dev`, so the sign-in callbacks registered for
# :5181 keep working, which means only one of the two can run at a time.
#
# With SERVICE_HOST set in .env, such as deliverymetrics.local, host-install also makes the service answer on
# http://SERVICE_HOST through a hosts entry and a redirect from port 80, which needs sudo once.
#
#   scripts/service.sh install          write both agents and (re)start them from the current build
#   scripts/service.sh uninstall        stop both and remove them from login
#   scripts/service.sh start            start them again after stop
#   scripts/service.sh stop             stop them until the next login or start
#   scripts/service.sh status           show whether each is running, and whether SERVICE_HOST answers
#   scripts/service.sh logs             follow both logs
#   scripts/service.sh host-install     add the hosts entries and the port 80 redirect, then install (sudo)
#   scripts/service.sh host-uninstall   remove the hosts entries and the port 80 redirect (sudo)
#   scripts/service.sh running          exit 0 when either agent is loaded, for the Makefile's port guard
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PREFIX="local.dora-dashboard"
AGENTS="$HOME/Library/LaunchAgents"
LOGS="$ROOT/.run"
SERVICES=(api web)
WEB_PORT=5181

# macOS lets only root listen on port 80 of the loopback address, so a root daemon redirects that port to the web app
# instead. It runs only system tools, so nothing a user can edit ever runs as root, and its rules match loopback alone,
# so nothing is exposed to the network. /etc/pf.conf already evaluates every anchor under com.apple, so no system file
# is edited. It reapplies the rules every five minutes in case something flushed them.
REDIRECT="$PREFIX.port80"
REDIRECT_PLIST="/Library/LaunchDaemons/$REDIRECT.plist"
ANCHOR="com.apple/dora-dashboard"
HOSTS_TAG="# dora-dashboard"
HOSTS_BACKUP="/etc/hosts.before-dora-dashboard"
HOST_PATTERN='^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$'

die() {
  printf '%s\n' "$*" >&2
  exit 1
}

[[ "$(uname -s)" == Darwin ]] || die "The always-on service uses launchd, so it runs on macOS only. Use make dev-bg instead."
DOMAIN="gui/$(id -u)"

# The name to answer on at port 80, from the environment or else .env. Empty means http://localhost:5181 alone.
read_host() {
  local value=${SERVICE_HOST:-}
  if [[ -z "$value" && -f "$ROOT/.env" ]]; then value=$(sed -n 's/^SERVICE_HOST=//p' "$ROOT/.env" | tail -n 1); fi
  printf '%s' "$value" | tr -d "\"' \r" | tr '[:upper:]' '[:lower:]'
}
HOST=$(read_host)

check_host() {
  [[ -z "$HOST" || "$HOST" =~ $HOST_PATTERN ]] || die "SERVICE_HOST=$HOST is not a host name such as deliverymetrics.local."
}

address() {
  if [[ -n "$HOST" ]]; then printf 'http://%s' "$HOST"; else printf 'http://localhost:%s' "$WEB_PORT"; fi
}

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
# because launchd's own holds none of node, gh or lizard. With SERVICE_HOST set, both get WEB_ORIGIN for that address,
# which outranks .env, so the API accepts changes from that origin and preview accepts the name (vite.config.ts).
write_plist() {
  local service=$1 dir=$2 arg args="" origin=""
  shift 2
  for arg in "$@"; do args+="    <string>$(xml "$arg")</string>"$'\n'; done
  if [[ -n "$HOST" ]]; then origin="    <key>WEB_ORIGIN</key>"$'\n'"    <string>$(xml "$(address)")</string>"$'\n'; fi
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
${origin}  </dict>
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

redirect_rules() {
  printf 'rdr pass on lo0 inet proto tcp from any to 127.0.0.1 port 80 -> 127.0.0.1 port %s\n' "$WEB_PORT"
  printf 'rdr pass on lo0 inet6 proto tcp from any to ::1 port 80 -> ::1 port %s\n' "$WEB_PORT"
}

# pf is enabled only when nothing else has enabled it, so reapplying never stacks up enable references.
redirect_plist() {
  local command
  command="printf '%s\\n' '$(redirect_rules)' | /sbin/pfctl -q -a $ANCHOR -f - && { /sbin/pfctl -s info | /usr/bin/grep -q '^Status: Enabled' || /sbin/pfctl -q -E; }"
  cat << EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$REDIRECT</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/sh</string>
    <string>-c</string>
    <string>$(xml "$command")</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>StartInterval</key>
  <integer>300</integer>
</dict>
</plist>
EOF
}

probe() { [[ "$(curl -s -o /dev/null -w '%{http_code}' --max-time 2 "$(address)/" || true)" == 200 ]]; }

# launchd starts the servers a moment after bootstrap returns, so this gives them up to ten seconds.
answers() {
  for _ in {1..10}; do
    if probe; then return 0; fi
    sleep 1
  done
  return 1
}

start() {
  local service
  for service in "${SERVICES[@]}"; do
    [[ -f "$(plist "$service")" ]] || die "Not installed. Run make service-install."
    loaded "$service" || launchctl bootstrap "$DOMAIN" "$(plist "$service")"
  done
  echo "Running at $(address) (make service-status, make service-logs)"
  if [[ -n "$HOST" && ! -f "$REDIRECT_PLIST" ]]; then echo "Run make service-host-install so that $(address) reaches it." >&2; fi
}

stop() {
  local service
  for service in "${SERVICES[@]}"; do
    if loaded "$service"; then launchctl bootout "$DOMAIN/$(label "$service")"; fi
  done
}

install() {
  local node tool
  check_host
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

# Every line added to /etc/hosts ends with HOSTS_TAG, so removing them leaves the rest of the file as it was. All the
# root steps run under one sudo, because a managed Mac can be set to ask for the password on every sudo. The new hosts
# file is written beside the old one and renamed over it, so an interrupted run never leaves a partial /etc/hosts.
ROOT_STEPS_INSTALL='
  set -e
  [ -f "$1" ] || cp /etc/hosts "$1"
  install -m 644 -o root -g wheel "$2" /etc/hosts.dora-dashboard.new
  mv -f /etc/hosts.dora-dashboard.new /etc/hosts
  launchctl bootout "system/$3" 2> /dev/null || true
  install -m 644 -o root -g wheel "$4" "$5"
  launchctl bootstrap system "$5"
  dscacheutil -flushcache
  killall -HUP mDNSResponder
'

# Loading nothing empties the anchor. pf itself stays enabled, with none of these rules, until the next restart.
ROOT_STEPS_UNINSTALL='
  set -e
  install -m 644 -o root -g wheel "$1" /etc/hosts.dora-dashboard.new
  mv -f /etc/hosts.dora-dashboard.new /etc/hosts
  launchctl bootout "system/$2" 2> /dev/null || true
  rm -f "$3"
  : | pfctl -q -a "$4" -f - 2> /dev/null
  dscacheutil -flushcache
  killall -HUP mDNSResponder
'

host_install() {
  local work
  [[ -n "$HOST" ]] || die "Set SERVICE_HOST in .env first, for example SERVICE_HOST=deliverymetrics.local."
  check_host
  work=$(mktemp -d)
  trap 'rm -rf "$work"' EXIT
  {
    grep -v "$HOSTS_TAG\$" /etc/hosts
    printf '127.0.0.1\t%s\t%s\n::1\t%s\t%s\n' "$HOST" "$HOSTS_TAG" "$HOST" "$HOSTS_TAG"
  } > "$work/hosts"
  redirect_rules | pfctl -n -a "$ANCHOR" -f - 2> /dev/null || die "pfctl rejected the redirect rules."
  redirect_plist > "$work/redirect.plist"
  plutil -lint -s "$work/redirect.plist"
  echo "sudo will ask for your Mac password once, to add $HOST to /etc/hosts and redirect port 80 on this machine to :$WEB_PORT."
  sudo /bin/sh -c "$ROOT_STEPS_INSTALL" sh "$HOSTS_BACKUP" "$work/hosts" "$REDIRECT" "$work/redirect.plist" "$REDIRECT_PLIST"
  install
  answers || die "$(address) does not answer yet. See make service-status and make service-logs."
  echo "$(address) answers."
}

host_uninstall() {
  local work
  work=$(mktemp -d)
  trap 'rm -rf "$work"' EXIT
  grep -v "$HOSTS_TAG\$" /etc/hosts > "$work/hosts"
  echo "sudo will ask for your Mac password once, to remove the hosts entries and the port 80 redirect."
  sudo /bin/sh -c "$ROOT_STEPS_UNINSTALL" sh "$work/hosts" "$REDIRECT" "$REDIRECT_PLIST" "$ANCHOR"
  echo "Removed. Delete SERVICE_HOST from .env, then run make service-install to answer on http://localhost:$WEB_PORT again."
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
  if [[ -z "$HOST" ]]; then return 0; fi
  if [[ ! -f "$REDIRECT_PLIST" ]]; then
    echo "address: $(address) needs make service-host-install"
  elif probe; then
    echo "address: $(address) answers"
  else
    echo "address: $(address) does not answer"
  fi
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
  host-install) host_install ;;
  host-uninstall) host_uninstall ;;
  *) die "Usage: scripts/service.sh install|uninstall|start|stop|status|logs|host-install|host-uninstall|running" ;;
esac
