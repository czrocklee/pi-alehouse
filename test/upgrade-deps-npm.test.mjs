import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { runUpgrade } from '../scripts/upgrade-deps.mjs';

const success = { status: 0, stdout: '', stderr: '' };
const offlineConfig = ['config', 'get', 'offline', '--json'];
const fixtureName = 'alehouse-offline-fixture';

function withFixture(run) {
  const base = mkdtempSync(join(tmpdir(), 'alehouse-upgrade-native-npm-'));
  try {
    // Keep the normal npm executable/PATH, but never inherit npm configuration,
    // user config files, credentials in those files, or a shared npm cache.
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^npm_config_/i.test(key)));
    Object.assign(env, {
      HOME: join(base, 'home'),
      XDG_CONFIG_HOME: join(base, 'xdg-config'),
      XDG_CACHE_HOME: join(base, 'xdg-cache'),
      XDG_DATA_HOME: join(base, 'xdg-data'),
      XDG_STATE_HOME: join(base, 'xdg-state'),
      npm_config_userconfig: join(base, 'user.npmrc'),
      npm_config_globalconfig: join(base, 'global.npmrc'),
      npm_config_cache: join(base, 'npm-cache'),
      npm_config_offline: 'true',
    });
    for (const path of [env.HOME, env.XDG_CONFIG_HOME, env.XDG_CACHE_HOME, env.XDG_DATA_HOME, env.XDG_STATE_HOME]) {
      mkdirSync(path);
    }
    writeFileSync(env.npm_config_userconfig, '');
    writeFileSync(env.npm_config_globalconfig, '');
    function npm(args, cwd, extraEnv = {}) {
      // A regression must fail before invoking audit, even though offline=true
      // also prevents registry IO. Only the config query is needed in this lane.
      assert.notEqual(args[0], 'audit', 'offline verification must not invoke npm audit');
      assert.equal(args.includes('--offline=false'), false, 'native fixture must stay offline');
      const result = spawnSync('npm', args, {
        cwd, env: { ...env, ...extraEnv }, shell: false,
        encoding: 'utf8', maxBuffer: 4 * 1024 * 1024,
        timeout: 20_000, killSignal: 'SIGKILL',
      });
      assert.ifError(result.error); // Missing npm is a blocker, never a silent skip.
      assert.equal(result.signal, null, `npm ${args.join(' ')} terminated: ${result.stderr}`);
      return result;
    }

    const packageDir = join(base, 'package');
    mkdirSync(packageDir);
    writeFileSync(join(packageDir, 'package.json'), JSON.stringify({ name: fixtureName, version: '1.0.0' }));
    writeFileSync(join(packageDir, 'index.js'), 'module.exports = "offline fixture";\n');
    const packed = npm(['pack', '--offline', '--ignore-scripts', '--json', '--pack-destination', base], packageDir);
    assert.equal(packed.status, 0, packed.stderr);
    const tarball = join(base, JSON.parse(packed.stdout)[0].filename);
    const integrity = `sha512-${createHash('sha512').update(readFileSync(tarball)).digest('base64')}`;
    const root = join(base, 'source');
    mkdirSync(root);
    mkdirSync(join(root, '.git'));
    mkdirSync(join(root, 'node_modules'));
    const sentinel = join(root, 'node_modules', 'stale-sentinel');
    writeFileSync(sentinel, 'must be removed by a real npm ci\n');
    const manifest = { name: 'pi-alehouse', version: '1.0.0', private: true, dependencies: { [fixtureName]: '1.0.0' } };
    writeFileSync(join(root, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`);
    writeFileSync(join(root, 'package-lock.json'), `${JSON.stringify({
      name: manifest.name, version: manifest.version, lockfileVersion: 3, requires: true,
      packages: {
        '': { name: manifest.name, version: manifest.version, dependencies: manifest.dependencies },
        [`node_modules/${fixtureName}`]: { version: '1.0.0', resolved: `file:${tarball}`, integrity },
      },
    }, null, 2)}\n`);
    return run({ root, sentinel, npm });
  } finally {
    // Every path removed here belongs to this test, including npm's local cache.
    rmSync(base, { recursive: true, force: true });
  }
}

for (const inheritedSetting of ['npm_config_dry_run', 'npm_config_package_lock_only']) {
  test(`native npm ci installs despite inherited ${inheritedSetting}=true`, { timeout: 60_000 }, () => {
    withFixture(({ root, sentinel, npm }) => {
      const calls = [];
      const nativeCalls = [];
      const originals = ['package.json', 'package-lock.json'].map(path => readFileSync(join(root, path)));
      const report = runUpgrade({ mode: 'apply', packages: [fixtureName] }, {
        root,
        runNpm(args, { cwd }) {
          calls.push([...args]);
          if (args[0] === 'view') {
            assert.deepEqual(args, ['view', fixtureName, 'dist-tags.latest', '--json']);
            return { ...success, stdout: '"1.0.0"' };
          }
          const result = npm(args, cwd, { [inheritedSetting]: 'true' });
          nativeCalls.push({ args: [...args], cwd, result });
          return result;
        },
      });
      assert.equal(report.ok, true, JSON.stringify(report));
      assert.equal(report.applied, true);
      assert.equal(calls.filter(args => args[0] === 'view').length, 1);
      const ci = nativeCalls.filter(call => call.args[0] === 'ci');
      assert.equal(ci.length, 1, 'one real source synchronization is required');
      assert.equal(ci[0].cwd, root);
      assert.equal(ci[0].result.status, 0, ci[0].result.stderr);
      for (const flag of ['--include=dev', '--dry-run=false', '--package-lock-only=false', '--ignore-scripts', '--no-audit', '--no-fund']) {
        assert.ok(ci[0].args.includes(flag), `npm ci missing ${flag}`);
      }
      assert.equal(existsSync(sentinel), false, 'a dry-run/lock-only success must not leave the stale install');
      const installed = join(root, 'node_modules', fixtureName);
      assert.equal(JSON.parse(readFileSync(join(installed, 'package.json'), 'utf8')).version, '1.0.0');
      assert.equal(readFileSync(join(installed, 'index.js'), 'utf8'), 'module.exports = "offline fixture";\n');
      for (const [index, path] of ['package.json', 'package-lock.json'].entries()) {
        assert.deepEqual(readFileSync(join(root, path)), originals[index], `same-version apply changed ${path}`);
      }
    });
  });
}

test('native offline npm config makes both audits unrun/unknown, never clean', { timeout: 60_000 }, () => {
  withFixture(({ root, npm }) => {
    const calls = [];
    const nativeCalls = [];
    const report = runUpgrade({ mode: 'verify', packages: [] }, {
      root,
      runNpm(args, { cwd }) {
        calls.push([...args]);
        if (args[0] === 'run') {
          assert.ok(args[1] === 'build' || args[1] === 'check');
          assert.equal(args.length, 2);
          return success; // Portable gates are intentionally not executed in this fixture.
        }
        const result = npm(args, cwd);
        nativeCalls.push({ args: [...args], result });
        return result;
      },
    });
    assert.deepEqual(calls, [['run', 'build'], ['run', 'check'], offlineConfig]);
    assert.equal(nativeCalls.length, 1, 'query effective npm config exactly once after the gates');
    assert.deepEqual(nativeCalls[0].args, offlineConfig);
    assert.equal(nativeCalls[0].result.status, 0, nativeCalls[0].result.stderr);
    assert.equal(JSON.parse(nativeCalls[0].result.stdout), true);
    assert.equal(report.verification.build.ok, true);
    assert.equal(report.verification.check.ok, true);
    assert.equal(report.ok, false, 'offline audits cannot establish a clean dependency tree');
    for (const audit of [report.verification.runtimeAudit, report.verification.fullAudit]) {
      assert.notEqual(audit.ok, true);
      assert.equal(audit.counts, undefined, 'unrun audit must not fabricate zero vulnerabilities');
      assert.match(JSON.stringify(audit), /offline/i);
      assert.ok(audit.unrun || /unknown/i.test(audit.error ?? ''), 'audit must be explicitly unrun or unknown');
    }
  });
});
