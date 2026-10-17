import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
const script = resolve('scripts/secrets.mjs');
function repository(t) {
  const dir = mkdtempSync(join(tmpdir(), 'secop-hook-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  spawnSync('git', ['init', '-q', dir]);
  return dir;
}
function scan(dir, mode = 'staged') {
  return spawnSync(process.execPath, [script, mode], { cwd: dir, encoding: 'utf8' });
}
test('accepts a clean staged change', t => {
  const dir = repository(t);
  writeFileSync(join(dir, 'README.md'), 'Public documentation\n');
  spawnSync('git', ['add', 'README.md'], { cwd: dir });
  assert.equal(scan(dir).status, 0);
});
test('blocks staged credentials and redacts their value', t => {
  const dir = repository(t);
  const value = ['ghp', '_', 'A7b9C2d4E6f8G1h3J5k7L9m2N4p6Q8r1S3t5'].join('');
  writeFileSync(join(dir, 'config.js'), `export const token = "${value}";\n`);
  spawnSync('git', ['add', 'config.js'], { cwd: dir });
  const result = scan(dir);
  assert.equal(result.status, 1);
  assert.equal((result.stdout + result.stderr).includes(value), false);
});
test('blocks private file paths even without a recognizable secret', t => {
  const dir = repository(t);
  writeFileSync(join(dir, '.env'), 'SESSION_STATE=private\n');
  spawnSync('git', ['add', '-f', '.env'], { cwd: dir });
  assert.equal(scan(dir).status, 1);
});
test('fails closed when the scanner is unavailable', t => {
  const dir = repository(t);
  const result = spawnSync(process.execPath, [script, 'staged'], {
    cwd: dir, encoding: 'utf8', env: { ...process.env, GITLEAKS_BIN: '/missing/gitleaks' },
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Gitleaks/);
});
test('pre-push blocks credentials removed by a later outgoing commit', t => {
  const dir = repository(t);
  const commit = message => spawnSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', message], { cwd: dir });
  writeFileSync(join(dir, 'README.md'), 'Clean base\n');
  spawnSync('git', ['add', '.'], { cwd: dir }); commit('base');
  const base = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).stdout.trim();
  const value = ['ghp', '_', 'A7b9C2d4E6f8G1h3J5k7L9m2N4p6Q8r1S3t5'].join('');
  writeFileSync(join(dir, 'config.js'), `export const token = "${value}";\n`);
  spawnSync('git', ['add', '.'], { cwd: dir }); commit('unsafe');
  writeFileSync(join(dir, 'config.js'), 'export const token = process.env.TOKEN;\n');
  spawnSync('git', ['add', '.'], { cwd: dir }); commit('removed');
  const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).stdout.trim();
  const result = spawnSync(process.execPath, [script, 'push'], {
    cwd: dir, encoding: 'utf8', input: `refs/heads/main ${head} refs/heads/main ${base}\n`,
  });
  assert.equal(result.status, 1);
  assert.equal((result.stdout + result.stderr).includes(value), false);
});
