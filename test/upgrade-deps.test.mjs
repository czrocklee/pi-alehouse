import assert from "node:assert/strict";
import {
  lstatSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import test from "node:test";
import { parseArgs, runUpgrade } from "../scripts/upgrade-deps.mjs";

const json = (path) => JSON.parse(readFileSync(path, "utf8"));
const success = { status: 0, stdout: "", stderr: "" };
const offlineConfig = ["config", "get", "offline", "--json"];
const ciArgs = [
  "ci",
  "--include=dev",
  "--dry-run=false",
  "--package-lock-only=false",
  "--ignore-scripts",
  "--no-audit",
  "--no-fund",
];
const counts = (extra = {}) => ({
  info: 0,
  low: 0,
  moderate: 0,
  high: 0,
  critical: 0,
  total: 0,
  ...extra,
});
const auditReport = (vulnerabilities = {}, totals = counts()) => ({
  auditReportVersion: 2,
  vulnerabilities,
  metadata: { vulnerabilities: totals },
});
const options = (mode, packages = []) => ({ mode, packages });

function fixture(t, extra = {}) {
  const root = mkdtempSync(join(tmpdir(), "alehouse-upgrade-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const manifest = {
    name: "pi-alehouse",
    version: "1.0.0",
    private: true,
    description: "unrelated text stays unchanged",
    scripts: { postinstall: "must-not-run", build: "must-not-run", check: "must-not-run" },
    dependencies: { "direct-pkg": "1.0.0" },
    ...extra,
  };
  // Deliberately not npm's usual formatting, including the final blank line.
  const text = `${JSON.stringify(manifest, null, "\t")}\n\n`;
  writeFileSync(join(root, "package.json"), text);
  writeFileSync(
    join(root, "package-lock.json"),
    JSON.stringify(
      {
        name: manifest.name,
        version: manifest.version,
        lockfileVersion: 3,
        requires: true,
        packages: {
          ...Object.fromEntries(
            Object.entries(manifest.dependencies).map(([name, version]) => [
              `node_modules/${name}`,
              { version },
            ]),
          ),
          "": {
            name: manifest.name,
            version: manifest.version,
            dependencies: manifest.dependencies,
            ...(manifest.devDependencies ? { devDependencies: manifest.devDependencies } : {}),
          },
          "node_modules/direct-pkg": { version: "1.0.0", dependencies: { "leaf-pkg": "^1.0.0" } },
          "node_modules/leaf-pkg": { version: "1.1.0" },
        },
      },
      null,
      2,
    ),
  );
  writeFileSync(join(root, "config-canary.txt"), "offline-fixture-marker=true\n");
  writeFileSync(join(root, "unrelated.txt"), "keep me\n");
  mkdirSync(join(root, ".git"));
  mkdirSync(join(root, "node_modules"));
  writeFileSync(join(root, "node_modules", "sentinel"), "not installed\n");
  return root;
}

function snapshot(root) {
  const result = {};
  function visit(dir, prefix = "") {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const name = `${prefix}${entry.name}`;
      if (entry.isDirectory()) visit(join(dir, entry.name), `${name}/`);
      else result[name] = readFileSync(join(dir, entry.name), "utf8");
    }
  }
  visit(root);
  return result;
}

function npmStub(root, hook = () => undefined) {
  const calls = [];
  const runNpm = (args, context) => {
    calls.push({ args: [...args], cwd: context.cwd });
    const intercepted = hook(args, context);
    if (intercepted) return intercepted;
    if (args[0] === "view") {
      assert.deepEqual(args.slice(2), ["dist-tags.latest", "--json"]);
      return { ...success, stdout: '"2.0.0"' };
    }
    if (args[0] === "install" || args[0] === "update") {
      assert.notEqual(context.cwd, root, "lock-only work must be staged");
      assert.deepEqual(readdirSync(context.cwd).sort(), ["package-lock.json", "package.json"]);
      const manifest = json(join(context.cwd, "package.json"));
      const lock = json(join(context.cwd, "package-lock.json"));
      lock.packages[""].dependencies = manifest.dependencies;
      if (manifest.devDependencies) lock.packages[""].devDependencies = manifest.devDependencies;
      for (const [name, version] of Object.entries(manifest.dependencies))
        lock.packages[`node_modules/${name}`].version = version;
      if (args[0] === "install" && manifest.dependencies["direct-pkg"] === "2.0.0") {
        lock.packages["node_modules/direct-pkg"].dependencies["leaf-pkg"] = "^1.5.0";
        lock.packages["node_modules/leaf-pkg"].version = "1.9.0";
      }
      if (args[0] === "update") lock.packages["node_modules/leaf-pkg"].version = "1.9.0";
      writeFileSync(join(context.cwd, "package-lock.json"), JSON.stringify(lock, null, 2));
      return success;
    }
    assert.deepEqual(args, ciArgs);
    assert.equal(context.cwd, root);
    return success;
  };
  return { calls, runNpm };
}

function changeLock(root, change) {
  const path = join(root, "package-lock.json");
  const lock = json(path);
  change(lock);
  writeFileSync(path, JSON.stringify(lock));
}

function stagedChange(root, change) {
  const stub = npmStub(root);
  return {
    ...stub,
    runNpm(args, context) {
      const result = stub.runNpm(args, context);
      if (args[0] === "install") changeLock(context.cwd, change);
      return result;
    },
  };
}

function failingCleanup(t, prefix = "pi-alehouse-upgrade-") {
  const failed = [];
  t.after(() => {
    for (const path of failed) rmSync(path, { recursive: true, force: true });
  });
  return {
    failed,
    removeTree(path) {
      if (basename(path).startsWith(prefix)) {
        failed.push(path);
        throw new Error("fixture cleanup failed");
      }
      rmSync(path, { recursive: true, force: true });
    },
  };
}

function assertCleanupErrors(result, failed) {
  assert.ok(failed.length > 0, "cleanup seam must be exercised");
  assert.deepEqual(
    result.cleanupErrors,
    failed.map((path) => ({ path, error: "fixture cleanup failed" })),
  );
  assert.equal(new Set(failed).size, failed.length, "cleanup must not be retried");
}

function assertSafeCommands(calls) {
  for (const { args } of calls) {
    assert.equal(args.includes("--force"), false);
    if (args[0] === "ci")
      assert.ok(
        args.includes("--include=dev"),
        "source sync must explicitly include development dependencies",
      );
    assert.equal(
      args.some((arg) => /deploy|publish|prepack|init/.test(arg)),
      false,
    );
    if (["install", "update", "ci"].includes(args[0])) {
      for (const flag of ["--ignore-scripts", "--no-audit", "--no-fund", "--dry-run=false"])
        assert.ok(args.includes(flag));
      if (args[0] === "ci") assert.ok(args.includes("--package-lock-only=false"));
    }
  }
}

test("argument defaults, explicit modes, package selection and help", () => {
  assert.deepEqual(parseArgs([]), options("plan"));
  for (const mode of ["plan", "verify"]) assert.deepEqual(parseArgs([`--${mode}`]), options(mode));
  assert.deepEqual(
    parseArgs(["--apply", "--package", "direct-pkg", "--package", "@scope/pkg"]),
    options("apply", ["direct-pkg", "@scope/pkg"]),
  );
  assert.deepEqual(parseArgs(["--help"]), options("help"));
});

test("arguments reject ambiguous modes, duplicate packages, invalid names and unknown options", () => {
  for (const argv of [
    ["--apply"],
    ["--apply", "--plan"],
    ["--plan", "--plan"],
    ["--verify", "--package", "direct-pkg"],
    ["--package", "direct-pkg", "--package", "direct-pkg"],
    ["--package"],
    ["--force"],
    ["direct-pkg"],
    ["--package=direct-pkg"],
    ...["../evil", "name@2", "@scope", "", "--apply"].map((name) => ["--package", name]),
  ])
    assert.throws(() => parseArgs(argv), undefined, JSON.stringify(argv));
});

test("default plan queries direct latest without changing any source or installed files", (t) => {
  const root = fixture(t);
  const before = snapshot(root);
  const stub = npmStub(root);
  const report = runUpgrade(parseArgs([]), { root, runNpm: stub.runNpm });
  assert.equal(report.mode, "plan");
  assert.equal(report.ok, true);
  assert.deepEqual(
    stub.calls.map(({ args }) => args),
    [["view", "direct-pkg", "dist-tags.latest", "--json"]],
  );
  assert.deepEqual(snapshot(root), before);
  assert.equal(report.packages.find(({ name }) => name === "direct-pkg").latest, "2.0.0");
  assert.deepEqual(
    report.commands.map(({ args }) => args),
    stub.calls.map(({ args }) => args),
  );
});

test("apply preflight refuses empty, unknown, held packages and overrides before npm", (t) => {
  const held = [
    "@gotgenes/pi-permission-system",
    "@earendil-works/pi-ai",
    "@earendil-works/pi-coding-agent",
    "@earendil-works/pi-tui",
    "typebox",
    "tree-sitter-bash",
    "web-tree-sitter",
  ];
  for (const packages of [[], ["unknown-pkg"], ...held.map((name) => [name])]) {
    const root = fixture(t, {
      dependencies: {
        "direct-pkg": "1.0.0",
        ...Object.fromEntries(held.map((name) => [name, "1.0.0"])),
      },
    });
    const before = snapshot(root);
    let commands = 0;
    assert.throws(() =>
      runUpgrade(options("apply", packages), {
        root,
        runNpm: () => {
          commands++;
          return success;
        },
      }),
    );
    assert.equal(commands, 0);
    assert.deepEqual(snapshot(root), before);
  }
  const root = fixture(t, { overrides: { "leaf-pkg": "1.1.0" } });
  let commands = 0;
  assert.throws(() =>
    runUpgrade(options("apply", ["direct-pkg"]), {
      root,
      runNpm: () => {
        commands++;
        return success;
      },
    }),
  );
  assert.equal(commands, 0);
});

test("installed package without .git cannot apply", (t) => {
  const root = fixture(t);
  rmSync(join(root, ".git"), { recursive: true });
  const before = snapshot(root);
  const stub = npmStub(root);
  assert.throws(
    () => runUpgrade(options("apply", ["direct-pkg"]), { root, runNpm: stub.runNpm }),
    /source checkout/,
  );
  assert.equal(stub.calls.length, 0);
  assert.deepEqual(snapshot(root), before);
});

test("apply refuses project .npmrc before npm IO without copying or changing it", (t) => {
  const root = fixture(t);
  writeFileSync(join(root, ".npmrc"), "registry=https://registry.invalid/\n");
  const before = snapshot(root);
  const stub = npmStub(root);
  assert.throws(
    () => runUpgrade(options("apply", ["direct-pkg"]), { root, runNpm: stub.runNpm }),
    /\.npmrc/,
  );
  assert.equal(stub.calls.length, 0);
  assert.deepEqual(snapshot(root), before);
});

test("non-exact or prerelease registry latest is refused without source writes", (t) => {
  for (const latest of ["2.0.0-beta.1", "^2.0.0", "not-a-version"]) {
    const root = fixture(t);
    const before = snapshot(root);
    const calls = [];
    assert.throws(() =>
      runUpgrade(options("apply", ["direct-pkg"]), {
        root,
        runNpm: (args) => {
          calls.push(args);
          return { ...success, stdout: JSON.stringify(latest) };
        },
      }),
    );
    assert.deepEqual(
      calls.map((args) => args[0]),
      ["view"],
    );
    assert.deepEqual(snapshot(root), before);
  }
});

test("staged npm failure never publishes either source file or runs ci", (t) => {
  const root = fixture(t);
  const before = snapshot(root);
  const stub = npmStub(root, (args) =>
    args[0] === "install" ? { status: 1, stdout: "", stderr: "fixture failure" } : undefined,
  );
  assert.throws(() => runUpgrade(options("apply", ["direct-pkg"]), { root, runNpm: stub.runNpm }));
  assert.deepEqual(snapshot(root), before);
  assert.equal(
    stub.calls.some(({ args }) => args[0] === "ci"),
    false,
  );
});

test("apply pins direct latest, preserves manifest formatting and reports constrained transitives honestly", (t) => {
  const root = fixture(t);
  const before = snapshot(root);
  const stub = npmStub(root);
  const report = runUpgrade(options("apply", ["direct-pkg", "leaf-pkg"]), {
    root,
    runNpm: stub.runNpm,
  });
  assert.equal(report.ok, true);
  assert.equal(report.applied, true);
  assert.equal(
    readFileSync(join(root, "package.json"), "utf8"),
    before["package.json"].replace('"direct-pkg": "1.0.0"', '"direct-pkg": "2.0.0"'),
  );
  for (const path of ["config-canary.txt", "unrelated.txt", "node_modules/sentinel"])
    assert.equal(snapshot(root)[path], before[path]);
  const leaf = report.packages.find(({ name }) => name === "leaf-pkg");
  assert.equal(leaf.latest, "2.0.0");
  assert.deepEqual(leaf.resolved, ["1.9.0"]);
  assert.equal(leaf.matchesLatest, false);
  assert.deepEqual(
    leaf.ranges,
    ["^1.5.0"],
    "report incoming constraints from the resolved parent, not the old lock",
  );
  assert.deepEqual(
    stub.calls.filter(({ args }) => args[0] !== "view").map(({ args }) => args),
    [
      [
        "install",
        "--package-lock-only",
        "--dry-run=false",
        "--ignore-scripts",
        "--no-audit",
        "--no-fund",
      ],
      [
        "update",
        "--package-lock-only",
        "--dry-run=false",
        "--ignore-scripts",
        "--no-audit",
        "--no-fund",
        "--",
        "leaf-pkg",
      ],
      ciArgs,
    ],
  );
  assertSafeCommands(stub.calls);
});

test("transitive-only apply updates the lock without rewriting the manifest", (t) => {
  const root = fixture(t);
  const manifest = readFileSync(join(root, "package.json"), "utf8");
  const stub = npmStub(root);
  const report = runUpgrade(options("apply", ["leaf-pkg"]), { root, runNpm: stub.runNpm });
  assert.equal(report.ok, true);
  assert.equal(readFileSync(join(root, "package.json"), "utf8"), manifest);
  assert.equal(
    stub.calls.some(({ args }) => args[0] === "install"),
    false,
  );
  assert.equal(
    json(join(root, "package-lock.json")).packages["node_modules/leaf-pkg"].version,
    "1.9.0",
  );
});

test("unexpected staged manifest changes never publish", (t) => {
  const root = fixture(t);
  const before = snapshot(root);
  const stub = npmStub(root, (args, { cwd }) => {
    if (args[0] === "install") {
      const manifest = json(join(cwd, "package.json"));
      manifest.unrequested = "npm changed this";
      writeFileSync(join(cwd, "package.json"), JSON.stringify(manifest));
    }
  });
  assert.throws(() => runUpgrade(options("apply", ["direct-pkg"]), { root, runNpm: stub.runNpm }));
  assert.deepEqual(snapshot(root), before);
});

test("web upgrade refuses missing guarded source references without publishing", (t) => {
  const root = fixture(t, { dependencies: { "direct-pkg": "1.0.0", "pi-web-access": "1.0.0" } });
  const lock = json(join(root, "package-lock.json"));
  lock.packages["node_modules/pi-web-access"] = { version: "1.0.0" };
  writeFileSync(join(root, "package-lock.json"), JSON.stringify(lock));
  const before = snapshot(root);
  const stub = npmStub(root);
  assert.throws(() =>
    runUpgrade(options("apply", ["pi-web-access"]), { root, runNpm: stub.runNpm }),
  );
  assert.deepEqual(snapshot(root), before);
  assert.equal(
    stub.calls.some(({ args }) => args[0] === "ci"),
    false,
  );
});

test("web apply updates all guarded references but preserves the historical rejected pin", (t) => {
  const current = json(new URL("../package.json", import.meta.url)).dependencies["pi-web-access"];
  assert.match(current, /^\d+\.\d+\.\d+$/);
  const latest = current.replace(/\d+$/, (patch) => String(Number(patch) + 1));
  const root = fixture(t, { dependencies: { "direct-pkg": "1.0.0", "pi-web-access": current } });
  const paths = [
    "bin/runtime-support.mjs",
    "scripts/build.mjs",
    "harness/README.md",
    "harness/docs/development.md",
    "harness/docs/security.md",
    "THIRD_PARTY_NOTICES.md",
    "test/runtime/runtime.test.mjs",
  ];
  const refs = Object.fromEntries(
    paths.map((path) => [path, readFileSync(new URL(`../${path}`, import.meta.url), "utf8")]),
  );
  for (const [path, text] of Object.entries(refs)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  const stub = npmStub(root, (args) =>
    args[0] === "view" ? { ...success, stdout: JSON.stringify(latest) } : undefined,
  );
  const report = runUpgrade(options("apply", ["pi-web-access"]), { root, runNpm: stub.runNpm });
  assert.equal(report.ok, true);
  for (const [path, text] of Object.entries(refs)) {
    assert.equal(
      readFileSync(join(root, path), "utf8"),
      text
        .replaceAll(current, latest)
        .replaceAll(current.replaceAll(".", "\\."), latest.replaceAll(".", "\\.")),
    );
  }
  assert.ok(
    readFileSync(join(root, "test/runtime/runtime.test.mjs"), "utf8").includes(
      '"version":"0.35.0"',
    ),
  );
  assertSafeCommands(stub.calls);
});

test("concurrent original edits abort publication without overwriting the edit", (t) => {
  const root = fixture(t);
  const lock = readFileSync(join(root, "package-lock.json"), "utf8");
  const manifest = readFileSync(join(root, "package.json"), "utf8");
  const changed = manifest.replace("unrelated text stays unchanged", "external edit");
  const stub = npmStub(root, (args) => {
    if (args[0] === "install") writeFileSync(join(root, "package.json"), changed);
  });
  assert.throws(() => runUpgrade(options("apply", ["direct-pkg"]), { root, runNpm: stub.runNpm }));
  assert.equal(readFileSync(join(root, "package.json"), "utf8"), changed);
  assert.equal(readFileSync(join(root, "package-lock.json"), "utf8"), lock);
  assert.equal(
    stub.calls.some(({ args }) => args[0] === "ci"),
    false,
  );
});

test("ci failure is partial after publication, with no rollback, retry or automatic verification", (t) => {
  const root = fixture(t);
  const stub = npmStub(root, (args) =>
    args[0] === "ci" ? { status: 1, stdout: "", stderr: "ci failed" } : undefined,
  );
  const report = runUpgrade(options("apply", ["direct-pkg"]), { root, runNpm: stub.runNpm });
  assert.equal(report.ok, false);
  assert.equal(report.applied, true);
  assert.equal(report.partial, true);
  assert.ok(report.error);
  assert.equal(json(join(root, "package.json")).dependencies["direct-pkg"], "2.0.0");
  assert.deepEqual(
    stub.calls.map(({ args }) => args[0]),
    ["view", "install", "ci"],
  );
  assertSafeCommands(stub.calls);
});

test("inconsistent clean audit counts remain unknown, not a successful zero", (t) => {
  const root = fixture(t);
  let audits = 0;
  const report = runUpgrade(options("verify"), {
    root,
    runNpm: (args) => {
      if (args[0] === "config") return { ...success, stdout: "false" };
      if (args[0] !== "audit") return success;
      audits++;
      return {
        ...success,
        stdout: JSON.stringify(auditReport({ "leaf-pkg": { severity: "high" } })),
      };
    },
  });
  assert.equal(audits, 2);
  assert.equal(report.ok, false);
  for (const audit of [report.verification.runtimeAudit, report.verification.fullAudit]) {
    assert.equal(audit.ok, false);
    assert.equal(audit.counts, undefined);
    assert.match(audit.error, /unknown/);
  }
});

test("verify runs ordered gates and explicit audit scopes even under NODE_ENV=production", (t) => {
  const previousNodeEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = "production";
  t.after(() => {
    if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousNodeEnv;
  });
  for (const failedGate of ["build", "check", undefined]) {
    const root = fixture(t);
    const before = snapshot(root);
    const calls = [];
    const report = runUpgrade(options("verify"), {
      root,
      runNpm: (args, { cwd }) => {
        assert.equal(cwd, root);
        calls.push(args);
        if (args[0] === "run") return { ...success, status: args[1] === failedGate ? 1 : 0 };
        if (args[0] === "config") return { ...success, stdout: "false" };
        return {
          status: 1,
          stderr: "",
          stdout: JSON.stringify(
            auditReport(
              { "direct-pkg": { severity: "high" }, "leaf-pkg": { severity: "high" } },
              counts({ high: 2, total: 2 }),
            ),
          ),
        };
      },
    });
    assert.equal(report.ok, false);
    assert.deepEqual(calls, [
      ["run", "build"],
      ...(failedGate === "build" ? [] : [["run", "check"]]),
      offlineConfig,
      ["audit", "--omit=dev", "--omit=peer", "--include=optional", "--json", "--offline=false"],
      [
        "audit",
        "--include=dev",
        "--include=optional",
        "--include=peer",
        "--json",
        "--offline=false",
      ],
    ]);
    if (failedGate === "build") assert.ok(report.verification.check.unrun);
    for (const audit of [report.verification.runtimeAudit, report.verification.fullAudit]) {
      assert.equal(audit.ok, false);
      assert.equal(audit.counts.high, 2);
      assert.equal(audit.counts.total, 2);
    }
    assert.deepEqual(
      report.commands.map(({ args }) => args),
      calls,
    );
    assert.deepEqual(snapshot(root), before);
  }
});

const malformedLocks = [
  ...[undefined, null, "2", "3", 1, 2.5, 4, 99].map((version) => [
    `version ${version}`,
    (lock) => {
      lock.lockfileVersion = version;
    },
  ]),
  [
    "missing packages",
    (lock) => {
      delete lock.packages;
    },
  ],
  [
    "null packages",
    (lock) => {
      lock.packages = null;
    },
  ],
  [
    "array packages",
    (lock) => {
      lock.packages = [];
    },
  ],
  [
    "missing root",
    (lock) => {
      delete lock.packages[""];
    },
  ],
  ...[null, [], "invalid"].flatMap((value) => [
    [
      `root ${JSON.stringify(value)}`,
      (lock) => {
        lock.packages[""] = value;
      },
    ],
    [
      `entry ${JSON.stringify(value)}`,
      (lock) => {
        lock.packages["node_modules/leaf-pkg"] = value;
      },
    ],
  ]),
];

test("only exact numeric npm lock versions 2 and 3 with record packages are accepted", (t) => {
  for (const version of [2, 3]) {
    const root = fixture(t);
    changeLock(root, (lock) => {
      lock.lockfileVersion = version;
    });
    const stub = npmStub(root);
    assert.equal(runUpgrade(options("plan"), { root, runNpm: stub.runNpm }).ok, true);
  }
  for (const [label, change] of malformedLocks) {
    for (const mode of ["plan", "apply", "verify"]) {
      const root = fixture(t);
      changeLock(root, change);
      const before = snapshot(root);
      const stub = npmStub(root);
      assert.throws(
        () =>
          runUpgrade(options(mode, mode === "verify" ? [] : ["direct-pkg"]), {
            root,
            runNpm: stub.runNpm,
          }),
        undefined,
        label,
      );
      assert.equal(stub.calls.length, 0, label);
      assert.deepEqual(snapshot(root), before, label);
    }
  }
});

test("default plan rejects malformed manifest package keys before npm option parsing", (t) => {
  for (const name of ["--registry=fixture", "name@2", "../package", "@scope", ""]) {
    const root = fixture(t, { dependencies: { [name]: "1.0.0" } });
    const before = snapshot(root);
    const stub = npmStub(root);
    assert.throws(() => runUpgrade(options("plan"), { root, runNpm: stub.runNpm }), /package name/);
    assert.equal(stub.calls.length, 0);
    assert.deepEqual(snapshot(root), before);
  }
});

test("malformed staged locks cannot be published or installed", (t) => {
  for (const [label, change] of malformedLocks) {
    const root = fixture(t);
    const before = snapshot(root);
    const stub = stagedChange(root, change);
    assert.throws(
      () => runUpgrade(options("apply", ["direct-pkg"]), { root, runNpm: stub.runNpm }),
      undefined,
      label,
    );
    assert.equal(
      stub.calls.some(({ args }) => args[0] === "ci"),
      false,
      label,
    );
    assert.deepEqual(snapshot(root), before, label);
  }
});

test("constructor package ranges contain only own dependency-map values", (t) => {
  const root = fixture(t);
  changeLock(root, (lock) => {
    lock.packages["node_modules/constructor"] = { version: "1.0.0", dependencies: {} };
    lock.packages["node_modules/direct-pkg"].dependencies.constructor = "^1.0.0";
    lock.packages["node_modules/leaf-pkg"].optionalDependencies = {};
    lock.packages["node_modules/leaf-pkg"].peerDependencies = {};
  });
  const stub = npmStub(root);
  const report = runUpgrade(options("plan", ["constructor"]), { root, runNpm: stub.runNpm });
  assert.deepEqual(report.packages[0].ranges, ["^1.0.0"]);
  assert.deepEqual(JSON.parse(JSON.stringify(report)).packages[0].ranges, ["^1.0.0"]);
});

test("apply uses real lock/install CLI controls without globally refusing inherited offline config", (t) => {
  const keys = ["npm_config_dry_run", "npm_config_package_lock_only", "npm_config_offline"];
  const previous = keys.map((key) => process.env[key]);
  t.after(() =>
    keys.forEach((key, index) => {
      if (previous[index] === undefined) delete process.env[key];
      else process.env[key] = previous[index];
    }),
  );
  for (const key of keys) process.env[key] = "true";
  const root = fixture(t);
  const stub = npmStub(root);
  const report = runUpgrade(options("apply", ["direct-pkg", "leaf-pkg"]), {
    root,
    runNpm: stub.runNpm,
  });
  assert.equal(report.ok, true);
  assertSafeCommands(stub.calls);
  assert.equal(
    stub.calls.some(({ args }) => args[0] === "config"),
    false,
  );
  assert.equal(json(join(root, "package.json")).dependencies["direct-pkg"], "2.0.0");
});

test("protected graph additions, removals and whole-entry changes through an allowed parent require review", (t) => {
  const held = [
    "@gotgenes/pi-permission-system",
    "@earendil-works/pi-ai",
    "@earendil-works/pi-coding-agent",
    "@earendil-works/pi-tui",
    "@earendil-works/pi-future-sdk",
    "typebox",
    "tree-sitter-bash",
    "web-tree-sitter",
  ];
  const identities = [
    ...held.map((name) => [`node_modules/${name}`, {}]),
    ["node_modules/alias-pkg", { name: "typebox" }],
    ["node_modules/direct-pkg/node_modules/alias-pkg", { name: "@gotgenes/pi-permission-system" }],
    ["node_modules/direct-pkg/node_modules/tree-sitter-bash", { name: "innocent-alias" }],
  ];
  for (const [path, alias] of identities) {
    for (const mutation of ["addition", "removal", "version", "integrity", "metadata"]) {
      const root = fixture(t);
      const entry = { version: "1.0.0", integrity: "sha512-original", ...alias };
      const dependency = path.split("node_modules/").at(-1);
      changeLock(root, (lock) => {
        if (mutation !== "addition") {
          lock.packages[path] = entry;
          lock.packages["node_modules/direct-pkg"].dependencies[dependency] = "^1.0.0";
        }
      });
      const before = snapshot(root);
      const stub = stagedChange(root, (lock) => {
        if (mutation === "addition") {
          lock.packages[path] = entry;
          lock.packages["node_modules/direct-pkg"].dependencies[dependency] = "^1.0.0";
        } else if (mutation === "removal") {
          delete lock.packages[path];
          delete lock.packages["node_modules/direct-pkg"].dependencies[dependency];
        } else if (mutation === "version") lock.packages[path].version = "1.0.1";
        else if (mutation === "integrity") lock.packages[path].integrity = "sha512-changed";
        else lock.packages[path].license = "changed-metadata";
      });
      const label = `${path} ${mutation}`;
      assert.throws(
        () => runUpgrade(options("apply", ["direct-pkg"]), { root, runNpm: stub.runNpm }),
        /manual|protected|contract/i,
        label,
      );
      assert.equal(
        stub.calls.some(({ args }) => args[0] === "ci"),
        false,
        label,
      );
      assert.deepEqual(snapshot(root), before, label);
    }
  }
});

test("unchanged protected graph does not forbid an unrelated selected upgrade", (t) => {
  const root = fixture(t);
  changeLock(root, (lock) => {
    lock.packages["node_modules/typebox"] = { version: "1.0.0", integrity: "sha512-original" };
  });
  const stub = npmStub(root);
  const report = runUpgrade(options("apply", ["direct-pkg"]), { root, runNpm: stub.runNpm });
  assert.equal(report.ok, true);
  assert.deepEqual(json(join(root, "package-lock.json")).packages["node_modules/typebox"], {
    version: "1.0.0",
    integrity: "sha512-original",
  });
});

test("shrinkwrap files and broken symlinks are refused in every mode before npm", (t) => {
  for (const mode of ["plan", "apply", "verify"]) {
    for (const brokenSymlink of [false, true]) {
      const root = fixture(t);
      const before = snapshot(root);
      const path = join(root, "npm-shrinkwrap.json");
      if (brokenSymlink) symlinkSync("absent-shrinkwrap-target", path);
      else writeFileSync(path, "manual shrinkwrap\n");
      const stub = npmStub(root);
      assert.throws(
        () =>
          runUpgrade(options(mode, mode === "apply" ? ["direct-pkg"] : []), {
            root,
            runNpm: stub.runNpm,
          }),
        /shrinkwrap/i,
      );
      assert.equal(stub.calls.length, 0);
      for (const [file, text] of Object.entries(before))
        assert.equal(readFileSync(join(root, file), "utf8"), text);
      if (brokenSymlink) {
        assert.equal(lstatSync(path).isSymbolicLink(), true);
        assert.equal(readlinkSync(path), "absent-shrinkwrap-target");
      } else assert.equal(readFileSync(path, "utf8"), "manual shrinkwrap\n");
    }
  }
});

test("apply rechecks project config and shrinkwrap before publication and before ci", (t) => {
  for (const filename of [".npmrc", "npm-shrinkwrap.json"]) {
    for (const phase of ["staging", "published"]) {
      const root = fixture(t);
      const before = snapshot(root);
      const marker = "concurrent manual config\n";
      const stub = npmStub(root, (args) => {
        if (phase === "staging" && args[0] === "install")
          writeFileSync(join(root, filename), marker);
      });
      const removeTree = (path) => {
        rmSync(path, { recursive: true, force: true });
        if (phase === "published" && basename(path).startsWith(".upgrade-deps-"))
          writeFileSync(join(root, filename), marker);
      };
      const run = () =>
        runUpgrade(options("apply", ["direct-pkg"]), { root, runNpm: stub.runNpm, removeTree });
      if (phase === "staging") {
        assert.throws(run, /npmrc|shrinkwrap/i);
        assert.equal(readFileSync(join(root, "package.json"), "utf8"), before["package.json"]);
        assert.equal(
          readFileSync(join(root, "package-lock.json"), "utf8"),
          before["package-lock.json"],
        );
      } else {
        const report = run();
        assert.equal(report.ok, false);
        assert.equal(report.partial, true);
        assert.match(report.error, /npmrc|shrinkwrap/i);
      }
      assert.equal(
        stub.calls.some(({ args }) => args[0] === "ci"),
        false,
      );
      assert.equal(readFileSync(join(root, filename), "utf8"), marker);
      assert.equal(
        readFileSync(join(root, "node_modules/sentinel"), "utf8"),
        before["node_modules/sentinel"],
      );
    }
  }
});

test("cleanup failure cannot replace a published ci failure or turn successful publication into success", (t) => {
  for (const ciFailed of [false, true]) {
    const root = fixture(t);
    const stub = npmStub(root, (args) =>
      args[0] === "ci" && ciFailed
        ? { ...success, status: 1, stderr: "fixture ci failed" }
        : undefined,
    );
    const cleanup = failingCleanup(t);
    const report = runUpgrade(options("apply", ["direct-pkg"]), {
      root,
      runNpm: stub.runNpm,
      removeTree: cleanup.removeTree,
    });
    assert.equal(report.ok, false);
    assert.equal(report.partial, true);
    assert.equal(report.applied, true);
    assert.ok(report.changedFiles.includes("package.json"));
    if (ciFailed) assert.match(report.error, /ci failed/);
    assertCleanupErrors(report, cleanup.failed);
    assert.equal(json(join(root, "package.json")).dependencies["direct-pkg"], "2.0.0");
    assert.equal(
      json(join(root, "package-lock.json")).packages["node_modules/direct-pkg"].version,
      "2.0.0",
    );
    assert.deepEqual(
      stub.calls.map(({ args }) => args[0]),
      ["view", "install", "ci"],
    );
  }
});

test("before-publication npm failure still throws its primary error with attached cleanup errors", (t) => {
  const root = fixture(t);
  const before = snapshot(root);
  const stub = npmStub(root, (args) =>
    args[0] === "install"
      ? { ...success, status: 1, stderr: "fixture primary staging failure" }
      : undefined,
  );
  const cleanup = failingCleanup(t);
  assert.throws(
    () =>
      runUpgrade(options("apply", ["direct-pkg"]), {
        root,
        runNpm: stub.runNpm,
        removeTree: cleanup.removeTree,
      }),
    (error) => {
      assert.match(error.message, /fixture primary staging failure/);
      assertCleanupErrors(error, cleanup.failed);
      return true;
    },
  );
  assert.deepEqual(snapshot(root), before);
  assert.deepEqual(
    stub.calls.map(({ args }) => args[0]),
    ["view", "install"],
  );
});

test("publish-temp cleanup errors are retained after source publication starts", (t) => {
  const root = fixture(t);
  const stub = npmStub(root);
  const cleanup = failingCleanup(t, ".upgrade-deps-");
  const report = runUpgrade(options("apply", ["direct-pkg"]), {
    root,
    runNpm: stub.runNpm,
    removeTree: cleanup.removeTree,
  });
  assert.equal(report.ok, false);
  assert.equal(report.partial, true);
  assertCleanupErrors(report, cleanup.failed);
  assert.equal(json(join(root, "package.json")).dependencies["direct-pkg"], "2.0.0");
});

test("verify refuses offline or unknown effective npm config without either audit", (t) => {
  for (const [config, unrun] of [
    [{ ...success, stdout: "true" }, "offline_config"],
    ...["", "null", '"false"', "{}", "[]", "not json"].map((stdout) => [
      { ...success, stdout },
      "audit_config_unavailable",
    ]),
    [{ status: 1, stdout: "false", stderr: "config failed" }, "audit_config_unavailable"],
    [
      { ...success, stdout: "false", error: new Error("config unavailable") },
      "audit_config_unavailable",
    ],
    [{ ...success, stdout: "false", signal: "SIGTERM" }, "audit_config_unavailable"],
    [
      () => {
        throw new Error("config query threw");
      },
      "audit_config_unavailable",
    ],
  ]) {
    const root = fixture(t);
    const before = snapshot(root);
    const calls = [];
    const report = runUpgrade(options("verify"), {
      root,
      runNpm: (args) => {
        calls.push(args);
        if (args[0] === "config") return typeof config === "function" ? config() : config;
        assert.equal(args[0], "run", "unknown/offline config must not contact audit");
        return success;
      },
    });
    assert.equal(report.ok, false);
    assert.deepEqual(calls, [["run", "build"], ["run", "check"], offlineConfig]);
    assert.deepEqual(
      report.commands.map(({ args }) => args),
      calls,
    );
    for (const audit of [report.verification.runtimeAudit, report.verification.fullAudit]) {
      assert.equal(audit.ok, false);
      assert.equal(audit.status, null);
      assert.equal(audit.unrun, unrun);
      assert.equal(audit.counts, undefined);
      assert.match(audit.error, /unknown/);
    }
    assert.deepEqual(snapshot(root), before);
  }
});

test("valid audit v2 zero and nonzero reports retain complete independent counts", (t) => {
  const root = fixture(t);
  let audits = 0;
  const totals = counts({ low: 1, high: 1, total: 2 });
  const report = runUpgrade(options("verify"), {
    root,
    runNpm: (args) => {
      if (args[0] === "config") return { ...success, stdout: "false" };
      if (args[0] !== "audit") return success;
      return audits++ === 0
        ? { ...success, stdout: JSON.stringify(auditReport()) }
        : {
            ...success,
            status: 1,
            stdout: JSON.stringify(
              auditReport({ first: { severity: "low" }, second: { severity: "high" } }, totals),
            ),
          };
    },
  });
  assert.equal(audits, 2);
  assert.equal(report.ok, false);
  assert.equal(report.verification.runtimeAudit.ok, true);
  assert.deepEqual(report.verification.runtimeAudit.counts, counts());
  assert.equal(report.verification.fullAudit.ok, false);
  assert.deepEqual(report.verification.fullAudit.counts, totals);
  assert.deepEqual(report.verification.fullAudit.packages, ["first", "second"]);
});

test("malformed audit v2 reports and invalid exit statuses never invent vulnerability counts", (t) => {
  const oneHigh = () => auditReport({ leaf: { severity: "high" } }, counts({ high: 1, total: 1 }));
  const cases = [
    ["severity sum", auditReport({}, counts({ high: 1 })), 0],
    ["map count", auditReport({}, counts({ high: 1, total: 1 })), 1],
    [
      "severity tally",
      auditReport({ leaf: { severity: "low" } }, counts({ high: 1, total: 1 })),
      1,
    ],
    ["array map", auditReport([], counts()), 0],
    ["array record", auditReport({ leaf: [] }, counts({ high: 1, total: 1 })), 1],
    ["null record", auditReport({ leaf: null }, counts({ high: 1, total: 1 })), 1],
    [
      "unknown severity",
      auditReport({ leaf: { severity: "urgent" } }, counts({ high: 1, total: 1 })),
      1,
    ],
    ["missing severity", auditReport({ leaf: {} }, counts({ high: 1, total: 1 })), 1],
    ["missing version", { vulnerabilities: {}, metadata: { vulnerabilities: counts() } }, 0],
    ["wrong version", { ...auditReport(), auditReportVersion: 1 }, 0],
    ["string version", { ...auditReport(), auditReportVersion: "2" }, 0],
    ["status 1 zero", auditReport(), 1],
    ["status 2", oneHigh(), 2],
    ["status null", oneHigh(), null],
    ["npm error", { ...auditReport(), error: { code: "fixture" } }, 0],
  ];
  for (const field of ["info", "low", "moderate", "high", "critical", "total"]) {
    for (const value of [-1, "0", 0.5, Number.MAX_SAFE_INTEGER + 1, undefined]) {
      cases.push([`${field}=${value}`, auditReport({}, counts({ [field]: value })), 0]);
    }
  }
  for (const [label, data, status] of cases) {
    const root = fixture(t);
    let audits = 0;
    const report = runUpgrade(options("verify"), {
      root,
      runNpm: (args) => {
        if (args[0] === "config") return { ...success, stdout: "false" };
        if (args[0] !== "audit") return success;
        audits++;
        return { ...success, status, stdout: JSON.stringify(data) };
      },
    });
    assert.equal(audits, 2, label);
    assert.equal(report.ok, false, label);
    for (const audit of [report.verification.runtimeAudit, report.verification.fullAudit]) {
      assert.equal(audit.ok, false, label);
      assert.equal(audit.counts, undefined, label);
      assert.match(audit.error, /unknown/, label);
    }
  }
});
