// Current source, controlled filesystem + real authority alias binding. No build,
// SDK session, provider, network, Git, or shared generated output is used here.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs, { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join, normalize, resolve } from "node:path";
import test from "node:test";
import ts from "typescript";

const dataModule = source => `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`;
const output = path => ts.transpileModule(readFileSync(new URL(path, import.meta.url), "utf8"), {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022, rewriteRelativeImportExtensions: true },
}).outputText;
const portsUrl = dataModule(output("../../src/core/ports.ts"));
const dispatchUrl = dataModule(output("../../src/core/dispatch.ts").replace('"./ports.js"', JSON.stringify(portsUrl)));
const namesUrl = dataModule(output("../../src/tools/tool-names.ts"));
// start()/flock is outside this prepare-only suite; any accidental allocation fails.
const lockUrl = dataModule('export class FileLeaseLock { constructor() { throw new Error("UNEXPECTED_TREE_ALLOCATION"); } }');
const runtimeUrl = dataModule(output("../../src/runtime/dispatch-runtime.ts")
  .replace('"../core/dispatch.js"', JSON.stringify(dispatchUrl))
  .replace('"../core/ports.js"', JSON.stringify(portsUrl))
  .replace('"../tools/tool-names.js"', JSON.stringify(namesUrl))
  .replace('"./owner-lease.js"', JSON.stringify(lockUrl)));
const pathSurfacesUrl = dataModule(output("../../../node_modules/@gotgenes/pi-permission-system/src/access-intent/path-surfaces.ts"));
const snapshotUrl = dataModule(output("../../../permission-system/managed-permission-snapshot.ts"));
const policyUrl = dataModule(output("../../../permission-system/managed-workspace-policy.ts")
  .replace('"#src/access-intent/path-surfaces"', JSON.stringify(pathSurfacesUrl))
  .replace('"./managed-permission-snapshot"', JSON.stringify(snapshotUrl)));
const { createDispatchRuntime } = await import(runtimeUrl);
const { bindWorkspacePolicy, workspacePolicyAliases, workspacePolicyForContext } = await import(policyUrl);

function fixture(t, nested = false) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "alehouse-dispatch-binding-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const sourceRoot = join(root, "source"), checkoutRoot = join(root, "checkout"), agentDir = join(root, "agent");
  const sourceCwd = nested ? join(sourceRoot, "nested") : sourceRoot;
  const cwd = nested ? join(checkoutRoot, "nested") : checkoutRoot;
  for (const dir of [sourceCwd, cwd, agentDir]) mkdirSync(dir, { recursive: true });
  const calls = [];
  let verdict = () => "ask";
  const runtime = createDispatchRuntime({ agentDir, flock: "/not-invoked/flock", getPermissionsService: () => ({
    checkPermission(surface, path, profile) { calls.push({ surface, path, profile }); return { state: verdict(surface, path, profile) }; },
  }) });
  const base = { cwd: sourceCwd, source_cwd: sourceCwd, profile: "editor", deferInputs: false };
  const unbound = { ...base, unbound_worktree: "trusted-agent-id" };
  const bind = (changes = {}) => {
    const input = { sessionId: randomUUID(), cwd, source_cwd: sourceCwd, checkout_root: checkoutRoot, source_root: sourceRoot,
      projectTrusted: true, ...changes };
    const lease = bindWorkspacePolicy(input);
    t.after(() => lease.release());
    return { input, lease, context: { ...base, cwd: input.cwd, source_cwd: input.source_cwd, workspace_policy: lease } };
  };
  return { root, sourceRoot, checkoutRoot, sourceCwd, cwd, agentDir, calls, runtime, base, unbound, bind,
    verdict(fn) { verdict = fn; } };
}
const code = expected => error => { assert.equal(error.code, expected); return true; };
function noPathIO(body) {
  const methods = ["statSync", "lstatSync", "realpathSync"], originals = methods.map(name => fs[name]);
  for (const name of methods) fs[name] = () => assert.fail(`unbound source ${name} is not execution IO`);
  syncBuiltinESMExports();
  try { return body(); }
  finally { methods.forEach((name, index) => { fs[name] = originals[index]; }); syncBuiltinESMExports(); }
}

