# Avatar Compositor

A small standalone Node CLI that invokes `ffmpeg` to place an avatar/host clip
inside a circular picture-in-picture bubble over full-frame b-roll footage.

![layout](docs/layout.svg)

## Requirements

- Node.js 22+
- `ffmpeg` **and** `ffprobe` available on PATH, **or** Docker (the image installs them).

## Installation

No dependencies to install — it's a single zero-dependency Node script. Clone the
repo and run it with Node (`node tools/compositor.mjs …`) or via Docker (below).

## Usage

```bash
node tools/compositor.mjs --avatar assets/frame4.mp4 --broll assets/frame2.mp4 --out outputs/result.mp4
```

The output is a 1920x1080 MP4 where:

- the b-roll is scaled + centre-cropped to **fill** the frame,
- the avatar is cropped into a **324px circular bubble** (~30% of the height) in
  the **bottom-left** corner with a **40px margin**,
- the audio comes from the **avatar** clip (the voiceover),
- the output length equals the **avatar** length; the b-roll is looped
  (`-stream_loop -1`) and trimmed to match.

### Options

```bash
node tools/compositor.mjs \
  --avatar assets/frame4.mp4 \
  --broll  assets/frame2.mp4 \
  --out    outputs/result.mp4 \
  --bubble 324 \
  --margin 40 \
  --position bottom-left \   # or bottom-right / top-left / top-right
  --avatar-center-x 0.5 \    # pan the square crop to centre an off-centre face
  --avatar-border-color '#FFFFFF' \  # optional ring colour (hex or common name)
  --avatar-border-thickness 6 \      # optional ring thickness in px
  --crf 18 \
  --preset veryfast
```

Run `node tools/compositor.mjs --help` for the full option list.

The avatar is square-cropped before the circular mask. If the subject's face
isn't centred in the source frame, pan the crop with `--avatar-center-x`
(`0`=left … `1`=right; `--avatar-center-y` for tall sources) so the face sits in
the middle of the bubble — e.g. `frame1.mp4` centres nicely at `0.52`.

### Optional bubble border

Add a thin ring around the circular bubble with `--avatar-border-color` and
`--avatar-border-thickness`:

- **`--avatar-border-color <color>`** — a hex value (`#FFFFFF`, `#000`, `0xRRGGBB`)
  or a common colour name (`white`, `black`, `red`, …). Defaults to `#FFFFFF` when
  only a thickness is given.
- **`--avatar-border-thickness <px>`** — ring thickness in pixels. Defaults to `6`
  when only a colour is given.

Both flags are **optional and off by default**: omit them and the output is
identical to before. The ring is drawn just *inside* the circle edge, so the
bubble diameter and position are unchanged. It applies to the circular bubble
(pip **and** the background sequence), not to `--variant split`.

The border flags **only affect the bubble's appearance** — they never change the
duration, background sequence, audio, or avatar behaviour. You add them to *any*
of the commands above and everything else renders exactly as it would without
them.

**Minimal example** (single b-roll, no voiceover → a short ~4s clip, just enough
to eyeball the ring):

```bash
node tools/compositor.mjs --avatar assets/frame4.mp4 --broll assets/frame2.mp4 \
  --out outputs/bordered.mp4 --avatar-border-color '#FFFFFF' --avatar-border-thickness 6
```

**Full demo with a border** — the exact same inputs, length (~37s), background
sequence and audio as [`npm run render`](#render-the-demo), with only the border
added:

```bash
node tools/compositor.mjs --avatar assets/frame1.mp4 --avatar-center-x 0.52 \
  --broll assets/frame1-background.jpg --broll assets/frame2.mp4 --broll assets/frame3.mp4 \
  --broll assets/frame4-background.png --broll assets/frame5.mp4 --broll assets/frame6.mp4 \
  --broll assets/frame7.mp4 --broll assets/frame8.mp4 --broll assets/frame9.mp4 \
  --audio assets/audio.mp3 --avatar-border-color '#FFFFFF' --avatar-border-thickness 6 \
  --out outputs/result-bordered.mp4
```

### Bonus variant: split-screen

```bash
node tools/compositor.mjs --avatar assets/frame4.mp4 --broll assets/frame2.mp4 \
  --out outputs/split.mp4 --variant split
```

Produces a left/right split-screen (avatar left, b-roll right), audio from the
avatar, same length-matching behaviour.

### Full-length voiceover (`--audio`)

By default the output length equals the **avatar clip's** length and the audio is
the avatar clip's own track. If your voiceover is a separate file (e.g. a 37s
`audio.mp3`) and the avatar/b-roll are short snippets, pass `--audio`:

```bash
node tools/compositor.mjs --avatar assets/frame4.mp4 --broll assets/frame2.mp4 \
  --audio assets/audio.mp3 --out outputs/voiced.mp4
```

Then the output length = the **audio** length, that track becomes the soundtrack,
and **both** the avatar bubble and the b-roll loop to fill. Note: a short avatar
clip will visibly loop, and it won't lip-sync to an unrelated voiceover — with
these assets it's a "talking-head b-roll" bubble, not synced narration.

### Background sequence (one avatar, many `--broll`)

Pass **one** `--avatar` and **repeat** `--broll` to lay an ordered background
sequence under a single, persistent avatar bubble:

```bash
node tools/compositor.mjs --avatar assets/frame4.mp4 \
  --broll assets/frame1-background.jpg --broll assets/frame2.mp4 --broll assets/frame3.mp4 \
  --broll assets/frame4-background.png --broll assets/frame5.mp4 --broll assets/frame6.mp4 \
  --broll assets/frame7.mp4 --broll assets/frame8.mp4 --broll assets/frame9.mp4 \
  --audio assets/audio.mp3 --out outputs/result.mp4
```

