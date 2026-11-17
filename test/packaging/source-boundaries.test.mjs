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

const source = new URL("../../src/orchestration/", import.meta.url);
const shared = new URL("../../src/shared/", import.meta.url);
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
const dependencies = (text, name = "boundary.ts") => {
  const parsed = ts.createSourceFile(name, text, ts.ScriptTarget.Latest, true);
  assert.equal(parsed.parseDiagnostics.length, 0, "boundary inputs must parse");
  const edges = [];
  const visit = (node) => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteralLike(node.moduleSpecifier)
    ) {
      const importing = ts.isImportDeclaration(node);
      const clause = importing ? node.importClause : node;
      const bindings = importing ? clause?.namedBindings : node.exportClause;
      const named = bindings && (ts.isNamedImports(bindings) || ts.isNamedExports(bindings));
      const elements = named ? [...bindings.elements] : [];
      const defaultImport = importing && !!clause?.name;
      edges.push({
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
      });
    } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      // Inventory literal edges, not computed paths (e.g. the native import adapter).
      const argument = node.arguments[0];
      if (argument && ts.isStringLiteralLike(argument))
        edges.push({ specifier: argument.text, typeOnly: false, broad: true, names: [] });
    } else if (
      ts.isImportTypeNode(node) &&
      ts.isLiteralTypeNode(node.argument) &&
      ts.isStringLiteralLike(node.argument.literal)
    ) {
      let member = node.qualifier;
      while (member && ts.isQualifiedName(member)) member = member.left;
      edges.push({
        specifier: node.argument.literal.text,
        typeOnly: true,
        broad: !member,
        names: member ? [member.text] : [],
      });
    }
    ts.forEachChild(node, visit);
    for (const doc of node.jsDoc ?? []) visit(doc);
  };
  visit(parsed);
  return edges;
};
const imports = (file) => dependencies(readFileSync(file, "utf8"), file.pathname);
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
const assertRuntimeDependencies = (edges, name) => {
  for (const { specifier } of edges)
    assert(
      !localTarget("runtime", name, specifier)?.startsWith("ui/"),
      `${name}: runtime must not import UI modules; shared contracts belong in routing or presentation`,
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
    assertRuntimeDependencies(imports(new URL(name, runtime)), name);
});

test("shared orchestration presentation leaves cannot acquire lifecycle or UI ownership", () => {
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
  `const load = () => import(${runtime});`,
  `const load = () => import(${sdk});`,
  `type Session = import(${sdk}).AgentSession;`,
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
  `type Observation = import(${runtime}).ActivityObservationSource;`,
  `type UiTheme = import(${sdk}).Theme;`,
])
  test(`UI boundary permits explicit presentation/type dependencies: ${declaration}`, () => {
    assertUiDependencies(dependencies(declaration), "fixture");
  });

test("dependency inventory does not resolve computed imports", () => {
  assert.deepEqual(dependencies("const load = (path: string) => import(path);"), []);
});

test("lazy and inline type imports obey the runtime-to-UI boundary", () => {
  for (const syntax of [
    (path) => `const load = () => import(\`${path}\`);`,
    (path) => `type Observations = typeof import("${path}");`,
  ]) {
    assert.throws(
      () => assertRuntimeDependencies(dependencies(syntax("../../ui/popover.ts")), "nested/a.ts"),
      assert.AssertionError,
    );
    assertRuntimeDependencies(dependencies(syntax("../activity-observer.ts")), "nested/a.ts");
  }
});

const relative = (specifier) => specifier.startsWith("./") || specifier.startsWith("../");
const assertSharedDependencies = (edges, name, checkedPaths) => {
  for (const { specifier, broad } of edges) {
    // Only the preference store may use these native Node dependencies.
    if (
      name === "settings-store.mjs" &&
      ["node:crypto", "node:fs", "node:path", "node:util"].includes(specifier) &&
      !broad
    )
      continue;
    assert(
      relative(specifier) && checkedPaths.has(new URL(specifier, new URL(name, shared)).pathname),
      `${name}: shared helpers must compose only with checked shared sources, not ${specifier}`,
    );
  }
};

test("the shared boundary allows local composition, not SDK or orchestration edges", () => {
  const checkedPaths = new Set([new URL("helper.mjs", shared).pathname]);
  const check = (text, name = "nested/a.mjs") =>
    assertSharedDependencies(dependencies(text, name), name, checkedPaths);
  check('import * as helper from "../helper.mjs"; export { helper };');
  check('const load = () => import("../helper.mjs");');
  check('/** @typedef {import("../helper.mjs").Example} Example */\nexport {};');
  check('import { statSync } from "node:fs";', "settings-store.mjs");
  check('import { types } from "node:util";', "settings-store.mjs");
  for (const text of [
    'import "../../orchestration/runtime/activity-observer.ts";',
    'const load = () => import("@earendil-works/pi-tui");',
    '/** @typedef {import("@earendil-works/pi-tui").Component} Component */\nexport {};',
    'import { statSync } from "node:fs";',
    'import { types } from "node:util";',
    'import "../unchecked.mjs";',
  ])
    assert.throws(() => check(text), assert.AssertionError);
  assert.throws(
    () => check('import "node:child_process";', "settings-store.mjs"),
    assert.AssertionError,
  );
});

test("shared runtime helpers and declarations remain SDK-free", () => {
  const names = [...files(shared, ".mjs"), ...files(shared, ".d.mts")];
  const checkedPaths = new Set(names.map((name) => new URL(name, shared).pathname));
  for (const name of names)
    assertSharedDependencies(imports(new URL(name, shared)), name, checkedPaths);
});

test("the ordinary footer has no transitive orchestration dependency", () => {
  const visited = new Set();
  const visit = (file) => {
    if (visited.has(file.href)) return;
    assert(
      !file.pathname.includes("/orchestration/"),
      `footer must not depend on ${file.pathname}`,
    );
    visited.add(file.href);
    for (const { specifier } of imports(file)) {
      assert(!specifier.includes("orchestration"), `footer must not depend on ${specifier}`);
      if (relative(specifier)) visit(new URL(specifier, file));
    }
  };
  visit(new URL("../../src/extensions/status-footer.ts", import.meta.url));
  for (const name of ["usage-attribution.mjs", "overlay-protocol.mjs"])
    assert(visited.has(new URL(name, shared).href), `footer must use shared ${name}`);
});
