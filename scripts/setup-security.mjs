import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
const checksums = {
  darwin_arm64: 'b40ab0ae55c505963e365f271a8d3846efbc170aa17f2607f13df610a9aeb6a5',
  darwin_x64: 'dfe101a4db2255fc85120ac7f3d25e4342c3c20cf749f2c20a18081af1952709',
  linux_arm64: 'e4a487ee7ccd7d3a7f7ec08657610aa3606637dab924210b3aee62570fb4b080',
  linux_x64: '551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb',
};
const target = `${process.platform}_${process.arch}`;
if (!checksums[target]) throw new Error('Install Gitleaks 8.30.1 manually on this platform.');
const root = fileURLToPath(new URL('../', import.meta.url));
const response = await fetch(`https://github.com/gitleaks/gitleaks/releases/download/v8.30.1/gitleaks_8.30.1_${target}.tar.gz`);
if (!response.ok) throw new Error(`Download failed: ${response.status}`);
const archive = Buffer.from(await response.arrayBuffer());
if (createHash('sha256').update(archive).digest('hex') !== checksums[target]) throw new Error('Gitleaks checksum mismatch.');
const temp = mkdtempSync(join(tmpdir(), 'secop-gitleaks-'));
try {
  const path = join(temp, 'gitleaks.tar.gz');
  writeFileSync(path, archive, { mode: 0o600 });
  mkdirSync(join(root, '.tools'), { recursive: true, mode: 0o700 });
  execFileSync('tar', ['-xzf', path, '-C', join(root, '.tools'), 'gitleaks']);
  chmodSync(join(root, '.tools/gitleaks'), 0o700);
  execFileSync('git', ['config', '--local', 'core.hooksPath', '.githooks'], { cwd: root });
  console.log('Checksum-verified Gitleaks installed; pre-commit and pre-push hooks enabled.');
} finally { rmSync(temp, { recursive: true, force: true }); }
