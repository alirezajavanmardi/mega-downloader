#!/usr/bin/env bash
# Export YouTube / Google / Instagram cookies from a browser on YOUR computer into cookies.txt,
# keeping only those domains, so you can upload the file to your server.
#
# Usage: ./scripts/export-cookies.sh [browser[:profile]] [output-file]
#   ./scripts/export-cookies.sh firefox:ytbot
set -euo pipefail

SRC="${1:-firefox}"
OUT="${2:-cookies.txt}"
TMP="$(mktemp)"
trap 'rm -f "$TMP"' EXIT

# Make yt-dlp read the browser cookies and write them out as a Netscape cookie jar
yt-dlp --cookies-from-browser "$SRC" --cookies "$TMP" -s --no-warnings \
  "https://www.youtube.com/watch?v=jNQXAC9IVRw" >/dev/null 2>&1 || true

{
  echo "# Netscape HTTP Cookie File"
  awk -F'\t' 'NF>=7 && $1 !~ /^# / && ($1 ~ /(youtube\.com|google\.[a-z.]+|instagram\.com)$/)' "$TMP"
} > "$OUT"
chmod 600 "$OUT"

echo "Wrote $OUT ($(wc -l < "$OUT" | tr -d ' ') lines)"
echo "Login cookies found (names only):"
awk -F'\t' 'NF>=7 {print $6}' "$OUT" | grep -E '^(SID|SAPISID|__Secure-3PSID|LOGIN_INFO|sessionid)$' | sort -u \
  || echo "  none, so you are not logged in in that browser/profile"
