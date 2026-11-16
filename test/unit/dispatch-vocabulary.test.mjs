import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";
import {
  publicDispatchErrorCode,
  publicDispatchParameter,
  publicDispatchToInternal,
  validateDispatch,
  validatePublicDispatch,
} from "../../dist/orchestration/core/dispatch.js";
import { OwnerController } from "../../dist/orchestration/core/owner-controller.js";
import { OrchestrationError } from "../../dist/orchestration/core/ports.js";
import { FakePort, ended, task, tick, until } from "../support/controller-fixture.mjs";
import { assertOwnerInvariants } from "../support/owner-invariants.mjs";

// One shared shape validator backs both vocabularies: the public tool-argument
// shape is strict (old/mixed internal keys are undeclared fields, never
// aliases), the internal record contract is unchanged, and every helper is a
// pure read/copy. No filesystem, Git, flock, SDK or provider in this file.

const invalid = (resolution, key, index) => (error) => {
  assert.equal(error.code, "INVALID_DISPATCH");
  assert.equal(error.details.resolution, resolution);
  assert.equal(error.details.key, key);
  assert.equal(error.details.index, index);
  return true;
};

test("the public shape accepts only public keys; old and mixed keys are undeclared", () => {
  validatePublicDispatch({
    required_paths: ["src/in.ts"],
    ownership: ["src/out.ts"],
    build_dir: "build",
    checks: ["focused"],
  });
  const undeclared = invalid(
    "Remove undeclared dispatch fields; use only required_paths, ownership, build_dir and checks.",
  );
  for (const value of [
    { inputs: ["src"] },
    { tree: "build" },
    { required_paths: ["src"], tree: "build" },
    { inputs: ["src"], build_dir: "build" },
    { required_paths: ["src"], extra: true },
  ])
    assert.throws(() => validatePublicDispatch(value), undeclared, JSON.stringify(value));
  const notObject = invalid(
    "dispatch must be an object with only required_paths, ownership, build_dir and checks.",
  );
  for (const value of [undefined, null, "dispatch", 7, [], ["required_paths"]])
    assert.throws(() => validatePublicDispatch(value), notObject);
});

test("public bounds and details keep every old rule under public names", () => {
  const many = Array.from({ length: 33 }, (_, index) => `p-${index}`);
  assert.throws(
    () => validatePublicDispatch({ required_paths: many }),
    invalid("dispatch.required_paths accepts at most 32 items; received 33.", "required_paths"),
  );
  assert.throws(
    () => validatePublicDispatch({ ownership: Array.from({ length: 17 }, (_, i) => `o-${i}`) }),
    invalid("dispatch.ownership accepts at most 16 items; received 17.", "ownership"),
  );
  assert.throws(
    () => validatePublicDispatch({ checks: Array.from({ length: 17 }, (_, i) => `c-${i}`) }),
    invalid("dispatch.checks accepts at most 16 items; received 17.", "checks"),
  );
  assert.throws(
    () => validatePublicDispatch({ required_paths: ["x".repeat(513)] }),
    invalid(
      "dispatch.required_paths.0 must contain at most 512 characters; received 513.",
      "required_paths",
      0,
    ),
  );
  assert.throws(
    () => validatePublicDispatch({ required_paths: ["a\nb"] }),
    invalid(
      "dispatch.required_paths.0 must not contain ASCII control characters.",
      "required_paths",
      0,
    ),
  );
  for (const path of [
    " pad ",
    "src/*.ts",
    "~home",
    "@at",
    "$HOME",
    "qu'ote",
    'da"sh',
    "ba`ck",
    "sla\\sh",
  ])
    assert.throws(
      () => validatePublicDispatch({ required_paths: [path] }),
      invalid(
        "dispatch.required_paths.0 must be a literal path without padding (leading/trailing whitespace), globs, shell quoting or expansion.",
        "required_paths",
        0,
      ),
      path,
    );
  assert.throws(
    () => validatePublicDispatch({ required_paths: ["src", "src"] }),
    invalid(
      "dispatch.required_paths must contain unique entries; remove duplicates.",
      "required_paths",
    ),
  );
  assert.throws(
    () => validatePublicDispatch({ required_paths: [] }),
    invalid("dispatch.required_paths must contain at least 1 item.", "required_paths"),
  );
  assert.throws(
    () => validatePublicDispatch({ required_paths: "src" }),
    invalid("dispatch.required_paths must be an array.", "required_paths"),
  );
  assert.throws(
    () => validatePublicDispatch({ build_dir: "" }),
    invalid("dispatch.build_dir must be a nonblank string.", "build_dir"),
  );
  assert.throws(
    () => validatePublicDispatch({ build_dir: " pad " }),
    invalid(
      "dispatch.build_dir must be a literal path without padding (leading/trailing whitespace), globs, shell quoting or expansion.",
      "build_dir",
    ),
  );
  // Checks keep their own rules: globs and padding are legal, bounds are not.
  validatePublicDispatch({ checks: ["unit/*.test.mjs", " padded "] });
  assert.throws(
    () => validatePublicDispatch({ checks: ["a\nb"] }),
    invalid("dispatch.checks.0 must not contain ASCII control characters.", "checks", 0),
  );
});

