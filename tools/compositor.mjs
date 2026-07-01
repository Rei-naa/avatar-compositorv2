#!/usr/bin/env node
// avatar-compositor: a standalone, dependency-free ffmpeg CLI that composites a
// talking-host ("avatar") clip into a circular corner bubble over full-frame
// b-roll. Two modes: single --avatar + single --broll (pip or split), and a
// background sequence (one avatar over an ordered --broll list, played once).
// ffmpeg is spawned with an argv array (never a shell), so the filter graph needs
// no escaping. No shared ffmpeg helper exists in this repo to reuse.

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
  avatarCenterX: 0.5, // where to centre the square avatar crop (0=left, 1=right)
  avatarCenterY: 0.5, // 0=top, 1=bottom; only bites when the source has slack
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
  --avatar <file>     Talking-host clip for the circular bubble. In a background
                      sequence it is ONE persistent overlay (see below).
  --broll  <file>     Full-frame footage: a video clip OR a still image
                      (.jpg/.png/...). Repeat to build a background sequence.
  --out    <file>     Output .mp4 path.

Background sequence:
  Pass ONE --avatar and MULTIPLE --broll to lay an ordered background sequence
  under a single, persistent avatar bubble. The backgrounds play once, in order:
  video clips at their natural length, still images for --still-duration with a
  slow zoom. The avatar stays composited for the whole video (looping if its clip
  is shorter than the narration). Total length is the sum of the backgrounds; when
  --audio/--duration is set, the still durations auto-fit so it matches. Example:
    --avatar host.mp4 --broll bg1.jpg --broll clip2.mp4 --broll clip3.mp4 \\
    --audio vo.mp3 --out story.mp4

Options:
  --variant <name>    pip (default) or split (left/right split-screen). Single
                      --avatar + single --broll only.
  --audio  <file>     Optional external voiceover / narration. Becomes the
                      soundtrack and sets the target length.
  --duration <sec>    Force total output length (overrides probing).
  --still-duration <sec>
                      Seconds each still-image background shows. Default auto-fits
                      to --audio/--duration, else 4s.
  --bubble  <px>      Circular bubble diameter (pip). Default ${DEFAULTS.bubble} (~30% of height).
  --margin  <px>      Edge margin for the bubble (pip). Default ${DEFAULTS.margin}.
  --avatar-center-x <0..1>
                      Horizontal centre of the avatar's square crop (0=left,
                      0.5=centre, 1=right). Pan it to centre an off-centre face.
  --avatar-center-y <0..1>
                      Vertical centre of the crop (only bites if the source is
                      taller than wide). Default 0.5.
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
  node tools/compositor.mjs --avatar assets/frame4.mp4 \\
    --broll assets/frame1-background.jpg --broll assets/frame2.mp4 --broll assets/frame3.mp4 \\
    --broll assets/frame4-background.png --broll assets/frame5.mp4 --broll assets/frame6.mp4 \\
    --broll assets/frame7.mp4 --broll assets/frame8.mp4 --broll assets/frame9.mp4 \\
    --audio assets/audio.mp3 --out outputs/result.mp4
