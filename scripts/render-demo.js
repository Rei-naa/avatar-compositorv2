#!/usr/bin/env node
// render-demo.js — render the avatar-compositor demo with the LOCAL Node runtime
// and the system ffmpeg/ffprobe (no Docker). Cross-platform: Windows (PowerShell /
// Git Bash), macOS, and Linux. Zero npm dependencies.
//
// It verifies node/ffmpeg/ffprobe are available, ensures outputs/ exists, then runs
// the compositor to produce outputs/result.mp4. For the containerised equivalent
// (same command, same output) see scripts/render-demo-docker.sh.

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
// Honour the same overrides the compositor uses, so both stay in sync.
const ffmpeg = process.env.FFMPEG_PATH || 'ffmpeg';
const ffprobe = process.env.FFPROBE_PATH || 'ffprobe';

const AVATAR = 'assets/frame4.mp4';
const BROLL = 'assets/frame2.mp4';
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
for (const f of [AVATAR, BROLL]) {
  if (!existsSync(join(root, f))) {
    fail(`missing input ${f} — put the sample media in assets/ first.`);
  }
}

// Create outputs/ if it does not already exist.
mkdirSync(join(root, 'outputs'), { recursive: true });

process.stdout.write('Rendering video...\n');
const result = spawnSync(
  process.execPath,
  [join(root, 'tools/compositor.mjs'), '--avatar', AVATAR, '--broll', BROLL, '--out', OUT],
  { cwd: root, stdio: 'inherit' },
);
if (result.error) fail(result.error.message);
if (result.status !== 0) process.exit(result.status || 1);

process.stdout.write('Render complete.\n');
process.stdout.write(`Output saved to: ${OUT}\n`);
