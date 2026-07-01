#!/usr/bin/env bash
# render-demo-docker.sh — render the avatar-compositor demo inside Docker (the
# OPTIONAL, containerised workflow). Builds the image if needed and runs the SAME
# compositor command as the local script (scripts/render-demo.js), so it produces
# the same outputs/result.mp4: a narrated background sequence (one avatar over an
# ordered b-roll list, driven by the voiceover).
#
# Requires: Docker, and the sample media in ./assets.
# Produces:  outputs/result.mp4.
#
# Prefer no containers? Use the local workflow instead: npm run render
set -euo pipefail
cd "$(dirname "$0")/.."

OUT="outputs/result.mp4"

if ! command -v docker >/dev/null 2>&1; then
  echo "ERROR: docker is not installed / not on PATH. Use the local workflow instead: npm run render" >&2
  exit 1
fi

# The sample media may not be present in every checkout, so make sure it is first.
for f in assets/frame1.mp4 assets/frame1-background.jpg assets/frame2.mp4 \
         assets/frame3.mp4 assets/frame4-background.png assets/frame5.mp4 \
         assets/frame6.mp4 assets/frame7.mp4 assets/frame8.mp4 assets/frame9.mp4 \
         assets/audio.mp3; do
  [ -f "$f" ] || { echo "ERROR: missing $f — put the sample media in assets/ first." >&2; exit 1; }
done

mkdir -p outputs

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