`);
}

function parseArgs(argv) {
  const opts = { ...DEFAULTS };
  const flags = new Set(['help', 'dry-run', 'self-test']);
  const numeric = new Set([
    'bubble', 'margin', 'width', 'height', 'crf', 'duration', 'still-duration',
    'avatar-center-x', 'avatar-center-y',
  ]);
  const lists = new Set(['avatar', 'broll']); // repeatable -> opts.avatars / opts.brolls
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
      (opts[`${key}s`] ||= []).push(value); // main resolves the singular later
      continue;
    }
    opts[camel] = numeric.has(key) ? Number(value) : value;
    if (numeric.has(key) && !Number.isFinite(opts[camel])) {
      throw new Error(`--${key} must be a number, got "${value}"`);
    }
  }
  return opts;
}

// Scale + centre-crop an input to fill w x h (cover, no letterboxing).
function coverChain(inLabel, w, h) {
  return `[${inLabel}]scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h},setsar=1`;
}

function isImage(file) {
  return /\.(jpe?g|png|webp|bmp|gif|tiff?)$/i.test(file);
}

const SUPERSAMPLE = 2; // build the circle mask 2x then downscale -> anti-aliased edge

// Avatar -> square crop, upscale, circular alpha mask via geq, downscale. The crop
// defaults to centred; --avatar-center-x/-y pan it, and clip() keeps it in-frame.
function circleAvatarChain(inLabel, outLabel, o) {
  const { bubble, avatarCenterX = 0.5, avatarCenterY = 0.5 } = o;
  const big = Math.max(1, Math.round(bubble * SUPERSAMPLE));
  const r = big / 2;
  const sq = `'min(iw,ih)'`;
  const crop =
    avatarCenterX === 0.5 && avatarCenterY === 0.5
      ? `crop=${sq}:${sq}` // centred (unchanged default)
      : `crop=${sq}:${sq}:` +
        `'clip(iw*${avatarCenterX}-min(iw,ih)/2,0,iw-min(iw,ih))':` +
        `'clip(ih*${avatarCenterY}-min(iw,ih)/2,0,ih-min(iw,ih))'`;
  return (
    `[${inLabel}]${crop},scale=${big}:${big},format=rgba,` +
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

// Shared H.264/AAC MP4 encode tail, ending with the output path.
function encodeArgs(o) {
  return [
    '-c:v', 'libx264', '-preset', o.preset, '-crf', String(o.crf), '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', o.out,
  ];
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
  args.push(...encodeArgs(o));
  return args;
}

// Still background with a gentle Ken Burns zoom to ZOOM_MAX over its full
// duration; pre-scaled 2x so zoompan's integer crop steps stay smooth.
const ZOOM_MAX = 1.05; // ~5% push: a subtle drift, not a transition
function zoomBgChain(inLabel, outLabel, { width, height, duration, fps }) {
  const frames = Math.max(1, Math.round(duration * fps));
  const zmax = ZOOM_MAX;
  const inc = ((zmax - 1) / frames).toFixed(6);
  return (
    `[${inLabel}]scale=${2 * width}:${2 * height}:force_original_aspect_ratio=increase,` +
    `crop=${2 * width}:${2 * height},` +
    `zoompan=z='min(zoom+${inc},${zmax})':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':` +
    `d=${frames}:s=${width}x${height}:fps=${fps},` +
    `trim=duration=${duration.toFixed(3)},setsar=1,format=yuv420p,setpts=PTS-STARTPTS[${outLabel}]`
  );
}

// One video background segment: cover-fill the frame at its natural length.
function videoBgChain(inLabel, outLabel, { width, height, fps }) {
  return (
    `[${inLabel}]scale=${width}:${height}:force_original_aspect_ratio=increase,` +
    `crop=${width}:${height},setsar=1,fps=${fps},format=yuv420p,setpts=PTS-STARTPTS[${outLabel}]`
  );
}

