#!/usr/bin/env node
// Source maintenance only. npm IO is explicit; no lifecycle scripts, force,
// overrides, deployment, user-resource reconciliation or live-provider checks.
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";

const sourceRoot = resolve(import.meta.dirname, "..");
const packageName = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;
const stableVersion = /^\d+\.\d+\.\d+$/;
const manualOnly = (name) =>
  name === "@gotgenes/pi-permission-system" ||
  name.startsWith("@earendil-works/pi-") ||
  ["typebox", "tree-sitter-bash", "web-tree-sitter"].includes(name);
const flags = ["--ignore-scripts", "--no-audit", "--no-fund"];
const mutationFlags = ["--dry-run=false", ...flags];
const severities = ["info", "low", "moderate", "high", "critical"];
const record = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const message = (error) => (error instanceof Error ? error.message : String(error));
const defaultRemoveTree = (path) => rmSync(path, { recursive: true, force: true });
const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export const usage = `Usage: node scripts/upgrade-deps.mjs [--plan | --apply | --verify] [--package NAME ...]

  --plan     Default: query latest stable versions; do not edit source or install.
             Without --package, inspect direct runtime and development dependencies.
  --apply    Require explicit --package selections. Pin direct deps to latest;
             refresh transitive deps within upstream ranges, never force an override.
             Sync known pi-web-access version references, then npm ci --include=dev --ignore-scripts.
  --verify   Build, portable check, runtime audit and full audit. No upgrade queries.
  --help     Show this help without npm IO.

Examples:
  node scripts/upgrade-deps.mjs --package pi-web-access
  node scripts/upgrade-deps.mjs --apply --package pi-web-access --package zod
  node scripts/upgrade-deps.mjs --apply --package hono --package fast-uri
  node scripts/upgrade-deps.mjs --verify

Permission authority, Pi SDK, TypeBox and parser runtimes require manual migration;
any protected graph change (including indirect additions/removals) stops apply.
Only numeric lockfile versions 2/3 are supported; npm-shrinkwrap.json is refused.
Apply requires a source checkout (.git) and stages only package manifests/lockfiles,
never credentials or npm configs.
Apply refuses a project .npmrc rather than ignoring its registry/auth choices.
Use consistent standard npm environment/user config; configs are never copied.
Apply explicitly disables npm dry-run and lock-only modes for the final install.
Verification respects offline configuration: audits are unknown/unrun, not clean.
Run one upgrader at a time with no concurrent edits.
Publication is NOT a multi-file transaction; inspect a partial failure, do not
blindly retry or reset existing work. Verification is separate and may use npm's
network for audit, but never runs the gated host/model/publication lanes.
An upgrade is NOT an upstream API/security review or an installed-runtime swap.`;

export function parseArgs(argv) {
  let mode = "plan",
    selectedMode;
  const packages = [];
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (["--plan", "--apply", "--verify", "--help"].includes(arg)) {
      if (selectedMode) throw new Error("Choose exactly one mode (no duplicate flags)");
      selectedMode = arg;
      mode = arg.slice(2);
    } else if (arg === "--package") {
      const name = argv[++index];
      if (!name || name.length > 214 || !packageName.test(name))
        throw new Error("--package requires an npm package name, not a version, URL or option");
      if (packages.includes(name)) throw new Error(`Duplicate package: ${name}`);
      packages.push(name);
    } else throw new Error(`Unknown option: ${arg}`);
  }
  if (["verify", "help"].includes(mode) && packages.length)
    throw new Error(`--${mode} does not accept --package`);
  if (mode === "apply" && !packages.length)
    throw new Error("--apply requires explicit --package selections");
  return { mode, packages };
}

