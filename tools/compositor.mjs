#!/usr/bin/env node
// avatar-compositor
//
// Standalone CLI that shells out to ffmpeg to composite a talking-host
// ("avatar") clip over full-frame b-roll footage.
//
//   node tools/compositor.mjs --avatar avatar.mp4 --broll broll.mp4 --out result.mp4
//
// Default layout (matches the spec / diagram):
//   - b-roll is scaled + centre-cropped to fill the whole 1920x1080 frame,
//   - the avatar sits in a circular bubble in the bottom-left corner
//     (~30% of the height = 324px, 40px margin from the edges),
//   - audio is taken from the avatar clip (the voiceover),
//   - output length == avatar length; the b-roll is looped/trimmed to match.
//
// There is no shared ffmpeg helper in this repo to mirror (src/ffmpeg.js does
// not exist), so this module keeps its own tiny, dependency-free wrapper around
// child_process.spawn: arguments are always passed as an array (never through a
// shell), which sidesteps quoting/injection issues with the filter graph.

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULTS = {
  width: 1920,
  height: 1080,
  bubble: 324, // ~30% of 1080
  margin: 40,
  position: 'bottom-left',
  variant: 'pip', // pip | split
  crf: 18,
  preset: 'veryfast',
  ffmpeg: process.env.FFMPEG_PATH || 'ffmpeg',
  ffprobe: process.env.FFPROBE_PATH || 'ffprobe',
  supersample: 2, // render the circle mask NxN larger, then downscale for AA
};

const POSITIONS = {
  // overlay vars: W,H = background size; w,h = overlay (bubble) size
  'bottom-left': (m) => ({ x: `${m}`, y: `H-h-${m}` }),
  'bottom-right': (m) => ({ x: `W-w-${m}`, y: `H-h-${m}` }),
  'top-left': (m) => ({ x: `${m}`, y: `${m}` }),
  'top-right': (m) => ({ x: `W-w-${m}`, y: `${m}` }),
};

function printHelp() {
  process.stdout.write(`avatar-compositor

Composite an avatar/host clip over full-frame b-roll with ffmpeg.

Usage:
  node tools/compositor.mjs --avatar <file> --broll <file> --out <file> [options]

Required:
  --avatar <file>     Talking-host clip. Drives output length + supplies audio.
                      Repeat with --broll to add scenes (see below).
  --broll  <file>     Full-frame footage: a video clip OR a still image
                      (.jpg/.png/...). Looped/trimmed to length.
  --out    <file>     Output .mp4 path.

Scenes (storyboard):
  Repeat --avatar / --broll in pairs to build a multi-scene video; the pairs are
  concatenated and each gets an equal slice of the total length. Requires --audio
  or --duration to set the total. Example:
    --broll bg1.png --avatar host1.mp4 --broll bg2.png --avatar host2.mp4 \\
    --audio vo.mp3 --out story.mp4

Options:
  --variant <name>    pip (default) or split (left/right split-screen).
  --audio  <file>     Optional external voiceover. Makes it the soundtrack, sets
                      output length to its duration, and loops the avatar + b-roll
                      to fill. Omit to use the avatar clip's own audio + length.
  --duration <sec>    Force total output length (overrides probing).
  --bubble  <px>      Circular bubble diameter (pip). Default ${DEFAULTS.bubble} (~30% of height).
  --margin  <px>      Edge margin for the bubble (pip). Default ${DEFAULTS.margin}.
  --position <pos>    bubble corner (pip): bottom-left (default), bottom-right,
                      top-left, top-right.
  --width   <px>      Output width. Default ${DEFAULTS.width}.
  --height  <px>      Output height. Default ${DEFAULTS.height}.
  --crf     <n>       x264 quality (lower = better). Default ${DEFAULTS.crf}.
  --preset  <name>    x264 preset. Default ${DEFAULTS.preset}.
  --ffmpeg  <path>    ffmpeg binary. Default "${DEFAULTS.ffmpeg}" (env FFMPEG_PATH).
  --ffprobe <path>    ffprobe binary. Default "${DEFAULTS.ffprobe}" (env FFPROBE_PATH).
  --dry-run           Print the ffmpeg command and exit (no render).
  --self-test         Build the filter graphs offline and assert them (no ffmpeg).
  --help              Show this help.

Examples:
  node tools/compositor.mjs --avatar assets/frame4.mp4 --broll assets/frame2.mp4 --out outputs/result.mp4
  node tools/compositor.mjs --avatar assets/frame4.mp4 --broll assets/frame2.mp4 --out outputs/split.mp4 --variant split
  node tools/compositor.mjs --avatar assets/frame4.mp4 --broll assets/frame2.mp4 --audio assets/audio.mp3 --out outputs/voiced.mp4
  node tools/compositor.mjs \\
    --broll assets/frame1-background.jpg --avatar assets/frame1.mp4 \\
    --broll assets/frame4-background.png --avatar assets/frame4.mp4 \\
    --audio assets/audio.mp3 --out outputs/result.mp4
`);
}

