#!/usr/bin/env bash
# render-demo-docker.sh — render the avatar-compositor demo inside Docker (the
# OPTIONAL, containerised workflow). Builds the image if needed and runs the SAME
# compositor command as the local script (scripts/render-demo.js), so it produces
# the same outputs/result.mp4.
#
# Requires: Docker, and the sample media in ./assets.
# Produces:  outputs/result.mp4.
#
# Prefer no containers? Use the local workflow instead: npm run render
set -euo pipefail
cd "$(dirname "$0")/.."

AVATAR="assets/frame4.mp4"
BROLL="assets/frame2.mp4"
OUT="outputs/result.mp4"

if ! command -v docker >/dev/null 2>&1; then
  echo "ERROR: docker is not installed / not on PATH. Use the local workflow instead: npm run render" >&2
  exit 1
fi

# The sample media may not be present in every checkout, so make sure it is first.
for f in "$AVATAR" "$BROLL"; do
  [ -f "$f" ] || { echo "ERROR: missing $f — put the sample media in assets/ first." >&2; exit 1; }
done

mkdir -p outputs

echo "==> [1/3] Building image (cached after first run)..."
docker compose build

echo "==> [2/3] Rendering demo -> $OUT"
docker compose run --rm compositor node tools/compositor.mjs \
  --avatar "$AVATAR" --broll "$BROLL" --out "$OUT"

echo "==> [3/3] Output summary:"
docker compose run --rm --entrypoint ffprobe compositor \
  -v error -show_entries 'format=duration:stream=codec_type,codec_name,width,height' \
  -of default=noprint_wrappers=1 "$OUT"
ls -lh "$OUT"
echo "==> Done. Play $OUT to view the result."
