import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

const source = new URL("../../src/", import.meta.url);
const files = (directory, suffix) => readdirSync(directory).filter((file) => file.endsWith(suffix));
const dependencies = (text) => {
  const parsed = ts.createSourceFile("boundary.ts", text, ts.ScriptTarget.Latest, true);
  assert.equal(parsed.parseDiagnostics.length, 0, "boundary inputs must parse");
  return parsed.statements.filter((node) => ts.isImportDeclaration(node) || ts.isExportDeclaration(node))
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
        typeOnly: !!clause?.isTypeOnly || (!defaultImport && elements.length > 0 && elements.every((binding) => binding.isTypeOnly)),
        // Namespace/default imports and star/namespace exports hide which SDK
        // members are being made available. Require explicit named SDK edges.
        broad: !!defaultImport || !named,
        names: elements.map((binding) => (binding.propertyName ?? binding.name).text),
      };
    });
};
const imports = (file) => dependencies(readFileSync(file, "utf8"));
const sessionOwners = new Set(["AgentSession", "SessionManager", "createAgentSession", "DefaultResourceLoader", "default"]);
const assertUiDependencies = (edges, name) => {
  for (const edge of edges) {
    if (edge.specifier.startsWith("../runtime/")) {
      assert(edge.typeOnly, `${name}: runtime observations must be a type-only dependency`);
    }
    if (edge.specifier === "@earendil-works/pi-coding-agent") {
      assert(!edge.broad, `${name}: SDK dependencies must name their members explicitly`);
      for (const imported of edge.names) assert(!sessionOwners.has(imported), `${name} must not own ${imported}`);
    }
  }
};

test("core stays independent of SDK, adapters and UI", () => {
  const core = new URL("core/", source);
  const names = files(core, ".ts");
  assert(names.includes("owner-controller.ts"));
  for (const name of names) {
    for (const { specifier } of imports(new URL(name, core))) {
      assert(specifier.startsWith("./") || ["node:crypto", "node:path"].includes(specifier),
        `${name} must use core ports rather than import ${specifier}`);
    }
  }
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
]) test(`UI boundary rejects hidden or live ownership: ${declaration}`, () => {
  assert.throws(() => assertUiDependencies(dependencies(declaration), "fixture"), assert.AssertionError);
});
for (const declaration of [
  `import { getMarkdownTheme, type Theme } from ${sdk};`,
  `export { type Theme } from ${sdk};`,
  `import type { ActivityObservationSource } from ${runtime};`,
  `import { type ActivityObservationSource } from ${runtime};`,
  `export type { ActivityObservationSource } from ${runtime};`,
  `export { type ActivityObservationSource } from ${runtime};`,
]) test(`UI boundary permits explicit presentation/type dependencies: ${declaration}`, () => {
  assertUiDependencies(dependencies(declaration), "fixture");
});

test("neutral helpers and the ordinary footer have no harness dependency", () => {
  const shared = new URL("../../../lib/", import.meta.url);
  for (const name of files(shared, ".mjs")) {
    assert.deepEqual(imports(new URL(name, shared)), [], `${name} must remain a dependency-free leaf`);
  }
  const footer = new URL("../../../extensions/status-footer.ts", import.meta.url);
  const edges = imports(footer).map(({ specifier }) => specifier);
  assert(edges.includes("../lib/usage-attribution.mjs"));
  assert(edges.includes("../lib/overlay-protocol.mjs"));
  assert(!edges.some((specifier) => specifier.includes("harness")));
});
