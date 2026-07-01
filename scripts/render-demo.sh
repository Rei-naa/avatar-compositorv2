#!/usr/bin/env bash
# render-demo.sh — run the avatar compositor end-to-end (via Docker) on the
# sample assets and report the resulting video.
#
# Requires: Docker, and the sample media in ./assets (git-ignored).
# Produces:  outputs/result.mp4 (git-ignored).
set -euo pipefail
cd "$(dirname "$0")/.."

OUT="outputs/result.mp4"

# The sample media is git-ignored, so make sure it is actually present first.
for f in assets/frame1.mp4 assets/frame1-background.jpg assets/audio.mp3; do
  [ -f "$f" ] || { echo "ERROR: missing $f — put the sample media in assets/ first." >&2; exit 1; }
done

echo "==> [1/3] Building image (cached after first run)..."
docker compose build

echo "==> [2/3] Rendering background-sequence demo -> $OUT"
docker compose run --rm compositor node tools/compositor.mjs \
  --avatar assets/frame1.mp4 --avatar-center-x 0.52 \
  --broll assets/frame1-background.jpg --broll assets/frame2.mp4 --broll assets/frame3.mp4 \
  --broll assets/frame4-background.png --broll assets/frame5.mp4 --broll assets/frame6.mp4 \
  --broll assets/frame7.mp4 --broll assets/frame8.mp4 --broll assets/frame9.mp4 \
  --audio assets/audio.mp3 --out "$OUT"

echo "==> [3/3] Output summary:"
docker compose run --rm --entrypoint ffprobe compositor \
  -v error -show_entries 'format=duration:stream=codec_type,codec_name,width,height' \
  -of default=noprint_wrappers=1 "$OUT"
ls -lh "$OUT"
echo "==> Done. Play $OUT to view the result."
