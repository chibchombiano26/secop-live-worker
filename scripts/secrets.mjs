import { spawnSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const installed = fileURLToPath(new URL('../.tools/gitleaks', import.meta.url));
const scanner = process.env.GITLEAKS_BIN || (existsSync(installed) ? installed : 'gitleaks');
function git(args) {
  const result = spawnSync('git', args, { encoding: 'utf8' });
  if (result.status !== 0) throw new Error('Unable to inspect Git changes.');
  return result.stdout;
}
function checkPaths(paths) {
  const forbidden = paths.filter(path => /(^|\/)(\.superpowers|\.state|\.dev\.vars|[^/]*\.tfstate(?:\..*)?|[^/]*\.private\.[^/]*)(\/|$)/.test(path)
    || /(^|\/)\.env(?:\..*)?$/.test(path) && !/\.env\.(example|sample)$/.test(path));
  if (forbidden.length) throw new Error('Private files must not be versioned: ' + forbidden.join(', '));
}
function scan(args) {
  const result = spawnSync(scanner, ['git', '.', '--no-banner', '--redact=100', '--ignore-gitleaks-allow', ...args], { stdio: 'inherit' });
  if (result.error) throw new Error('Gitleaks is required. Run npm run security:setup.');
  if (result.status !== 0) throw new Error('Gitleaks blocked this operation. Resolve findings before continuing.');
}
try {
  // Fail closed even for an empty index or deletion-only push.
  if (spawnSync(scanner, ['version'], { stdio: 'ignore' }).status !== 0)
    throw new Error('Gitleaks is required. Run npm run security:setup.');
  const mode = process.argv[2] || 'history';
  if (mode === 'staged') {
    checkPaths(git(['diff', '--cached', '--name-only', '--diff-filter=ACMR', '-z']).split('\0').filter(Boolean));
    scan(['--pre-commit', '--staged']);
  } else if (mode === 'push') {
    for (const line of readFileSync(0, 'utf8').trim().split('\n').filter(Boolean)) {
      const [, local, , remote] = line.split(/\s+/);
      if (!/^[0-9a-f]{40,64}$/.test(local) || !/^[0-9a-f]{40,64}$/.test(remote)) throw new Error('Invalid pre-push input.');
      if (/^0+$/.test(local)) continue;
      // Scan every outgoing revision, including secrets added and then removed.
      const range = !/^0+$/.test(remote) && spawnSync('git', ['cat-file', '-e', remote], { stdio: 'ignore' }).status === 0
        ? `${remote}..${local}` : local;
      checkPaths(git(['log', '--format=', '--name-only', '--diff-filter=ACMR', range]).split('\n').filter(Boolean));
      scan([`--log-opts=${range}`]);
    }
  } else if (mode === 'history') {
    checkPaths(git(['ls-files', '-z']).split('\0').filter(Boolean));
    scan(['--log-opts=--all']);
  } else throw new Error('Use staged, push, or history.');
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