// Background-sequence render: backgrounds concatenated once (videos at natural
// length, stills zoomed) with ONE avatar overlaid for the whole video. The avatar
// loops on its own clock so it never restarts at a background boundary.
function buildSequenceArgs(o, backgrounds, total, fps = 30) {
  const { width, height, position, margin } = o;
  const { x, y } = overlayPos(position, margin);
  const n = backgrounds.length;

  const args = ['-hide_banner', '-loglevel', 'warning', '-stats', '-y'];
  // Background inputs (in order): stills loop as video (bounded by trim); video
  // clips are read once so the sequence never repeats.
  for (const b of backgrounds) {
    if (b.image) args.push('-loop', '1', '-framerate', String(fps));
    args.push('-i', b.file);
  }
  const avatarIdx = n; // single global avatar input, right after the backgrounds
  args.push('-stream_loop', '-1', '-i', o.avatar);
  const audioIdx = n + 1;
  if (o.audio) args.push('-i', o.audio);

  const chains = [];
  const labels = [];
  backgrounds.forEach((b, k) => {
    chains.push(
      b.image
        ? zoomBgChain(`${k}:v`, `bg${k}`, { width, height, duration: b.duration, fps })
        : videoBgChain(`${k}:v`, `bg${k}`, { width, height, fps }),
    );
    labels.push(`[bg${k}]`);
  });
  // Background timeline: the sequence, in order, exactly once.
  chains.push(`${labels.join('')}concat=n=${n}:v=1:a=0[bgcat]`);

  // Avatar timeline: one continuous, looped track, independent of the backgrounds.
  chains.push(circleAvatarChain(`${avatarIdx}:v`, 'avc', o));
  chains.push(`[avc]fps=${fps},trim=duration=${total.toFixed(3)},setpts=PTS-STARTPTS[av]`);

  // A single overlay of the persistent avatar over the whole background timeline.
  chains.push(`[bgcat][av]overlay=x=${x}:y=${y}[vout]`);

  args.push('-filter_complex', chains.join(';'), '-map', '[vout]');
  if (o.audio) args.push('-map', `${audioIdx}:a`);
  args.push('-t', total.toFixed(3));
  args.push(...encodeArgs(o));
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

// Resolve per-segment durations: videos keep natural length; stills use
// --still-duration or auto-fit so the total matches --audio/--duration. Total is
// the sum of segments, so the sequence always plays once in full.
async function resolveSequence(o, brolls) {
  const backgrounds = brolls.map((file) => ({ file, image: isImage(file) }));
  const natural = await Promise.all(
    backgrounds.map((b) => (b.image ? Promise.resolve(null) : probeDurationSec(b.file, o.ffprobe))),
  );
  backgrounds.forEach((b, i) => {
    if (!b.image && !Number.isFinite(natural[i])) {
      throw new Error(`Could not probe b-roll duration (ffprobe required): ${b.file}`);
    }
  });

  const videoSum = natural.reduce((sum, d) => sum + (d || 0), 0);
  const stillCount = backgrounds.filter((b) => b.image).length;

  let target = Number.isFinite(o.duration) ? o.duration : null;
  if (target === null && o.audio) target = await probeDurationSec(o.audio, o.ffprobe);

  const MIN_STILL = 1;
  const DEFAULT_STILL = 4;
  let stillEach;
  if (Number.isFinite(o.stillDuration)) {
    stillEach = o.stillDuration;
  } else if (Number.isFinite(target) && stillCount > 0) {
    stillEach = Math.max(MIN_STILL, (target - videoSum) / stillCount); // auto-fit to narration
  } else {
    stillEach = DEFAULT_STILL;
  }

  backgrounds.forEach((b, i) => {
    b.duration = b.image ? stillEach : natural[i];
  });
  const total = backgrounds.reduce((sum, b) => sum + b.duration, 0);
  return { backgrounds, total };
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

  // Background sequence: ordered backgrounds concatenated once under ONE avatar.
  const seq = buildSequenceArgs(
    { ...DEFAULTS, avatar: 'host.mp4', audio: 'vo.mp3', out: 'o.mp4' },
    [
      { file: 'bg1.png', image: true, duration: 3 },
      { file: 'clip2.mp4', image: false, duration: 4 },
      { file: 'clip3.mp4', image: false, duration: 5 },
    ],
    12,
  );
  const seqStr = seq.join(' ');
  assert(seq.filter((a) => a === '-i').length === 5, '3 backgrounds + avatar + audio = 5 inputs');
  assert(seq.filter((a) => a === '-loop').length === 1, 'each still background uses -loop 1');
  assert(seq.filter((a) => a === '-stream_loop').length === 1, 'only the avatar loops (single global track)');
  assert(seqStr.includes('zoompan'), 'still background gets a zoom');
  assert(/concat=n=3:v=1:a=0\[bgcat\]/.test(seqStr), 'backgrounds concatenated once, in order');
  assert(seqStr.includes('[3:v]crop='), 'avatar is the input after the 3 backgrounds');
  assert(/\[avc\]fps=30,trim=duration=12\.000/.test(seqStr), 'single avatar timeline spans the whole video');
  assert(/\[bgcat\]\[av\]overlay=x=40:y=H-h-40\[vout\]/.test(seqStr), 'one overlay of the global avatar');
  assert(seq[seq.indexOf('-t') + 1] === '12.000', 'total = background sequence length');
  assert(seq.includes('4:a'), 'narration mapped from the last input');

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
  for (const f of [...avatars, ...brolls]) {
    if (!existsSync(f)) throw new Error(`Input file not found: ${f}`);
  }
  if (opts.audio && !existsSync(opts.audio)) {
    throw new Error(`--audio file not found: ${opts.audio}`);
  }
  mkdirSync(dirname(resolve(opts.out)), { recursive: true });

  let args;
  let duration;
  const isSingle = avatars.length === 1 && brolls.length === 1;

  if (isSingle) {
    // Single avatar + single b-roll (unchanged): pip or split, avatar/audio drive length.
    opts.avatar = avatars[0];
    opts.broll = brolls[0];
    duration = opts.duration || (await probeDurationSec(opts.audio || opts.avatar, opts.ffprobe));
    args = buildFfmpegArgs(opts, duration);
  } else {
    // Background sequence: many --broll under ONE persistent avatar (--avatar).
    if (opts.variant !== 'pip') {
      throw new Error('The background sequence supports only --variant pip.');
    }
    if (avatars.length > 1) {
      process.stderr.write(
        `[compositor] note: ${avatars.length} --avatar clips given; using the first as the ` +
          `single persistent overlay (the avatar is one global track, not per-scene).\n`,
      );
    }
    opts.avatar = avatars[0];
    const seq = await resolveSequence(opts, brolls);
    duration = seq.total;
    args = buildSequenceArgs(opts, seq.backgrounds, duration);
  }

  if (opts.dryRun) {
    process.stdout.write(`${opts.ffmpeg} ${args.map((a) => (/\s/.test(a) ? JSON.stringify(a) : a)).join(' ')}\n`);
    return;
  }

  const durMsg = duration ? `${duration.toFixed(2)}s` : 'shortest-input';
  const mode = isSingle ? `variant=${opts.variant}` : `sequence=${brolls.length}`;
  process.stderr.write(`[compositor] ${mode} out=${opts.out} duration=${durMsg}\n`);
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
  buildSequenceArgs,
};