test("uninitialized relative inputs/ownership/tree are normalized logical resources without source IO", t => {
  const f = fixture(t);
  writeFileSync(join(f.sourceCwd, "source-only"), "dirty source file\n");
  writeFileSync(join(f.sourceCwd, "build"), "not a directory in source\n");
  symlinkSync("absent", join(f.sourceCwd, "dangling"));
  const raw = { inputs: ["source-only", "missing", "dangling/input", "../sibling/../outside"],
    ownership: ["./out/../new file"], tree: "./build", checks: ["focused fixture"] };
  const prepared = noPathIO(() => f.runtime.prepare(raw, f.unbound));
  const logical = rel => ({ kind: "unbound_worktree", agent_id: "trusted-agent-id", rel });
  assert.deepEqual(prepared.inputs, ["source-only", "missing", "dangling/input", "../outside"].map(logical));
  assert.deepEqual(prepared.ownership, [logical("new file")]);
  assert.deepEqual(prepared.tree, logical("build"));
  assert.deepEqual(structuredClone(prepared), prepared, "prepared data is synchronous and function-free");
  raw.inputs.push("later"); assert.equal(prepared.declaration.inputs.length, 4);
  assert.equal(existsSync(join(f.cwd, "new file")), false);
  assert(f.calls.every(call => call.profile === "editor"), "use target profile, not Agent nickname");
  assert(f.calls.some(call => call.surface === "external_directory_read" && call.path === join(f.root, "outside")));
});

for (const requested of ["build/", "./", `${"../".repeat(80)}not-created/`]) {
  test(`unbound logical normalization preserves the literal relative semantics: ${requested}`, t => {
    const f = fixture(t);
    const raw = { inputs: [requested], ownership: [requested], tree: requested };
    const directories = [f.sourceCwd, f.cwd, f.agentDir];
    const before = directories.map(path => readdirSync(path));
    const prepared = noPathIO(() => f.runtime.prepare(raw, f.unbound));
    const expected = { kind: "unbound_worktree", agent_id: f.unbound.unbound_worktree, rel: normalize(requested) };
    assert.deepEqual(prepared.inputs, [expected]);
    assert.deepEqual(prepared.ownership, [expected]);
    assert.deepEqual(prepared.tree, expected);
    assert.deepEqual(structuredClone(prepared), prepared);
    assert.deepEqual(directories.map(path => readdirSync(path)), before, "logical inputs/outputs/tree allocate nothing");
    assert(f.calls.every(call => call.path === resolve(f.sourceCwd, requested)), "source resolution is only the deny query candidate");
    // No IO occurs at this alternate source base either. The logical spelling
    // must be independent of source depth, unlike a root-clamped round trip.
    const shallow = noPathIO(() => f.runtime.prepare(raw, { ...f.unbound, cwd: "/shallow-source", source_cwd: "/shallow-source" }));
    assert.deepEqual(shallow, prepared);
  });
}

test("unbound lexical .. checks external read/write even though source ALLOW is not imported", t => {
  const f = fixture(t);
  for (const [declaration, deniedSurface] of [[{ inputs: ["../outside"] }, "external_directory_read"],
    [{ ownership: ["../outside"] }, "external_directory_write"], [{ tree: "../outside" }, "external_directory_write"]]) {
    f.verdict(surface => surface === deniedSurface ? "deny" : "allow");
    noPathIO(() => assert.throws(() => f.runtime.prepare(declaration, f.unbound), error => {
      assert.equal(error.code, "PREFLIGHT_DENIED"); assert.equal(error.details.surface, deniedSurface); return true;
    }));
  }
});