function parseArgs(argv) {
  const opts = { ...DEFAULTS };
  const flags = new Set(['help', 'dry-run', 'self-test']);
  const numeric = new Set(['bubble', 'margin', 'width', 'height', 'crf', 'supersample', 'duration']);
  const lists = new Set(['avatar', 'broll']); // repeatable -> one scene per pair
  for (let i = 0; i < argv.length; i++) {
    let arg = argv[i];
    if (!arg.startsWith('--')) throw new Error(`Unexpected argument: ${arg}`);
    let key = arg.slice(2);
    let value;
    const eq = key.indexOf('=');
    if (eq !== -1) {
      value = key.slice(eq + 1);
      key = key.slice(0, eq);
    }
    const camel = key.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    if (flags.has(key)) {
      opts[camel] = true;
      continue;
    }
    if (value === undefined) {
      value = argv[++i];
      if (value === undefined) throw new Error(`Missing value for --${key}`);
    }
    if (lists.has(key)) {
      (opts[`${key}s`] ||= []).push(value); // opts.avatars / opts.brolls
      opts[camel] = value; // keep last for back-compat / single-scene reuse
      continue;
    }
    opts[camel] = numeric.has(key) ? Number(value) : value;
    if (numeric.has(key) && !Number.isFinite(opts[camel])) {
      throw new Error(`--${key} must be a number, got "${value}"`);
    }
  }
  return opts;
}

// b-roll (input 1) -> cover the full frame.
function coverChain(inputLabel, w, h) {
  return `[${inputLabel}]scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h},setsar=1`;
}

function isImage(file) {
  return /\.(jpe?g|png|webp|bmp|gif|tiff?)$/i.test(file);
}

// Pre-`-i` flags that turn an input into an infinite looping source: a still
// image is looped as video (`-loop 1`), a clip loops its stream (`-stream_loop`).
function loopInputFlags(file, fps) {
  return isImage(file)
    ? ['-loop', '1', '-framerate', String(fps)]
    : ['-stream_loop', '-1'];
}

// Avatar -> centre-crop to a square, upscale, punch a hard circular alpha mask
// with geq, then downscale (the downscale anti-aliases the edge).
function circleAvatarChain(inLabel, outLabel, { bubble, supersample }) {
  const big = Math.max(1, Math.round(bubble * supersample));
  const r = big / 2;
  return (
    `[${inLabel}]crop='min(iw,ih)':'min(iw,ih)',scale=${big}:${big},format=rgba,` +
    `geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':a='if(lte(hypot(X-${r},Y-${r}),${r}),255,0)',` +
    `scale=${bubble}:${bubble}[${outLabel}]`
  );
}

function overlayPos(position, margin) {
  const pos = POSITIONS[position];
  if (!pos) {
    throw new Error(
      `Unknown --position "${position}". Use: ${Object.keys(POSITIONS).join(', ')}`,
    );
  }
  return pos(margin);
}

// Build the picture-in-picture (circular bubble) filter graph.
function buildPipGraph(o) {
  const { width, height, margin, position } = o;
  const { x, y } = overlayPos(position, margin);
  const avatar = circleAvatarChain('0:v', 'av', o); // avatar = input 0
  const bg = `${coverChain('1:v', width, height)}[bg]`; // b-roll = input 1
  const overlay = `[bg][av]overlay=x=${x}:y=${y}[vout]`;
  return { graph: [bg, avatar, overlay].join(';'), videoLabel: '[vout]' };
}