function defaultNpm(args, { cwd, capture = true }) {
  return spawnSync("npm", args, {
    cwd,
    encoding: "utf8",
    shell: false,
    maxBuffer: 64 * 1024 * 1024,
    stdio: capture ? ["ignore", "pipe", "pipe"] : ["ignore", "inherit", "inherit"],
  });
}
function snapshot(root, path) {
  const file = join(root, path),
    info = lstatSync(file);
  if (!info.isFile() || info.nlink !== 1)
    throw new Error(`Expected a single-link regular source file: ${path}`);
  return { path, text: readFileSync(file, "utf8"), mode: info.mode & 0o777 };
}
function versions(lock, name) {
  return [
    ...new Set(
      Object.entries(lock.packages)
        .filter(
          ([path]) =>
            path.endsWith(`node_modules/${name}`) && path.split("node_modules/").at(-1) === name,
        )
        .map(([, entry]) => entry.version)
        .filter(Boolean),
    ),
  ].sort();
}
function ranges(lock, name) {
  return [
    ...new Set(
      Object.values(lock.packages).flatMap((entry) =>
        [entry.dependencies, entry.optionalDependencies, entry.peerDependencies].flatMap(
          (dependencies) =>
            dependencies && Object.hasOwn(dependencies, name) ? [dependencies[name]] : [],
        ),
      ),
    ),
  ];
}
function validateLock(lock) {
  if (
    !record(lock) ||
    ![2, 3].includes(lock.lockfileVersion) ||
    !record(lock.packages) ||
    !Object.hasOwn(lock.packages, "") ||
    !record(lock.packages[""])
  ) {
    throw new Error("Expected an npm lockfile with numeric version 2/3 and package records");
  }
  for (const [path, entry] of Object.entries(lock.packages)) {
    if (!record(entry)) throw new Error(`Invalid lockfile package record: ${path}`);
    for (const field of [
      "dependencies",
      "optionalDependencies",
      "devDependencies",
      "peerDependencies",
    ]) {
      if (
        entry[field] !== undefined &&
        (!record(entry[field]) ||
          Object.values(entry[field]).some((value) => typeof value !== "string"))
      ) {
        throw new Error(`Invalid lockfile ${field}: ${path}`);
      }
    }
  }
  return lock;
}
function requireAbsent(root, path, reason) {
  try {
    lstatSync(join(root, path));
  } catch (error) {
    if (error.code === "ENOENT") return;
    throw error;
  }
  throw new Error(`${path}: ${reason}`);
}
function applyConfig(root) {
  requireAbsent(
    root,
    ".npmrc",
    "Project .npmrc requires manual configuration review; use consistent npm environment/user config, never copy credentials into staging",
  );
  requireAbsent(
    root,
    "npm-shrinkwrap.json",
    "authoritative shrinkwrap requires manual migration; package-lock.json must be the only lockfile",
  );
}
function protectedGraph(lock) {
  return new Map(
    Object.entries(lock.packages).filter(
      ([path, entry]) =>
        path &&
        (manualOnly(path.split("node_modules/").at(-1)) ||
          (typeof entry.name === "string" && manualOnly(entry.name))),
    ),
  );
}
function checkProtectedGraph(before, after) {
  const original = protectedGraph(before),
    resolved = protectedGraph(after);
  for (const path of new Set([...original.keys(), ...resolved.keys()])) {
    if (!isDeepStrictEqual(original.get(path), resolved.get(path))) {
      throw new Error(
        `Protected dependency graph changed: ${path}; manual contract migration required`,
      );
    }
  }
}
function cleanup(path, removeTree, errors) {
  try {
    removeTree(path);
  } catch (error) {
    errors.push({ path, error: message(error) });
  }
}
function replaceOnce(text, old, replacement, path) {
  if (text.split(old).length !== 2)
    throw new Error(
      `Version-reference drift in ${path}: expected exactly one ${JSON.stringify(old)}`,
    );
  return text.replace(old, () => replacement);
}
function manifestVersion(text, name, old, latest) {
  const pattern = new RegExp(
    `${escape(JSON.stringify(name))}(\\s*:\\s*)${escape(JSON.stringify(old))}`,
    "g",
  );
  if ([...text.matchAll(pattern)].length !== 1) throw new Error(`Ambiguous manifest pin: ${name}`);
  return text.replace(
    pattern,
    (_match, space) => `${JSON.stringify(name)}${space}${JSON.stringify(latest)}`,
  );
}

