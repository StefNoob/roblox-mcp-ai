#!/usr/bin/env node

import { spawnSync } from 'node:child_process';

function findLuneCommand() {
  const candidates = process.platform === 'win32'
    ? ['lune.cmd', 'lune.exe', 'lune']
    : ['lune'];

  for (const candidate of candidates) {
    const probe = spawnSync(candidate, ['--version'], { stdio: 'ignore', shell: false });
    if (!probe.error && probe.status === 0) {
      return candidate;
    }
  }

  return null;
}

const lune = findLuneCommand();

if (!lune) {
  console.warn('Skipping Luau e2e: `lune` is not installed or not on PATH.');
  process.exit(0);
}

const result = spawnSync(lune, ['run', 'tests/luau/e2e.luau'], {
  stdio: 'inherit',
  shell: false,
});

if (result.error) {
  console.error(result.error.message);
  process.exit(1);
}

process.exit(result.status ?? 1);