test("known source deny precedes source ancestry/type/existence diagnoses in unbound mode", t => {
  const f = fixture(t);
  f.verdict((surface, path, profile) => {
    assert.equal(profile, "researcher");
    return surface === "path_write" && path === join(f.sourceCwd, "tree") ? "deny" : "unknown";
  });
  noPathIO(() => assert.throws(() => f.runtime.prepare({ inputs: ["missing"], tree: "tree" }, { ...f.unbound, profile: "researcher" }), error => {
    assert.equal(error.code, "PREFLIGHT_DENIED"); assert.equal(error.details.key, "tree"); return true;
  }));
});

test("absolute inputs stay immediately bound and missing/denied even for an uninitialized worktree", t => {
  const f = fixture(t), input = join(f.sourceCwd, "explicit.txt");
  writeFileSync(input, "explicit source input\n");
  const prepared = f.runtime.prepare({ inputs: ["not-yet-available", input] }, f.unbound);
  assert.deepEqual(prepared.inputs[1], { path: input, canonical: input });
  assert.throws(() => f.runtime.prepare({ inputs: [join(f.sourceCwd, "absent")] }, f.unbound), code("DISPATCH_INPUT_MISSING"));
  f.verdict(() => "deny");
  noPathIO(() => assert.throws(() => f.runtime.prepare({ inputs: [input] }, f.unbound), code("PREFLIGHT_DENIED")));
});

test("first bound prepare uses actual nested execution cwd for inputs, ownership and new tree", t => {
  const f = fixture(t, true), { context } = f.bind();
  writeFileSync(join(f.cwd, "baseline file"), "committed fixture\n");
  const raw = { inputs: ["baseline file"], ownership: ["out/new"], tree: "build" };
  const logical = f.runtime.prepare(raw, f.unbound);
  assert.equal(logical.tree.kind, "unbound_worktree");
  f.calls.length = 0;
  const prepared = f.runtime.prepare(raw, context);
  assert.deepEqual(prepared.inputs, [{ path: join(f.cwd, "baseline file"), canonical: join(f.cwd, "baseline file") }]);
  assert.equal(prepared.ownership[0].path, join(f.cwd, "out/new"));
  assert.equal(prepared.tree.canonical, join(f.cwd, "build"));
  assert(f.calls.some(call => call.path === join(f.sourceCwd, "baseline file")), "authority maps the nested execution offset back to source");
  assert.equal(existsSync(prepared.tree.path), false, "prepare creates no tree");
  assert.deepEqual(structuredClone(prepared), prepared);
});

test("source dirty-only input never proves existence in the bound workspace", t => {
  const f = fixture(t), { context } = f.bind();
  writeFileSync(join(f.sourceCwd, "dirty-only"), "not copied\n");
  f.verdict(() => "allow");
  f.runtime.prepare({ inputs: ["dirty-only"] }, f.unbound);
  assert.throws(() => f.runtime.prepare({ inputs: ["dirty-only"] }, context), error => {
    assert.equal(error.code, "DISPATCH_INPUT_MISSING"); assert.equal(error.details.path, join(f.cwd, "dirty-only")); return true;
  });
  // An explicit absolute source input retains its ordinary external semantics.
  f.runtime.prepare({ inputs: [join(f.sourceCwd, "dirty-only")] }, context);
  assert(f.calls.some(call => call.surface === "external_directory_read" && call.path === join(f.sourceCwd, "dirty-only")));
});

test("actual existing non-directory tree fails only after binding, not from source classification", t => {
  const f = fixture(t), { context } = f.bind();
  writeFileSync(join(f.cwd, "build"), "not a directory\n");
  f.runtime.prepare({ tree: "build" }, f.unbound);
  assert.throws(() => f.runtime.prepare({ tree: "build" }, context), code("DISPATCH_TREE_TYPE"));
});

