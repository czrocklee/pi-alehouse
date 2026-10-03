import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import test from "node:test";
import { resolveGit, runtimeEnvironment } from "../../../bin/runtime-support.mjs";

const bash = ["/bin/bash", "/usr/bin/bash", "/run/current-system/sw/bin/bash"].find(existsSync);
assert(bash, "Bash fixture interpreter unavailable (PATH is not trusted)");

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "pi-trusted-git-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

test("optional trusted Git never searches project PATH or falls back from a broken override", t => {
  const root = fixture(t), bin = join(root, "bin"), marker = join(root, "path-git-ran"); mkdirSync(bin);
  const evil = join(bin, "git");
  writeFileSync(evil, `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(marker)}, 'bad');\nconsole.log('git version 2.55.0');\n`, { mode: 0o700 });
  const resolved = resolveGit({ PATH: bin });
  assert(resolved === undefined || (isAbsolute(resolved) && resolved !== evil));
  assert.equal(resolveGit({ PATH: bin, PI_HARNESS_GIT: "git" }), undefined);
  assert.equal(resolveGit({ PATH: bin, PI_HARNESS_GIT: join(root, "missing") }), undefined);
  assert(!existsSync(marker));
});

test("trusted Git override is canonical and version probing cannot inherit trace/config/execpath/loaders", t => {
  const root = fixture(t), executable = join(root, "trusted-git"), alias = join(root, "alias"), log = join(root, "probe.json"), marker = join(root, "trace-write");
  writeFileSync(executable, `#!${process.execPath}
const fs = require('node:fs');
fs.writeFileSync(${JSON.stringify(log)}, JSON.stringify({ args: process.argv.slice(2), path: process.env.PATH,
  names: Object.keys(process.env).filter(k => /^(GIT_|LD_|DYLD_|_RLD|LDR_|BASH_FUNC_)/i.test(k) || ['LIBPATH','SHLIB_PATH','GCONV_PATH','GLIBC_TUNABLES','NODE_OPTIONS','NODE_PATH'].includes(k)) }));
console.log('git version 2.55.0');
`, { mode: 0o700 });
  symlinkSync(executable, alias);
  const env = { PI_HARNESS_GIT: alias, PATH: root, GIT_TRACE: marker, GIT_TRACE2_EVENT: marker, GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "core.fsmonitor", GIT_CONFIG_VALUE_0: "evil", GIT_EXEC_PATH: root, GIT_DIR: root,
    LD_PRELOAD: join(root, "missing.so"), LD_LIBRARY_PATH: root, DYLD_INSERT_LIBRARIES: join(root, "missing.dylib"),
    LIBPATH: root, SHLIB_PATH: root, GCONV_PATH: root, GLIBC_TUNABLES: "bad", NODE_OPTIONS: "--require=not-a-module", NODE_PATH: root };
  assert.equal(resolveGit(env), realpathSync(executable));
  assert.deepEqual(JSON.parse(readFileSync(log, "utf8")), { args: ["--version"], path: "/dev/null",
    names: ["GIT_TRACE", "GIT_TRACE2", "GIT_TRACE2_EVENT", "GIT_TRACE2_PERF"] });
  assert(!existsSync(marker));
  writeFileSync(executable, `#!${process.execPath}\nconsole.log('not git');\n`, { mode: 0o700 });
  assert.equal(resolveGit({ PI_HARNESS_GIT: executable }), undefined);
});

test("trusted Git version shell wrappers do not execute BASH_ENV", t => {
  const root = fixture(t), marker = join(root, "bash-env-ran"), init = join(root, "bash-env"), git = join(root, "git");
  writeFileSync(init, `printf bad > ${JSON.stringify(marker)}\n`);
  writeFileSync(git, `#!${bash}\nprintf 'git version 2.55.0\\n'\n`, { mode: 0o700 });
  assert.equal(resolveGit({ PI_HARNESS_GIT: git, BASH_ENV: init, ENV: init }), realpathSync(git));
  assert(!existsSync(marker));
});

test("trusted version wrapper's bare helper cannot use exported Bash functions or cwd lookup", t => {
  const root = fixture(t), name = "harness_canary", git = join(root, "git");
  const functionMarker = join(root, "exported-function-ran"), helperMarker = join(root, "cwd-helper-ran");
  writeFileSync(join(root, name), `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(helperMarker)}, 'bad');\n`, { mode: 0o700 });
  writeFileSync(git, `#!${bash}\n${name} 2>/dev/null || :\nprintf 'git version 2.55.0\\n'\n`, { mode: 0o700 });
  const cwd = process.cwd();
  try {
    process.chdir(root);
    assert.equal(resolveGit({ PI_HARNESS_GIT: git, PATH: root,
      [`BASH_FUNC_${name}%%`]: `() { printf bad > ${JSON.stringify(functionMarker)}; }` }), realpathSync(git));
  } finally { process.chdir(cwd); }
  assert(!existsSync(functionMarker), "exported Bash function executed");
  assert(!existsSync(helperMarker), "empty/current-directory PATH executed a project helper");
});

test("launcher supplies optional PI_HARNESS_GIT and removes stale inherited selection when unavailable", () => {
  const paths = { runtime: "/package/runtime", permissionRoot: "/package/authority", policyRoot: "/package/policy",
    flock: "/trusted/flock", git: "/trusted/git", web: "/package/web", agentDir: "/agent" };
  assert.equal(runtimeEnvironment(paths, { PI_HARNESS_GIT: "/unverified/git" }).PI_HARNESS_GIT, paths.git);
  const { git: _git, ...withoutGit } = paths;
  assert.equal(runtimeEnvironment(withoutGit, { PI_HARNESS_GIT: "/unverified/git" }).PI_HARNESS_GIT, undefined);
});

test("Nix wrapper pins gitMinimal alongside flock; source declarations retain optional Git", () => {
  const nix = readFileSync(new URL("../../../nix/package.nix", import.meta.url), "utf8");
  assert.match(nix, /\n\s*gitMinimal,/);
  assert(nix.includes("--set PI_HARNESS_GIT ${gitMinimal}/bin/git"));
  const declaration = readFileSync(new URL("../../../bin/runtime-support.d.mts", import.meta.url), "utf8");
  assert.match(declaration, /resolveGit\(env\?: NodeJS\.ProcessEnv\): string \| undefined/);
  assert.match(declaration, /git\?: string;/);
});
