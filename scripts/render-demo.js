#!/usr/bin/env node
// render-demo.js — render the avatar-compositor demo with the LOCAL Node runtime
// and the system ffmpeg/ffprobe (no Docker). Cross-platform: Windows (PowerShell /
// Git Bash), macOS, and Linux. Zero npm dependencies.
//
// It verifies node/ffmpeg/ffprobe are available, ensures outputs/ exists, then
// renders the narrated background-sequence demo (one persistent avatar over an
// ordered b-roll sequence, driven by the voiceover) to outputs/result.mp4. For the
// containerised equivalent (same command, same output) see render-demo-docker.sh.

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
// Honour the same overrides the compositor uses, so both stay in sync.
const ffmpeg = process.env.FFMPEG_PATH || 'ffmpeg';
const ffprobe = process.env.FFPROBE_PATH || 'ffprobe';

// The narrated background-sequence demo: one persistent avatar (frame1) over an
// ordered b-roll sequence, with audio.mp3 as the voiceover that drives the length.
const AVATAR = 'assets/frame1.mp4';
const AVATAR_CENTER_X = '0.52'; // centre frame1's off-centre face in the bubble
const BROLLS = [
  'assets/frame1-background.jpg',
  'assets/frame2.mp4',
  'assets/frame3.mp4',
  'assets/frame4-background.png',
  'assets/frame5.mp4',
  'assets/frame6.mp4',
  'assets/frame7.mp4',
  'assets/frame8.mp4',
  'assets/frame9.mp4',
];
const AUDIO = 'assets/audio.mp3';
const OUT = 'outputs/result.mp4';

function fail(msg) {
  process.stderr.write(`Error: ${msg}\n`);
  process.exit(1);
}

// Is `bin` runnable? Spawn `bin -version` and check for ENOENT — this works the
// same on Windows and Unix without shelling out to where/which.
function hasBinary(bin) {
  const r = spawnSync(bin, ['-version'], { stdio: 'ignore' });
  return !r.error;
}

process.stdout.write('Checking dependencies...\n');

// node: we are already running under it, so just report the version.
process.stdout.write(`  node    ${process.version}\n`);

const missing = [];
if (!hasBinary(ffmpeg)) missing.push(ffmpeg);
if (!hasBinary(ffprobe)) missing.push(ffprobe);
if (missing.length) {
  fail(
    `missing required tool(s) on PATH: ${missing.join(', ')}\n` +
      `Install ffmpeg (it ships with ffprobe) and make sure both are on your PATH: ` +
      `https://ffmpeg.org/download.html`,
  );
}
process.stdout.write(`  ffmpeg  ${ffmpeg}\n  ffprobe ${ffprobe}\n`);

// The sample media is not part of the checkout in every setup, so check first.
for (const f of [AVATAR, ...BROLLS, AUDIO]) {
  if (!existsSync(join(root, f))) {
    fail(`missing input ${f} — put the sample media in assets/ first.`);
  }
}

// Create outputs/ if it does not already exist.
mkdirSync(join(root, 'outputs'), { recursive: true });

process.stdout.write('Rendering video...\n');
const args = [join(root, 'tools/compositor.mjs'), '--avatar', AVATAR, '--avatar-center-x', AVATAR_CENTER_X];
for (const b of BROLLS) args.push('--broll', b);
args.push('--audio', AUDIO, '--out', OUT);

const result = spawnSync(process.execPath, args, { cwd: root, stdio: 'inherit' });
if (result.error) fail(result.error.message);
if (result.status !== 0) process.exit(result.status || 1);

process.stdout.write('Render complete.\n');
process.stdout.write(`Output saved to: ${OUT}\n`);
