import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, posix } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import ts from "typescript";

const source = new URL("../../src/", import.meta.url);
const files = (directory, suffix) =>
  readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    if (entry.isDirectory())
      return files(new URL(`${entry.name}/`, directory), suffix).map(
        (name) => `${entry.name}/${name}`,
      );
    return entry.isFile() && entry.name.endsWith(suffix) ? [entry.name] : [];
  });
const localTarget = (area, name, specifier) =>
  specifier.startsWith(".")
    ? posix.normalize(posix.join(area, posix.dirname(name), specifier))
    : undefined;
const dependencies = (text) => {
  const parsed = ts.createSourceFile("boundary.ts", text, ts.ScriptTarget.Latest, true);
  assert.equal(parsed.parseDiagnostics.length, 0, "boundary inputs must parse");
  return parsed.statements
    .filter((node) => ts.isImportDeclaration(node) || ts.isExportDeclaration(node))
    .filter((node) => node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier))
    .map((node) => {
      const importing = ts.isImportDeclaration(node);
      const clause = importing ? node.importClause : node;
      const bindings = importing ? clause?.namedBindings : node.exportClause;
      const named = bindings && (ts.isNamedImports(bindings) || ts.isNamedExports(bindings));
      const elements = named ? [...bindings.elements] : [];
      const defaultImport = importing && !!clause?.name;
      return {
        specifier: node.moduleSpecifier.text,
        typeOnly:
          !!clause?.isTypeOnly ||
          (!defaultImport &&
            elements.length > 0 &&
            elements.every((binding) => binding.isTypeOnly)),
        // Namespace/default imports and star/namespace exports hide which SDK
        // members are being made available. Require explicit named SDK edges.
        broad: !!defaultImport || !named,
        names: elements.map((binding) => (binding.propertyName ?? binding.name).text),
      };
    });
};
const imports = (file) => dependencies(readFileSync(file, "utf8"));
const sessionOwners = new Set([
  "AgentSession",
  "SessionManager",
  "createAgentSession",
  "DefaultResourceLoader",
  "default",
]);
const assertUiDependencies = (edges, name) => {
  for (const edge of edges) {
    if (localTarget("ui", name, edge.specifier)?.startsWith("runtime/")) {
      assert(edge.typeOnly, `${name}: runtime observations must be a type-only dependency`);
    }
    if (edge.specifier === "@earendil-works/pi-coding-agent") {
      assert(!edge.broad, `${name}: SDK dependencies must name their members explicitly`);
      for (const imported of edge.names)
        assert(!sessionOwners.has(imported), `${name} must not own ${imported}`);
    }
  }
};

const assertCoreDependencies = (edges, name) => {
  for (const { specifier } of edges)
    assert(
      localTarget("core", name, specifier)?.startsWith("core/") ||
        ["node:crypto", "node:path"].includes(specifier),
      `${name} must use core ports rather than import ${specifier}`,
    );
};
const assertPresentationDependencies = (edges, name) => {
  for (const edge of edges) {
    if (localTarget("presentation", name, edge.specifier)?.startsWith("presentation/")) continue;
    assert.equal(edge.specifier, "@earendil-works/pi-tui", `${name}: unexpected dependency`);
    assert(!edge.broad, `${name}: presentation must name its TUI dependency`);
    assert.deepEqual(edge.names, ["stripTerminalSequences"]);
  }
};