test("live lease aliases exactly reuse the authority whole-root lexical/canonical mapping", t => {
  const f = fixture(t, true), sourceLink = join(f.root, "source-link");
  symlinkSync(f.sourceRoot, sourceLink);
  const { input, lease } = f.bind({ source_root: sourceLink, source_cwd: join(sourceLink, "nested") });
  assert(Object.isFrozen(lease));
  const record = workspacePolicyForContext({ cwd: input.cwd, sessionManager: { getSessionId: () => input.sessionId } });
  const paths = [join(f.checkoutRoot, "sibling/new"), join(f.cwd, "nested-output"), join(f.root, "other-checkout/file")];
  assert.deepEqual(lease.aliases(paths), workspacePolicyAliases(record, paths));
  assert.deepEqual(lease.aliases([paths[0]]), [join(sourceLink, "sibling/new"), join(f.sourceRoot, "sibling/new")]);
  assert.deepEqual(lease.aliases([paths[2]]), []);
});

test("source alias deny beats missing inputs and dangling path interpretation", t => {
  const f = fixture(t), { context } = f.bind();
  symlinkSync("gone", join(f.cwd, "dangling"));
  f.verdict((surface, path) => surface === "path_write" && path === join(f.sourceCwd, "denied-tree") ? "deny" : "ask");
  assert.throws(() => f.runtime.prepare({ inputs: ["dangling/input", "missing"], tree: "denied-tree" }, context), error => {
    assert.equal(error.code, "PREFLIGHT_DENIED"); assert.equal(error.details.path, join(f.sourceCwd, "denied-tree")); return true;
  });
});

test("canonical workspace aliases deny symlinked future outputs before missing input classification", t => {
  const f = fixture(t), { context } = f.bind();
  mkdirSync(join(f.checkoutRoot, "protected"));
  symlinkSync("protected", join(f.cwd, "alias"));
  f.verdict((surface, path) => surface === "path_write" && path === join(f.sourceRoot, "protected/new") ? "deny" : "allow");
  assert.throws(() => f.runtime.prepare({ inputs: ["missing"], ownership: ["alias/new"] }, context), error => {
    assert.equal(error.code, "PREFLIGHT_DENIED"); assert.equal(error.details.path, join(f.sourceRoot, "protected/new")); return true;
  });
});

for (const rel of ["../sibling/new", "sibling-link/new"]) test(`bound external boundary is not exempted by source ALLOW: ${rel}`, t => {
  const f = fixture(t, true), { context } = f.bind();
  mkdirSync(join(f.checkoutRoot, "sibling"));
  symlinkSync("../sibling", join(f.cwd, "sibling-link"));
  f.verdict((surface, path) => surface === "external_directory_write" && path === join(f.checkoutRoot, "sibling/new") ? "deny" : "allow");
  assert.throws(() => f.runtime.prepare({ ownership: [rel] }, context), error => {
    assert.equal(error.code, "PREFLIGHT_DENIED"); assert.equal(error.details.surface, "external_directory_write");
    assert.equal(error.details.path, join(f.checkoutRoot, "sibling/new")); return true;
  });
});

test("duplicate lexical/canonical alias permission queries are deduplicated only within one preparation", t => {
  const f = fixture(t), { context } = f.bind();
  f.runtime.prepare({ tree: "build" }, context);
  const first = structuredClone(f.calls);
  assert(first.some(call => call.path === join(f.sourceCwd, "build")), "source alias still participates");
  assert.equal(new Set(first.map(call => JSON.stringify(call))).size, first.length, "one query per surface/path/profile for this declaration");
  f.runtime.prepare({ tree: "build" }, context);
  assert.deepEqual(f.calls, [...first, ...first], "a later prepare must requery live policy, not use a persistent cache");
});

