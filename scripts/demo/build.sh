#!/bin/sh
# Regenerates docs/demo.svg from real agent-state output.
# Requires: a build (npm run build && npm run build:test), npx, python3.
set -e
cd "$(dirname "$0")/../.."
TMP=$(mktemp -d)
node scripts/demo/make-repo.mjs "$TMP/shop"
node scripts/demo/make-cast.mjs "$TMP/shop" "$TMP/demo.cast"
npx -y svg-term-cli@2.1.1 --in "$TMP/demo.cast" --out "$TMP/demo.svg" --window --width 120 --height 43 --padding 12
python3 scripts/demo/fix-svg.py "$TMP/demo.svg" docs/demo.svg
rm -rf "$TMP"
echo "docs/demo.svg updated"