// Build the left/right split-screen filter graph (bonus variant).
function buildSplitGraph(o) {
  const { width, height } = o;
  const half = Math.round(width / 2);
  const left = `${coverChain('0:v', half, height)}[l]`; // avatar
  const right = `${coverChain('1:v', half, height)}[r]`; // b-roll
  const stack = `[l][r]hstack=inputs=2[vout]`;
  return { graph: [left, right, stack].join(';'), videoLabel: '[vout]' };
}

function buildGraph(o) {
  if (o.variant === 'pip') return buildPipGraph(o);
  if (o.variant === 'split') return buildSplitGraph(o);
  throw new Error(`Unknown --variant "${o.variant}". Use: pip, split`);
}

function buildFfmpegArgs(o, durationSec) {
  const { graph, videoLabel } = buildGraph(o);
  const hasExternalAudio = Boolean(o.audio);

  const args = ['-hide_banner', '-loglevel', 'warning', '-stats', '-y'];
  // Input 0: avatar. Loop it only when an external voiceover extends the length
  // beyond the clip (otherwise the avatar clip itself drives duration).
  if (hasExternalAudio) args.push('-stream_loop', '-1');
  args.push('-i', o.avatar);
  // Input 1: b-roll, always looped so it outlasts the avatar.
  args.push('-stream_loop', '-1', '-i', o.broll);
  // Input 2 (optional): external voiceover track.
  if (hasExternalAudio) args.push('-i', o.audio);

  args.push('-filter_complex', graph, '-map', videoLabel);
  // Audio: the external voiceover if given, else the avatar clip's own track.
  args.push('-map', hasExternalAudio ? '2:a' : '0:a?');

  // Prefer an explicit duration (exact + deterministic); fall back to -shortest.
  if (Number.isFinite(durationSec) && durationSec > 0) {
    args.push('-t', durationSec.toFixed(3));
  } else {
    args.push('-shortest');
  }
  args.push(
    '-c:v', 'libx264',
    '-preset', o.preset,
    '-crf', String(o.crf),
    '-pix_fmt', 'yuv420p',
    '-c:a', 'aac',
    '-b:a', '192k',
    '-movflags', '+faststart',
    o.out,
  );
  return args;
}

// Build a multi-scene render: each scene is a (background, avatar) pair composited
// as a PiP, trimmed to an equal slice of the total, then concatenated. Backgrounds
// may be stills or clips; the total is driven by --audio (or --duration). The last
// scene is padded slightly so the video always covers the full audio.
function buildScenesArgs(o, scenes, totalDuration, fps = 30) {
  const { width, height, position, margin, crf, preset } = o;
  const { x, y } = overlayPos(position, margin);
  const n = scenes.length;
  const per = totalDuration / n;

  const args = ['-hide_banner', '-loglevel', 'warning', '-stats', '-y'];
  // Inputs, in order: for each scene the background then the avatar; then audio.
  for (const s of scenes) {
    args.push(...loopInputFlags(s.broll, fps), '-i', s.broll);
    args.push(...loopInputFlags(s.avatar, fps), '-i', s.avatar);
  }
  if (o.audio) args.push('-i', o.audio);

  const chains = [];
  const sceneLabels = [];
  scenes.forEach((s, k) => {
    const bgIn = 2 * k;
    const avIn = 2 * k + 1;
    const dur = (k === n - 1 ? per + 1 : per).toFixed(3); // pad last -> covers audio
    chains.push(
      `[${bgIn}:v]scale=${width}:${height}:force_original_aspect_ratio=increase,` +
        `crop=${width}:${height},setsar=1,fps=${fps},format=yuv420p,` +
        `trim=duration=${dur},setpts=PTS-STARTPTS[bg${k}]`,
    );
    chains.push(circleAvatarChain(`${avIn}:v`, `avc${k}`, o));
    chains.push(`[avc${k}]fps=${fps},trim=duration=${dur},setpts=PTS-STARTPTS[av${k}]`);
    chains.push(`[bg${k}][av${k}]overlay=x=${x}:y=${y},format=yuv420p[scene${k}]`);
    sceneLabels.push(`[scene${k}]`);
  });
  chains.push(`${sceneLabels.join('')}concat=n=${n}:v=1:a=0[vout]`);

  args.push('-filter_complex', chains.join(';'), '-map', '[vout]');
  if (o.audio) args.push('-map', `${2 * n}:a`);
  args.push('-t', totalDuration.toFixed(3));
  args.push(
    '-c:v', 'libx264',
    '-preset', preset,
    '-crf', String(crf),
    '-pix_fmt', 'yuv420p',
    '-c:a', 'aac',
    '-b:a', '192k',
    '-movflags', '+faststart',
    o.out,
  );
  return args;
}