test("validation reads only: frozen declarations pass through untouched", () => {
  const value = Object.freeze({
    required_paths: Object.freeze(["src/in.ts"]),
    build_dir: "build",
  });
  const before = structuredClone(value);
  assert.throws(() => validatePublicDispatch({ ...value, tree: "build" }));
  assert.throws(() => validatePublicDispatch({ required_paths: Object.freeze([""]) }));
  assert.deepEqual(value, before);
});

test("the internal shape is unchanged and rejects public keys as undeclared", () => {
  validateDispatch({ inputs: ["src"], ownership: ["out"], tree: "build", checks: ["focused"] });
  assert.throws(
    () => validateDispatch({ required_paths: ["src"] }),
    invalid("Remove undeclared dispatch fields; use only inputs, ownership, tree and checks."),
  );
  assert.throws(
    () => validateDispatch({ inputs: [""] }),
    invalid("dispatch.inputs.0 must be a nonblank string.", "inputs", 0),
  );
  assert.throws(
    () => validateDispatch({ tree: " pad " }),
    invalid(
      "dispatch.tree must be a literal path without padding (leading/trailing whitespace), globs, shell quoting or expansion.",
      "tree",
    ),
  );
  assert.throws(
    () => validateDispatch({ inputs: Array.from({ length: 33 }, (_, i) => `p-${i}`) }),
    invalid("dispatch.inputs accepts at most 32 items; received 33.", "inputs"),
  );
  assert.throws(
    () => validateDispatch("dispatch"),
    invalid("dispatch must be an object with only inputs, ownership, tree and checks."),
  );
});

test("publicDispatchToInternal is a pure copy with byte-literal paths", () => {
  const raw = Object.freeze({
    required_paths: Object.freeze(["src/in.ts", "/explicit/file"]),
    ownership: Object.freeze(["src/out.ts"]),
    build_dir: "build",
    checks: Object.freeze(["focused"]),
  });
  const before = structuredClone(raw);
  const internal = publicDispatchToInternal(raw);
  assert.deepEqual(internal, {
    inputs: ["src/in.ts", "/explicit/file"],
    ownership: ["src/out.ts"],
    tree: "build",
    checks: ["focused"],
  });
  assert.equal(internal.inputs[0], raw.required_paths[0], "path strings stay byte-literal");
  assert.deepEqual(raw, before, "the public value is never mutated");
  internal.inputs.push("mutated");
  assert.deepEqual(raw, before, "output copies never alias the caller's arrays");
  assert.deepEqual(publicDispatchToInternal({ checks: ["c"] }), { checks: ["c"] });
  assert.deepEqual(publicDispatchToInternal({}), {});
});

test("publicDispatchErrorCode is an exact map, not a decoder or prefix rule", () => {
  assert.equal(publicDispatchErrorCode("BUILD_TREE_BUSY"), "BUILD_DIR_BUSY");
  assert.equal(publicDispatchErrorCode("DISPATCH_TREE_TYPE"), "DISPATCH_BUILD_DIR_TYPE");
  assert.equal(
    publicDispatchErrorCode("DISPATCH_TREE_INSPECTION_FAILED"),
    "DISPATCH_BUILD_DIR_INSPECTION_FAILED",
  );
  assert.equal(publicDispatchErrorCode("DISPATCH_INPUT_MISSING"), "DISPATCH_REQUIRED_PATH_MISSING");
  assert.equal(publicDispatchErrorCode("DISPATCH_INPUT_TYPE"), "DISPATCH_REQUIRED_PATH_TYPE");
  assert.equal(
    publicDispatchErrorCode("DISPATCH_INPUT_INSPECTION_FAILED"),
    "DISPATCH_REQUIRED_PATH_INSPECTION_FAILED",
  );
  // Internal-only and already-public codes pass through, as do near-misses.
  for (const code of [
    "DISPATCH_PATH_UNKNOWN",
    "DISPATCH_PREFLIGHT_UNAVAILABLE",
    "PREFLIGHT_DENIED",
    "RESOURCE_OWNED",
    "INVALID_DISPATCH",
    "DISPATCH_RESOURCE_CHANGED",
    "BUILD_TREE_BUSY ",
    "dispatch_tree_type",
    "toString",
    "constructor",
    "__proto__",
    "",
  ])
    assert.equal(publicDispatchErrorCode(code), code);
});