Design (this is the important part):

- **Background timeline** — the `--broll` list is concatenated **exactly once, in
  order**. Video clips play at their **natural length**; still images
  (`.jpg`/`.png`/…) play for `--still-duration` with a slow **zoom**. Nothing is
  skipped, repeated, or reordered.
- **Avatar timeline** — the avatar is a **single global input**, circle-masked
  once and overlaid once over the whole video. It loops on **its own clock**
  (`-stream_loop -1` + one trim to the total), so it stays on screen for the
  entire duration and never restarts at background boundaries. (It still *loops*,
  because the source clip is shorter than the narration — that's expected; the
  compositor does not synthesise or extend the avatar.)
- **Length** — the total is the **sum of the backgrounds** (so the sequence always
  plays in full). When `--audio`/`--duration` is given, the **still** durations
  auto-fit so the total matches the narration.

## Render the demo

Both workflows below run the **same** compositor command — the narrated
background-sequence demo (one persistent avatar over an ordered b-roll sequence,
driven by `audio.mp3`) — and produce the **same** ~37s `outputs/result.mp4`. Pick
one.

### Local (Recommended)

Uses your locally installed tools — no containers. Prerequisites, all on your
PATH:

- **Node.js** 22+
- **ffmpeg**
- **ffprobe** (ships with ffmpeg)

```bash
npm run render
```

This runs [`scripts/render-demo.js`](scripts/render-demo.js), which checks that
`node`, `ffmpeg` and `ffprobe` are available (failing fast with a clear message if
not), creates `outputs/` if needed, and renders with your system ffmpeg:

```bash
node tools/compositor.mjs --avatar assets/frame1.mp4 --avatar-center-x 0.52 \
  --broll assets/frame1-background.jpg --broll assets/frame2.mp4 --broll assets/frame3.mp4 \
  --broll assets/frame4-background.png --broll assets/frame5.mp4 --broll assets/frame6.mp4 \
  --broll assets/frame7.mp4 --broll assets/frame8.mp4 --broll assets/frame9.mp4 \
  --audio assets/audio.mp3 --out outputs/result.mp4
```

### Docker (Optional)

Docker is **optional** — only for those who prefer a containerised environment.
The image installs `ffmpeg`/`ffprobe` for you, so you just need Docker itself.

```bash
npm run render:docker
```

This runs [`scripts/render-demo-docker.sh`](scripts/render-demo-docker.sh), which
builds the image if necessary and runs the same render inside the container. The
equivalent raw command:

```bash
docker compose run --rm compositor node tools/compositor.mjs \
  --avatar assets/frame1.mp4 --avatar-center-x 0.52 \
  --broll assets/frame1-background.jpg --broll assets/frame2.mp4 --broll assets/frame3.mp4 \
  --broll assets/frame4-background.png --broll assets/frame5.mp4 --broll assets/frame6.mp4 \
  --broll assets/frame7.mp4 --broll assets/frame8.mp4 --broll assets/frame9.mp4 \
  --audio assets/audio.mp3 --out outputs/result.mp4
```

The default compose command prints CLI help, so a fresh clone comes up cleanly with
no media:

```bash
docker compose up --build
```

Media is mounted via the `assets/` and `outputs/` volumes in `docker-compose.yml`.

## Checks

```bash
npm run check:js
```

`check:js` runs `node --check` on the module and then `--self-test`, which builds
the filter graphs offline and asserts them (no `ffmpeg` needed).

## Notes / tradeoffs

- **No shared ffmpeg helper to mirror.** The brief pointed at `src/ffmpeg.js`,
  but the repo has no `src/` (and no such file in history), so this module ships
  its own tiny wrapper around `child_process.spawn`. Args are always passed as an
  array (never through a shell), so the filter graph needs no shell-escaping and
  there's no injection surface.
- **Circle without image assets.** The bubble alpha is punched with `ffmpeg`'s
  `geq` at 2x size and downscaled, which anti-aliases the edge — no PNG masks or
  runtime dependencies.
- **Exact duration.** `ffprobe` reads the driving clip's duration (the avatar,
  or the `--audio` track when given) and passes `-t`; if `ffprobe` is unavailable
  it falls back to `-shortest`.
- **Sample media and the demo output are committed** so the demo runs (and
  `outputs/result.mp4` is viewable) straight from a clone. Drop your own clips in
  `assets/` or pass any paths; `npm run render` regenerates `outputs/result.mp4`.

## Limitations

- **The avatar is not a continuous talking track.** If its clip is shorter than
  the narration it loops (by design — the compositor never synthesises or extends
  the avatar). It loops on its own clock, so it doesn't restart at scene cuts.
- **No true background removal / "cutout".** That needs a matting model; `ffmpeg`
  colour-keying can't isolate a host on a non-uniform background.
- **Small source stills upscale soft** when filled to 1080p (e.g. a 500×338 image).
- **The background sequence needs `ffprobe`** to read clip durations.
- Still images are intended as backgrounds in the sequence; single-scene `--broll`
  is designed around video clips.

## Approach

Two independent layers built in one `ffmpeg` graph: the `--broll` list is
`concat`-ed once into the background timeline (videos at natural length, stills
cover-filled with a gentle zoom), and a single circle-masked avatar is overlaid
across the whole thing, looped on its own clock. Length comes from the audio /
backgrounds; the avatar and b-roll are matched to it. Zero npm dependencies, so
the Docker build only needs `apt` for `ffmpeg`. With more time I'd add a real
background-removed cutout variant, an optional bubble drop-shadow (the bubble
border ships now via `--avatar-border-*`), and a fixture-based regression test on
a few sampled output frames.
