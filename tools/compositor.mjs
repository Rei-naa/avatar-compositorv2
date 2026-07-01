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
  --broll  <file>     Footage clip. Looped/trimmed to the avatar length.
  --out    <file>     Output .mp4 path.

Options:
  --variant <name>    pip (default) or split (left/right split-screen).
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
`);
}

function parseArgs(argv) {
  const opts = { ...DEFAULTS };
  const flags = new Set(['help', 'dry-run', 'self-test']);
  const numeric = new Set(['bubble', 'margin', 'width', 'height', 'crf', 'supersample']);
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

// Build the picture-in-picture (circular bubble) filter graph.
function buildPipGraph(o) {
  const { width, height, bubble, margin, position, supersample } = o;
  const pos = POSITIONS[position];
  if (!pos) {
    throw new Error(
      `Unknown --position "${position}". Use: ${Object.keys(POSITIONS).join(', ')}`,
    );
  }
  const { x, y } = pos(margin);
  const big = Math.max(1, Math.round(bubble * supersample));
  const r = big / 2;

  // Avatar (input 0): centre-crop to a square, upscale, punch a hard circular
  // alpha mask with geq, then downscale -> the downscale anti-aliases the edge.
  const avatar =
    `[0:v]crop='min(iw,ih)':'min(iw,ih)',scale=${big}:${big},format=rgba,` +
    `geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':a='if(lte(hypot(X-${r},Y-${r}),${r}),255,0)',` +
    `scale=${bubble}:${bubble}[av]`;

  const bg = `${coverChain('1:v', width, height)}[bg]`;
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
  const args = [
    '-hide_banner',
    '-loglevel', 'warning',
    '-stats',
    '-y',
    '-i', o.avatar,
    '-stream_loop', '-1', '-i', o.broll, // loop b-roll so it always outlasts the avatar
    '-filter_complex', graph,
    '-map', videoLabel,
    '-map', '0:a?', // audio from the avatar clip, if present
  ];
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

async function probeDurationSec(o) {
  try {
    const { out } = await run(
      o.ffprobe,
      [
        '-v', 'error',
        '-show_entries', 'format=duration',
        '-of', 'default=noprint_wrappers=1:nokey=1',
        o.avatar,
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

  process.stdout.write('self-test passed\n');
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));

  if (opts.help) return printHelp();
  if (opts.selfTest) return selfTest();

  const missing = ['avatar', 'broll', 'out'].filter((k) => !opts[k]);
  if (missing.length) {
    throw new Error(
      `Missing required option(s): ${missing.map((m) => `--${m}`).join(', ')}\n` +
        `Run with --help for usage.`,
    );
  }

  for (const k of ['avatar', 'broll']) {
    if (!existsSync(opts[k])) throw new Error(`--${k} file not found: ${opts[k]}`);
  }
  mkdirSync(dirname(resolve(opts.out)), { recursive: true });

  const duration = await probeDurationSec(opts);
  const args = buildFfmpegArgs(opts, duration);

  if (opts.dryRun) {
    process.stdout.write(`${opts.ffmpeg} ${args.map((a) => (/\s/.test(a) ? JSON.stringify(a) : a)).join(' ')}\n`);
    return;
  }

  const durMsg = duration ? `${duration.toFixed(2)}s` : 'shortest-input';
  process.stderr.write(`[compositor] variant=${opts.variant} out=${opts.out} duration=${durMsg}\n`);
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

export { parseArgs, buildGraph, buildPipGraph, buildSplitGraph, buildFfmpegArgs };