// These are source contracts, not a repository-wide search/replace. Historical
// rejected versions and generated output must remain literal/untouched.
function webReferences(root, old, latest) {
  if (!stableVersion.test(old))
    throw new Error("pi-web-access must have an exact stable source pin");
  const edits = [
    [
      "bin/runtime-support.mjs",
      [
        [
          `assert.equal(pkg.version, "${old}", "Package-local pi-web-access must be pinned to ${old}");`,
          `assert.equal(pkg.version, "${latest}", "Package-local pi-web-access must be pinned to ${latest}");`,
        ],
      ],
    ],
    ["scripts/build.mjs", [[`web access ${old}`, `web access ${latest}`]]],
    ["harness/README.md", [[`\`pi-web-access\` ${old}`, `\`pi-web-access\` ${latest}`]]],
    ["harness/docs/development.md", [[`\`pi-web-access\` ${old}`, `\`pi-web-access\` ${latest}`]]],
    ["harness/docs/security.md", [[`\`pi-web-access\`\n${old}`, `\`pi-web-access\`\n${latest}`]]],
    [
      "THIRD_PARTY_NOTICES.md",
      [
        [`## pi-web-access ${old}`, `## pi-web-access ${latest}`],
        [`\`pi-web-access\` ${old}`, `\`pi-web-access\` ${latest}`],
      ],
    ],
    [
      "test/runtime/runtime.test.mjs",
      [
        [`"pi-web-access":"${old}"`, `"pi-web-access":"${latest}"`],
        [
          `"name":"pi-web-access","version":"${old}"`,
          `"name":"pi-web-access","version":"${latest}"`,
        ],
        [
          `/Package-local pi-web-access must be pinned to ${escape(old)}/`,
          `/Package-local pi-web-access must be pinned to ${escape(latest)}/`,
        ],
      ],
    ],
  ];
  return edits.map(([path, replacements]) => {
    const original = snapshot(root, path);
    let updated = original.text;
    for (const [from, to] of replacements) updated = replaceOnce(updated, from, to, path);
    return { ...original, updated };
  });
}
function publish(root, files, onWrite, removeTree, cleanupErrors) {
  const unchanged = (original) => {
    const current = snapshot(root, original.path);
    if (current.text !== original.text || current.mode !== original.mode)
      throw new Error(`Source changed during upgrade: ${original.path}`);
  };
  for (const original of files) unchanged(original);
  for (const original of files) {
    if (original.text === original.updated) continue;
    unchanged(original);
    const target = join(root, original.path),
      staging = mkdtempSync(join(dirname(target), ".upgrade-deps-"));
    try {
      const pending = join(staging, "pending");
      writeFileSync(pending, original.updated, { mode: original.mode });
      chmodSync(pending, original.mode);
      onWrite();
      renameSync(pending, target);
    } finally {
      cleanup(staging, removeTree, cleanupErrors);
    }
    if (cleanupErrors.length)
      throw new Error("Temporary publication cleanup failed; inspect partial source changes");
  }
}

