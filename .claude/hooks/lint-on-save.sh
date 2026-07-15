#!/bin/bash
# Runs after every file write/edit — auto-lints TypeScript files silently
FILE="$1"
if [[ "$FILE" =~ \.(ts|tsx)$ ]]; then
  npx eslint "$FILE" --fix --quiet 2>/dev/null
fi
exit 0