test("publicDispatchParameter maps field and index slots, never user path text", () => {
  // Bare and dispatch-qualified field slots, each with or without a numeric index.
  assert.equal(publicDispatchParameter("inputs"), "required_paths");
  assert.equal(publicDispatchParameter("tree"), "build_dir");
  assert.equal(publicDispatchParameter("dispatch.inputs"), "dispatch.required_paths");
  assert.equal(publicDispatchParameter("dispatch.tree"), "dispatch.build_dir");
  assert.equal(publicDispatchParameter("inputs.0"), "required_paths.0");
  assert.equal(publicDispatchParameter("tree.12"), "build_dir.12");
  assert.equal(publicDispatchParameter("dispatch.inputs.0"), "dispatch.required_paths.0");
  assert.equal(publicDispatchParameter("dispatch.tree.3"), "dispatch.build_dir.3");
  // Unrelated fields and already-public slots pass through.
  for (const parameter of [
    "ownership",
    "checks",
    "ownership.0",
    "checks.3",
    "required_paths",
    "build_dir",
    "dispatch.required_paths",
    "dispatch.required_paths.3",
    "difficulty",
    "agent",
    "after",
    "",
  ])
    assert.equal(publicDispatchParameter(parameter), parameter);
  // Anchored recognition only: user path text, near-miss field words and
  // arbitrary or malformed suffixes are never rewritten.
  for (const parameter of [
    "/tree/path",
    "treehouse",
    "x.dispatch.inputs.0",
    "dispatch.inputs.0/x",
    "inputs.abc",
    "inputs.",
    "inputs..0",
    "inputs.-1",
    "inputs.0.1",
    ".inputs",
    "dispatch..inputs",
    "DISPATCH.INPUTS.0",
    "/user/path inputs",
    "inputs/../tree",
    "tree/0",
    "tree\n",
    "dispatch.inputs.0\n",
    "dispatch.tree\r\n",
  ])
    assert.equal(publicDispatchParameter(parameter), parameter);
});

// --- Deferred preflight failures through a real core Owner -----------------
// In-memory host seams only, mirroring the task-floor fixture: no OS lease,
// filesystem preflight, Git, flock, SDK or provider.

function dispatchPort(preflight) {
  const prepares = [];
  const path = (word, cwd) => {
    const absolute = resolve(cwd, word);
    return { path: absolute, canonical: absolute };
  };
  return {
    prepares,
    prepare(declaration, context) {
      prepares.push(structuredClone({ declaration, context }));
      preflight?.(declaration, context);
      return {
        declaration: structuredClone(declaration),
        inputs: (declaration.inputs ?? []).map((word) => path(word, context.cwd)),
        ownership: (declaration.ownership ?? []).map((word) => path(word, context.cwd)),
        ...(declaration.tree === undefined ? {} : { tree: path(declaration.tree, context.cwd) }),
      };
    },
    async start() {
      return {};
    },
  };
}

async function memoryFixture(t, dispatch) {
  let held = true;
  const owner = {
    owner_id: "dispatch-vocabulary-owner",
    generation: "dispatch-vocabulary-generation",
    assertHeld() {
      if (!held) throw new OrchestrationError("OWNER_LOCK_CLOSED");
    },
    close() {
      held = false;
    },
  };
  const ports = [];
  const controller = await OwnerController.open({
    owner,
    concurrency: 1,
    resident_limit: 8,
    queue_limit: 16,
    createSession: async () => {
      const port = new FakePort();
      ports.push(port);
      return port;
    },
    dispatch,
  });
  t.after(async () => {
    await tick();
    for (const port of ports) if (port.streaming) port.finish("test cleanup", "aborted");
    const report = await controller.shutdown(1000);
    assertOwnerInvariants(controller);
    assert.equal(report.closed, true, JSON.stringify(report));
  });
  return { controller, ports };
}