function run(bin, args, { capture = false } = {}) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(bin, args, {
      stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    });
    let out = '';
    let err = '';
    if (capture) {
      child.stdout.on('data', (d) => (out += d));
      child.stderr.on('data', (d) => (err += d));
    }
    child.on('error', (e) => {
      if (e.code === 'ENOENT') {
        rejectRun(new Error(`Could not run "${bin}". Is it installed / on PATH?`));
      } else {
        rejectRun(e);
      }
    });
    child.on('close', (code) => {
      if (code === 0) resolveRun({ out, err });
      else rejectRun(new Error(`${bin} exited with code ${code}${err ? `\n${err}` : ''}`));
    });
  });
}

async function probeDurationSec(file, ffprobe) {
  try {
    const { out } = await run(
      ffprobe,
      [
        '-v', 'error',
        '-show_entries', 'format=duration',
        '-of', 'default=noprint_wrappers=1:nokey=1',
        file,
      ],
      { capture: true },
    );
    const d = Number.parseFloat(out.trim());
    return Number.isFinite(d) ? d : null;
  } catch {
    // ffprobe missing/failed -> caller falls back to -shortest.
    return null;
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(`self-test failed: ${msg}`);
}

function selfTest() {
  const pip = buildPipGraph({ ...DEFAULTS });
  assert(pip.graph.includes('overlay=x=40:y=H-h-40'), 'pip bottom-left overlay position');
  assert(pip.graph.includes('scale=1920:1080:force_original_aspect_ratio=increase'), 'b-roll cover scale');
  assert(pip.graph.includes('crop=1920:1080'), 'b-roll crop to frame');
  assert(/geq=.*a='if\(lte\(hypot/.test(pip.graph), 'circular alpha mask');
  assert(pip.graph.includes('scale=324:324[av]'), 'bubble downscale to 324');

  const br = buildPipGraph({ ...DEFAULTS, position: 'bottom-right', margin: 40 });
  assert(br.graph.includes('overlay=x=W-w-40:y=H-h-40'), 'pip bottom-right overlay position');

  const split = buildSplitGraph({ ...DEFAULTS });
  assert(split.graph.includes('hstack=inputs=2'), 'split hstack');
  assert(split.graph.includes('[0:v]scale=960:1080'), 'split left half from avatar');
  assert(split.graph.includes('[1:v]scale=960:1080'), 'split right half from b-roll');

  const args = buildFfmpegArgs({ ...DEFAULTS, avatar: 'a.mp4', broll: 'b.mp4', out: 'o.mp4' }, 4);
  assert(args.includes('-stream_loop') && args[args.indexOf('-stream_loop') + 1] === '-1', 'b-roll stream_loop -1');
  assert(args[args.indexOf('-t') + 1] === '4.000', 'explicit output duration');
  assert(args.includes('0:a?'), 'audio mapped from avatar');

  // With an external voiceover: avatar loops too and audio comes from input 2.
  const av = buildFfmpegArgs(
    { ...DEFAULTS, avatar: 'a.mp4', broll: 'b.mp4', audio: 'vo.mp3', out: 'o.mp4' },
    37,
  );
  assert(av.filter((a) => a === '-stream_loop').length === 2, 'avatar + b-roll both looped with --audio');
  assert(av.includes('vo.mp3') && av.includes('2:a'), 'external voiceover mapped as audio');
  assert(!av.includes('0:a?'), 'avatar audio not mapped when --audio is set');

  // Multi-scene: two (background, avatar) pairs concatenated over one voiceover.
  const scenes = buildScenesArgs(
    { ...DEFAULTS, audio: 'vo.mp3', out: 'o.mp4' },
    [
      { broll: 'bg1.png', avatar: 'a1.mp4' },
      { broll: 'bg2.jpg', avatar: 'a2.mp4' },
    ],
    36,
  );
  const scenesStr = scenes.join(' ');
  assert(scenes.filter((a) => a === '-i').length === 5, 'two scenes -> 4 media inputs + 1 audio');
  assert(scenes.includes('-loop'), 'image background uses -loop 1');
  assert(scenes.includes('-stream_loop'), 'clip avatar uses -stream_loop');
  assert(/concat=n=2:v=1:a=0\[vout\]/.test(scenesStr), 'two scenes concatenated');
  assert(scenes[scenes.indexOf('-t') + 1] === '36.000', 'multi-scene total duration');
  assert(scenes.includes('4:a'), 'audio mapped from the last (voiceover) input');

  process.stdout.write('self-test passed\n');
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));

  if (opts.help) return printHelp();
  if (opts.selfTest) return selfTest();

  const avatars = opts.avatars || [];
  const brolls = opts.brolls || [];
  const missing = [];
  if (!avatars.length) missing.push('--avatar');
  if (!brolls.length) missing.push('--broll');
  if (!opts.out) missing.push('--out');
  if (missing.length) {
    throw new Error(`Missing required option(s): ${missing.join(', ')}\nRun with --help for usage.`);
  }
  if (avatars.length !== brolls.length) {
    throw new Error(
      `--avatar (${avatars.length}) and --broll (${brolls.length}) counts must match; ` +
        `each pair is one scene.`,
    );
  }
  for (const f of [...avatars, ...brolls]) {
    if (!existsSync(f)) throw new Error(`Input file not found: ${f}`);
  }
  if (opts.audio && !existsSync(opts.audio)) {
    throw new Error(`--audio file not found: ${opts.audio}`);
  }
  mkdirSync(dirname(resolve(opts.out)), { recursive: true });

  const scenes = avatars.map((avatar, i) => ({ avatar, broll: brolls[i] }));
  let args;
  let duration;

  if (scenes.length === 1) {
    opts.avatar = scenes[0].avatar;
    opts.broll = scenes[0].broll;
    // Length is driven by --duration, else the voiceover, else the avatar clip.
    duration = opts.duration || (await probeDurationSec(opts.audio || opts.avatar, opts.ffprobe));
    args = buildFfmpegArgs(opts, duration);
  } else {
    if (opts.variant && opts.variant !== 'pip') {
      throw new Error('Multi-scene rendering supports only --variant pip.');
    }
    duration = opts.duration;
    if (!duration && opts.audio) duration = await probeDurationSec(opts.audio, opts.ffprobe);
    if (!duration) {
      const each = await Promise.all(scenes.map((s) => probeDurationSec(s.avatar, opts.ffprobe)));
      if (each.every((d) => Number.isFinite(d))) duration = each.reduce((a, b) => a + b, 0);
    }
    if (!Number.isFinite(duration) || duration <= 0) {
      throw new Error('Could not determine total duration. Pass --audio or --duration for multi-scene.');
    }
    args = buildScenesArgs(opts, scenes, duration);
  }

  if (opts.dryRun) {
    process.stdout.write(`${opts.ffmpeg} ${args.map((a) => (/\s/.test(a) ? JSON.stringify(a) : a)).join(' ')}\n`);
    return;
  }

  const durMsg = duration ? `${duration.toFixed(2)}s` : 'shortest-input';
  process.stderr.write(`[compositor] scenes=${scenes.length} out=${opts.out} duration=${durMsg}\n`);
  await run(opts.ffmpeg, args);
  process.stderr.write(`[compositor] done -> ${opts.out}\n`);
}

// Run as a CLI only when invoked directly (keeps the functions importable).
const invokedDirectly =
  process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  main().catch((e) => {
    process.stderr.write(`Error: ${e.message}\n`);
    process.exit(1);
  });
}

export {
  parseArgs,
  buildGraph,
  buildPipGraph,
  buildSplitGraph,
  buildFfmpegArgs,
  buildScenesArgs,
};
