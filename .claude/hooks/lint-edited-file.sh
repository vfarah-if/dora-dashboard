#!/usr/bin/env bash
# PostToolUse hook: lint the file Claude just wrote or edited.
# Exit 2 hands ESLint's findings back to Claude so it fixes them in the same turn.
set -uo pipefail

file=$(jq -r '.tool_response.filePath // .tool_input.file_path // empty')
case "$file" in
  *.ts | *.tsx | *.mts | *.cts | *.js | *.mjs | *.cjs) ;;
  *) exit 0 ;;
esac
[ -f "$file" ] || exit 0

root="${CLAUDE_PROJECT_DIR:-$(pwd)}"
eslint="$root/node_modules/.bin/eslint"
[ -x "$eslint" ] || exit 0

if ! output=$(cd "$root" && "$eslint" --no-warn-ignored --max-warnings 0 "$file" 2>&1); then
  printf 'ESLint found problems in %s. Fix them before moving on.\n%s\n' "$file" "$output" >&2
  exit 2
fi