test("source discovery includes nested files without following directory symlinks", () => {
  const directory = mkdtempSync(join(tmpdir(), "alehouse-boundaries-"));
  try {
    mkdirSync(join(directory, "nested"));
    symlinkSync("nested", join(directory, "linked"), "dir");
    writeFileSync(join(directory, "nested", "leaf.ts"), "export {};\n");
    writeFileSync(join(directory, "ignored.mjs"), "export {};\n");
    assert.deepEqual(files(pathToFileURL(`${directory}/`), ".ts"), ["nested/leaf.ts"]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("nested source paths cannot hide cross-layer dependencies", () => {
  assert.throws(() =>
    assertCoreDependencies(dependencies('import "../../runtime/agent-session.ts";'), "nested/a.ts"),
  );
  assert.throws(() =>
    assertUiDependencies(dependencies('import "../../runtime/agent-session.ts";'), "nested/a.ts"),
  );
  assert.throws(() =>
    assertPresentationDependencies(dependencies('import "../ui/text.ts";'), "a.ts"),
  );
});

test("core stays independent of SDK, adapters and UI", () => {
  const core = new URL("core/", source);
  const names = files(core, ".ts");
  assert(names.includes("owner-controller.ts"));
  for (const name of names) assertCoreDependencies(imports(new URL(name, core)), name);
});

test("runtime does not depend on UI modules, even for types", () => {
  const runtime = new URL("runtime/", source);
  for (const name of files(runtime, ".ts"))
    for (const edge of imports(new URL(name, runtime)))
      assert(
        !localTarget("runtime", name, edge.specifier)?.startsWith("ui/"),
        `${name}: runtime must not import UI modules; shared contracts belong in routing or presentation`,
      );
});

test("shared harness presentation leaves cannot acquire lifecycle or UI ownership", () => {
  const presentation = new URL("presentation/", source);
  for (const name of files(presentation, ".ts"))
    assertPresentationDependencies(imports(new URL(name, presentation)), name);
});

test("UI reads runtime observations without constructing SDK sessions or runtime owners", () => {
  const ui = new URL("ui/", source);
  for (const name of files(ui, ".ts")) assertUiDependencies(imports(new URL(name, ui)), name);
});

const sdk = '"@earendil-works/pi-coding-agent"';
const runtime = '"../runtime/activity-observer.js"';
for (const declaration of [
  `import * as SDK from ${sdk};`,
  `import type * as SDK from ${sdk};`,
  `import SDK from ${sdk};`,
  `export * from ${sdk};`,
  `export * as SDK from ${sdk};`,
  `export { createAgentSession as make } from ${sdk};`,
  `import { SessionManager as Manager } from ${sdk};`,
  `import { type AgentSession } from ${sdk};`,
  `import { type ActivityObservationSource, ChildActivity } from ${runtime};`,
  `export * from ${runtime};`,
])
  test(`UI boundary rejects hidden or live ownership: ${declaration}`, () => {
    assert.throws(
      () => assertUiDependencies(dependencies(declaration), "fixture"),
      assert.AssertionError,
    );
  });
for (const declaration of [
  `import { getMarkdownTheme, type Theme } from ${sdk};`,
  `export { type Theme } from ${sdk};`,
  `import type { ActivityObservationSource } from ${runtime};`,
  `import { type ActivityObservationSource } from ${runtime};`,
  `export type { ActivityObservationSource } from ${runtime};`,
  `export { type ActivityObservationSource } from ${runtime};`,
])
  test(`UI boundary permits explicit presentation/type dependencies: ${declaration}`, () => {
    assertUiDependencies(dependencies(declaration), "fixture");
  });

test("neutral helpers and the ordinary footer have no harness dependency", () => {
  const shared = new URL("../../../lib/", import.meta.url);
  for (const name of files(shared, ".mjs")) {
    const edges = imports(new URL(name, shared));
    if (name === "settings-store.mjs") {
      // Shared persistent preferences are an SDK-free Node adapter, not a
      // harness dependency. Keep this exception restricted to its native IO.
      assert.deepEqual(edges.map(({ specifier }) => specifier).sort(), [
        "node:crypto",
        "node:fs",
        "node:path",
      ]);
      assert(
        edges.every(({ broad }) => !broad),
        "storage must name its native dependencies",
      );
    } else assert.deepEqual(edges, [], `${name} must remain a dependency-free leaf`);
  }
  const visited = new Set();
  const visit = (file) => {
    if (visited.has(file.href)) return;
    assert(!file.pathname.includes("/harness/"), `footer must not depend on ${file.pathname}`);
    visited.add(file.href);
    for (const { specifier } of imports(file)) {
      assert(!specifier.includes("harness"), `footer must not depend on ${specifier}`);
      if (specifier.startsWith(".")) visit(new URL(specifier, file));
    }
  };
  visit(new URL("../../../extensions/status-footer.ts", import.meta.url));
  for (const name of ["usage-attribution.mjs", "overlay-protocol.mjs"])
    assert(visited.has(new URL(name, shared).href), `footer must use shared ${name}`);
});