for (const [code, details, expectedError, expectedReason] of [
  [
    "DISPATCH_INPUT_MISSING",
    { key: "inputs", requested: "artifact", path: "artifact" },
    'DISPATCH_REQUIRED_PATH_MISSING: Declared required path is missing ("artifact"). Verify the path or its producing task.',
    "dependency_input_missing",
  ],
  [
    "DISPATCH_INPUT_TYPE",
    { key: "inputs", requested: "artifact", path: "artifact" },
    'DISPATCH_REQUIRED_PATH_TYPE: Declared required path must be a file or directory ("artifact").',
    "dispatch_preflight_failed",
  ],
  [
    "DISPATCH_INPUT_INSPECTION_FAILED",
    { key: "inputs", requested: "artifact", path: "artifact" },
    'DISPATCH_REQUIRED_PATH_INSPECTION_FAILED: Declared required path could not be inspected ("artifact").',
    "dispatch_preflight_failed",
  ],
  [
    "DISPATCH_TREE_TYPE",
    { key: "tree", requested: "build", path: "build" },
    'DISPATCH_BUILD_DIR_TYPE: Declared build_dir must be a directory ("build").',
    "dispatch_preflight_failed",
  ],
  [
    "DISPATCH_TREE_INSPECTION_FAILED",
    { key: "tree", requested: "build", path: "build" },
    'DISPATCH_BUILD_DIR_INSPECTION_FAILED: Declared build_dir could not be inspected ("build").',
    "dispatch_preflight_failed",
  ],
  [
    "PREFLIGHT_DENIED",
    {
      key: "inputs",
      requested: "artifact",
      path: "artifact",
      reason: "Permission policy denied path_read on this declared path.",
    },
    "PREFLIGHT_DENIED: Permission policy denied path_read on this declared path.; this is not a missing-file or model-execution failure. Report the restriction; do not bypass it.",
    "dispatch_preflight_failed",
  ],
]) {
  test(`deferred ${code} settles with public vocabulary only`, async (t) => {
    let fail = true;
    const dispatch = dispatchPort((_declaration, context) => {
      if (!context.deferInputs && fail) throw new OrchestrationError(code, details);
    });
    const { controller: c, ports } = await memoryFixture(t, dispatch);
    // A real after dependency defers the target's input classification past
    // admission: admission preflights with deferInputs true, and only the
    // pump's late recheck (deferInputs false) fails the queued target.
    const producer = await c.submit("producer", task("producer"));
    await until(() => ports[0]?.streaming);
    const run = await c.submit(
      "deferred",
      task("deferred", {
        after: [producer.run_id],
        dispatch: { inputs: ["artifact"], tree: "build" },
      }),
    );
    assert.equal(
      dispatch.prepares.at(-1).context.deferInputs,
      true,
      "admission preflight defers input classification for a queued dependency",
    );
    ports[0].finish();
    await ended(c, producer);
    await ended(c, run);
    const view = c.view(run.run_id);
    assert.equal(view.status, "failed");
    assert.equal(view.outcome.error, expectedError);
    assert.equal(view.outcome.reason, expectedReason, "internal outcome reasons stay unchanged");
    assert.deepEqual(
      view.dispatch,
      { inputs: ["artifact"], tree: "build" },
      "records stay internal",
    );
    assert.equal(ports.length, 1, "the target starts no session beyond the producer's");
    assert.equal(c.claims.size, 0, "the failed target's claim is released");
    assert.doesNotMatch(
      view.outcome.error,
      /DISPATCH_INPUT|DISPATCH_TREE|BUILD_TREE|\binputs\b|"tree"|Declared input|Declared tree/,
    );
    fail = false;
  });
}

test("a deferred raw host failure keeps its arbitrary text without substitution", async (t) => {
  let fail = true;
  const dispatch = dispatchPort((_declaration, context) => {
    if (!context.deferInputs && fail) throw new Error("host interface failure");
  });
  const { controller: c, ports } = await memoryFixture(t, dispatch);
  const producer = await c.submit("producer", task("producer"));
  await until(() => ports[0]?.streaming);
  const run = await c.submit(
    "raw",
    task("raw", {
      after: [producer.run_id],
      dispatch: { inputs: ["artifact"], tree: "build" },
    }),
  );
  ports[0].finish();
  await ended(c, producer);
  await ended(c, run);
  const view = c.view(run.run_id);
  assert.equal(view.status, "failed");
  assert.match(view.outcome.error, /host interface failure/);
  assert.equal(view.outcome.reason, "dispatch_preflight_failed");
  assert.equal(ports.length, 1, "the target starts no session beyond the producer's");
  assert.equal(c.claims.size, 0);
  fail = false;
});
