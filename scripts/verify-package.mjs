import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, copyFile, mkdir, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import assert from 'node:assert/strict';
const exec = promisify(execFile);
const dir = await mkdtemp(join(tmpdir(), 'paseo-bridge-package-'));
const packed = await exec('npm', ['pack', '--json', '--pack-destination', dir]);
const archive = join(dir, JSON.parse(packed.stdout.slice(packed.stdout.indexOf('[\n')))[0].filename);
const prefix = join(dir, 'installed');
await exec('npm', ['install', '--global', '--prefix', prefix, '--ignore-scripts', '--no-audit', archive]);
for (const name of ['paseo-bridge', 'paseo-bridge-server']) {
  const output = await exec(join(prefix, 'bin', name), ['--help'], { cwd: dir });
  assert(output.stdout.includes(name));
}
const isolated = join(dir, 'standalone'); await mkdir(isolated);
for (const name of ['paseo-bridge', 'paseo-bridge-server']) {
  const target = join(isolated, `${name}.mjs`); await copyFile(resolve(`build/${name}.mjs`), target); await chmod(target, 0o755);
  const output = await exec(target, ['--help'], { cwd: isolated }); assert(output.stdout.includes(name));
}
console.log('npm package commands and standalone binaries verified in isolated directories.');