export function runUpgrade(
  options,
  { root = sourceRoot, runNpm = defaultNpm, removeTree = defaultRemoveTree } = {},
) {
  // Validate programmatic callers just as strictly as the CLI.
  options = parseArgs([
    `--${options.mode}`,
    ...options.packages.flatMap((name) => ["--package", name]),
  ]);
  if (options.mode === "help") return { mode: "help", ok: true, usage };
  requireAbsent(
    root,
    "npm-shrinkwrap.json",
    "authoritative shrinkwrap requires manual migration; package-lock.json must be the only lockfile",
  );
  const manifest = snapshot(root, "package.json"),
    lockfile = snapshot(root, "package-lock.json");
  const pkg = JSON.parse(manifest.text),
    lock = validateLock(JSON.parse(lockfile.text));
  if (!record(pkg) || pkg.name !== "pi-alehouse")
    throw new Error("Expected the pi-alehouse source manifest");
  for (const field of ["dependencies", "devDependencies"]) {
    if (
      pkg[field] !== undefined &&
      (!record(pkg[field]) || Object.values(pkg[field]).some((value) => typeof value !== "string"))
    ) {
      throw new Error(`Invalid manifest ${field}`);
    }
  }
  const report = { mode: options.mode, ok: true, packages: [], commands: [] };
  function execute(args, cwd = root, capture = true) {
    let result;
    try {
      result = runNpm(args, { cwd, capture });
    } catch (error) {
      result = { error };
    }
    const status =
      result?.error || result?.signal || !Number.isInteger(result?.status) ? null : result.status;
    report.commands.push({ args, status });
    return { ...result, status };
  }
  function requireSuccess(args, cwd = root) {
    const result = execute(args, cwd);
    if (result.status !== 0)
      throw new Error(
        `npm ${args.join(" ")} failed (${result.status ?? "no exit"}): ${String(result.error?.message ?? result.stderr ?? result.stdout ?? "").slice(-4000)}`,
      );
    return result;
  }
  function audit(args) {
    const result = execute(args);
    try {
      const data = JSON.parse(result.stdout),
        counts = data?.metadata?.vulnerabilities;
      if (
        !record(data) ||
        data.auditReportVersion !== 2 ||
        !record(counts) ||
        !record(data.vulnerabilities) ||
        data.error ||
        ![0, 1].includes(result.status) ||
        [...severities, "total"].some(
          (key) =>
            !Object.hasOwn(counts, key) || !Number.isSafeInteger(counts[key]) || counts[key] < 0,
        ) ||
        severities.reduce((sum, key) => sum + counts[key], 0) !== counts.total ||
        Object.keys(data.vulnerabilities).length !== counts.total ||
        (result.status === 1 && counts.total === 0)
      ) {
        throw new Error("Missing or inconsistent audit report");
      }
      const tally = Object.fromEntries(severities.map((key) => [key, 0]));
      for (const entry of Object.values(data.vulnerabilities)) {
        if (!record(entry) || !severities.includes(entry.severity))
          throw new Error("Invalid vulnerability severity");
        tally[entry.severity]++;
      }
      if (severities.some((key) => tally[key] !== counts[key]))
        throw new Error("Inconsistent vulnerability severities");
      return {
        ok: result.status === 0 && counts.total === 0,
        status: result.status,
        counts,
        packages: Object.keys(data.vulnerabilities),
      };
    } catch {
      return {
        ok: false,
        status: result.status,
        error: "Audit failed or returned an invalid report; vulnerability count unknown",
      };
    }
  }
  if (options.mode === "verify") {
    const build = execute(["run", "build"], root, false);
    const check = build.status === 0 ? execute(["run", "check"], root, false) : undefined;
    const configuration = execute(["config", "get", "offline", "--json"]);
    let blocked;
    try {
      const offline = JSON.parse(configuration.stdout);
      if (configuration.status !== 0 || typeof offline !== "boolean")
        throw new Error("Unknown offline configuration");
      if (offline)
        blocked = {
          ok: false,
          status: null,
          unrun: "offline_config",
          error: "Offline npm configuration: audit unrun; vulnerability count unknown",
        };
    } catch {
      blocked = {
        ok: false,
        status: null,
        unrun: "audit_config_unavailable",
        error:
          "Cannot determine npm offline configuration: audit unrun; vulnerability count unknown",
      };
    }
    report.verification = {
      build: { ok: build.status === 0, status: build.status },
      check: check ? { ok: check.status === 0, status: check.status } : { unrun: "build_failed" },
      runtimeAudit: blocked
        ? { ...blocked }
        : audit([
            "audit",
            "--omit=dev",
            "--omit=peer",
            "--include=optional",
            "--json",
            "--offline=false",
          ]),
      fullAudit: blocked
        ? { ...blocked }
        : audit([
            "audit",
            "--include=dev",
            "--include=optional",
            "--include=peer",
            "--json",
            "--offline=false",
          ]),
    };
    report.ok = Object.values(report.verification).every((value) => value.ok === true);
    report.scope =
      "Portable source checks only; host/model/human-approval/deployment/publication lanes unrun";
    return report;
  }

  if (options.mode === "apply") {
    let git;
    try {
      git = lstatSync(join(root, ".git"));
    } catch {
      /* reported below */
    }
    if (!git || (!git.isDirectory() && !git.isFile()))
      throw new Error(
        "--apply requires a source checkout (.git); installed packages must not be upgraded in place",
      );
    if (pkg.overrides && Object.keys(pkg.overrides).length)
      throw new Error("Existing overrides require manual compatibility review; no automatic apply");
    applyConfig(root);
  }
  const names = options.packages.length
    ? options.packages
    : [...Object.keys(pkg.dependencies ?? {}), ...Object.keys(pkg.devDependencies ?? {})];
  for (const name of names) {
    if (name.length > 214 || !packageName.test(name))
      throw new Error(`Invalid manifest package name: ${name}`);
    const section = Object.hasOwn(pkg.dependencies ?? {}, name)
      ? "dependencies"
      : Object.hasOwn(pkg.devDependencies ?? {}, name)
        ? "devDependencies"
        : "transitive";
    const current = versions(lock, name);
    if (!current.length) throw new Error(`Package absent from lockfile: ${name}`);
    if (options.mode === "apply" && manualOnly(name))
      throw new Error(
        `${name} requires manual contract migration; this script will not upgrade it`,
      );
    report.packages.push({
      name,
      section,
      current,
      latest: undefined,
      manual: manualOnly(name),
      ranges: ranges(lock, name),
    });
  }
  for (const entry of report.packages) {
    const result = requireSuccess(["view", entry.name, "dist-tags.latest", "--json"]);
    const latest = JSON.parse(result.stdout);
    if (typeof latest !== "string" || !stableVersion.test(latest))
      throw new Error(`No stable latest tag for ${entry.name}; manual review required`);
    entry.latest = latest;
  }
  report.note =
    "latest is the registry tag, not the minimum fix. npm resolves transitive versions within upstream ranges on apply; constrained versions may differ from latest. npm's cache/network may change even in plan mode.";
  report.review =
    "Review upstream APIs, tool schemas, security behavior and licenses. Synced version labels alone do not establish compatibility; run --verify separately. No deployment or user-resource changes are performed.";
  if (options.mode === "plan") return report;

  let updatedManifest = manifest.text;
  const direct = report.packages.filter((entry) => entry.section !== "transitive");
  const transitive = report.packages.filter((entry) => entry.section === "transitive");
  for (const entry of direct) {
    const old = pkg[entry.section][entry.name];
    if (old !== entry.latest)
      updatedManifest = manifestVersion(updatedManifest, entry.name, old, entry.latest);
  }
  const web = direct.find(
    (entry) => entry.name === "pi-web-access" && pkg[entry.section][entry.name] !== entry.latest,
  );
  const references = web ? webReferences(root, pkg[web.section][web.name], web.latest) : [];
  const expected = JSON.parse(updatedManifest);
  const staging = mkdtempSync(join(tmpdir(), "pi-alehouse-upgrade-"));
  let publicationStarted = false,
    failure;
  const cleanupErrors = [];
  try {
    writeFileSync(join(staging, "package.json"), updatedManifest);
    writeFileSync(join(staging, "package-lock.json"), lockfile.text);
    if (updatedManifest !== manifest.text)
      requireSuccess(["install", "--package-lock-only", ...mutationFlags], staging);
    if (transitive.length)
      requireSuccess(
        [
          "update",
          "--package-lock-only",
          ...mutationFlags,
          "--",
          ...transitive.map((entry) => entry.name),
        ],
        staging,
      );
    const stagedManifest = JSON.parse(readFileSync(join(staging, "package.json"), "utf8"));
    const updatedLock = readFileSync(join(staging, "package-lock.json"), "utf8"),
      resolvedLock = validateLock(JSON.parse(updatedLock));
    if (!isDeepStrictEqual(stagedManifest, expected))
      throw new Error("npm changed unrelated manifest fields; source left unchanged");
    for (const field of ["dependencies", "devDependencies"]) {
      if (!isDeepStrictEqual(resolvedLock.packages?.[""]?.[field], expected[field]))
        throw new Error(`Staged lockfile ${field} does not match manifest`);
    }
    checkProtectedGraph(lock, resolvedLock);
    for (const entry of report.packages) {
      entry.resolved = versions(resolvedLock, entry.name);
      entry.ranges = ranges(resolvedLock, entry.name);
      entry.matchesLatest =
        entry.resolved.length > 0 && entry.resolved.every((version) => version === entry.latest);
      if (
        !entry.resolved.length ||
        (entry.section !== "transitive" &&
          resolvedLock.packages?.[`node_modules/${entry.name}`]?.version !== entry.latest)
      ) {
        throw new Error(`Staged lockfile did not resolve the selected pin: ${entry.name}`);
      }
    }
    const sourceFiles = [
      { ...manifest, updated: updatedManifest },
      { ...lockfile, updated: updatedLock },
      ...references,
    ];
    applyConfig(root);
    publish(
      root,
      sourceFiles,
      () => {
        publicationStarted = true;
      },
      removeTree,
      cleanupErrors,
    );
    report.applied = true;
    report.changedFiles = sourceFiles
      .filter((file) => file.text !== file.updated)
      .map((file) => file.path);
    applyConfig(root);
    publicationStarted = true; // npm ci can mutate node_modules even if source needed no changes.
    const installed = execute(
      ["ci", "--include=dev", "--dry-run=false", "--package-lock-only=false", ...flags],
      root,
      false,
    );
    if (installed.status !== 0) {
      report.ok = false;
      report.partial = true;
      report.error =
        "Source updated but npm ci failed; node_modules may be incomplete. Inspect before retrying; no rollback was attempted.";
    }
    report.verification = { unrun: "Run --verify after reviewing the source changes" };
  } catch (error) {
    if (!publicationStarted) failure = error instanceof Error ? error : new Error(message(error));
    else
      Object.assign(report, {
        ok: false,
        partial: true,
        error: `${message(error)}; multi-file publication may be partial. Inspect source; no rollback was attempted.`,
      });
  }
  cleanup(staging, removeTree, cleanupErrors);
  if (cleanupErrors.length) {
    if (failure) failure.cleanupErrors = cleanupErrors;
    else {
      report.ok = false;
      report.partial = publicationStarted;
      report.cleanupErrors = cleanupErrors;
      report.error ??=
        "Temporary cleanup failed; inspect retained paths before any retry. No rollback was attempted.";
    }
  }
  if (failure) throw failure;
  return report;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const options = parseArgs(process.argv.slice(2));
    if (options.mode === "help") console.log(usage);
    else {
      const report = runUpgrade(options);
      console.log(JSON.stringify(report, null, 2));
      process.exitCode = report.ok ? 0 : 1;
    }
  } catch (error) {
    console.error(
      JSON.stringify({
        ok: false,
        error: message(error),
        ...(error?.cleanupErrors ? { cleanupErrors: error.cleanupErrors } : {}),
      }),
    );
    process.exitCode = 1;
  }
}
