#!/bin/sh
# Regenerates docs/demo.gif from real agent-state output.
# Requires: npm run build && npm run build:test, and agg
#   (cargo install --locked --git https://github.com/asciinema/agg)
set -e
cd "$(dirname "$0")/../.."
TMP=$(mktemp -d)
node scripts/demo/make-repo.mjs "$TMP/shop"
node scripts/demo/make-cast.mjs "$TMP/shop" "$TMP/demo.cast"
agg --theme github-dark --font-size 15 --line-height 1.3 --idle-time-limit 6 --last-frame-duration 4 "$TMP/demo.cast" docs/demo.gif
rm -rf "$TMP"
echo "docs/demo.gif updated"