test("canonical external discovery still checks the lexical source alias on its newly required surface", t => {
  const f = fixture(t, true), { context } = f.bind();
  mkdirSync(join(f.checkoutRoot, "sibling"));
  symlinkSync("../sibling", join(f.cwd, "alias"));
  const lexicalAlias = join(f.sourceCwd, "alias/new");
  f.verdict((surface, path) => surface === "external_directory_write" && path === lexicalAlias ? "deny" : "allow");
  assert.throws(() => f.runtime.prepare({ tree: "alias/new" }, context), error => {
    assert.equal(error.code, "PREFLIGHT_DENIED"); assert.equal(error.details.path, lexicalAlias);
    assert.equal(error.details.surface, "external_directory_write"); return true;
  });
  assert.equal(f.calls.filter(call => call.surface === "path_write" && call.path === lexicalAlias).length, 1);
  assert.equal(f.calls.filter(call => call.surface === "external_directory_write" && call.path === lexicalAlias).length, 1,
    "path deduplication must not suppress a different permission surface");
});

test("source alias external deny supplements actual external ask without importing allow", t => {
  const f = fixture(t, true), { context } = f.bind();
  f.verdict((surface, path) => path.startsWith(f.sourceRoot) ? (surface === "external_directory_write" ? "deny" : "allow") : "ask");
  assert.throws(() => f.runtime.prepare({ tree: "../build" }, context), error => {
    assert.equal(error.code, "PREFLIGHT_DENIED"); assert.equal(error.details.surface, "external_directory_write");
    assert.equal(error.details.path, join(f.sourceRoot, "build")); return true;
  });
  assert(f.calls.some(call => call.surface === "external_directory_write" && call.path === join(f.checkoutRoot, "build")), "actual boundary is independently queried");
});

test("released live binding fails closed for path-bearing and checks-only prepare", t => {
  const f = fixture(t), { context, lease } = f.bind();
  f.runtime.prepare({ tree: "build" }, context);
  lease.release(); lease.release();
  assert.throws(() => lease.aliases([]), /stale or forged/);
  for (const declaration of [{ tree: "build" }, { checks: ["focused fixture"] }])
    assert.throws(() => f.runtime.prepare(declaration, context), code("DISPATCH_PREFLIGHT_UNAVAILABLE"));
});

test("live aliases fail closed when a bound root is replaced, without caching mapping", t => {
  const f = fixture(t), { context, lease } = f.bind();
  assert.deepEqual(lease.aliases([join(f.cwd, "out")]), [join(f.sourceCwd, "out")]);
  renameSync(f.sourceRoot, join(f.root, "moved-source"));
  const replacement = join(f.root, "replacement"); mkdirSync(replacement); symlinkSync(replacement, f.sourceRoot);
  assert.throws(() => f.runtime.prepare({ tree: "build" }, context), code("DISPATCH_PREFLIGHT_UNAVAILABLE"));
});

test("bound seam presence is authoritative even when execution and source cwd spellings match", t => {
  const f = fixture(t), { context, lease } = f.bind({ cwd: f.sourceCwd, checkout_root: f.sourceRoot });
  assert.equal(context.cwd, context.source_cwd);
  lease.release();
  assert.throws(() => f.runtime.prepare({ checks: ["focused"] }, context), code("DISPATCH_PREFLIGHT_UNAVAILABLE"));
});

test("missing/invalid/throwing/asynchronous workspace alias APIs are interface failures, not policy unknown", t => {
  const f = fixture(t);
  const invalid = [undefined, null, {}, [], Promise.resolve({}), { aliases: false },
    { get aliases() { throw new Error("getter failed"); } }, { aliases() { throw new Error("stale"); } },
    ...[undefined, null, {}, "alias", Promise.resolve([]), ["relative"], [join(f.sourceCwd, "../other")],
      Object.assign([], { then() {} }), new Array(1)].map(result => ({ aliases: () => result })),
    { aliases: paths => paths.length ? [42] : [] },
  ];
  for (const workspace_policy of invalid) {
    assert.throws(() => f.runtime.prepare({ tree: "build" }, { ...f.base, cwd: f.cwd, workspace_policy }), code("DISPATCH_PREFLIGHT_UNAVAILABLE"));
  }
  for (const state of ["ask", "allow", "unknown"]) {
    f.verdict(() => state);
    const { context } = f.bind();
    assert.equal(f.runtime.prepare({ tree: "build" }, context).tree.path, join(f.cwd, "build"));
  }
});
