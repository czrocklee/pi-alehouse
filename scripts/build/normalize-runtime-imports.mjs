import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, extname, join, resolve, sep } from "node:path";
import ts from "typescript";

const isFile = (path) => {
  try {
    return statSync(path).isFile();
  } catch (error) {
    if (error.code === "ENOENT" || error.code === "ENOTDIR") return false;
    throw error;
  }
};
const within = (root, path) => path === root || path.startsWith(root + sep);

/** Build-only rewrite of literal module specifiers, including type imports.
 * Never rewrite comments, arbitrary strings, assets, or package specifiers.
 * Keep the vendor's #src package boundary; only make its targets explicit. */
export function normalizeRuntimeImports(source, file, vendor) {
  const root = resolve(vendor),
    filename = resolve(file);
  assert(within(root, filename), "Runtime import normalization escaped its package");
  const parsed = ts.createSourceFile(filename, source, ts.ScriptTarget.Latest, true);
  assert.equal(parsed.parseDiagnostics.length, 0, `Invalid runtime source: ${file}`);
  const changes = new Map();
  const inspect = (literal) => {
    if (!literal || !ts.isStringLiteral(literal)) return;
    const specifier = literal.text;
    const target = specifier.startsWith("#src/")
      ? resolve(root, "src", specifier.slice(5))
      : specifier.startsWith("./") || specifier.startsWith("../")
        ? resolve(dirname(filename), specifier)
        : undefined;
    if (!target) return;
    assert(within(root, target), `Runtime import escaped its package: ${file}: ${specifier}`);
    if (isFile(target)) return;
    let next;
    if (specifier.endsWith(".js") && isFile(target.slice(0, -3) + ".ts"))
      next = specifier.slice(0, -3) + ".ts";
    else if (isFile(target + ".ts")) next = specifier + ".ts";
    else if (isFile(join(target, "index.ts"))) next = specifier.replace(/\/$/, "") + "/index.ts";
    else {
      assert(extname(specifier), `Unresolved runtime import: ${file}: ${specifier}`);
      return; // Explicit non-code assets retain their own resolution semantics.
    }
    changes.set(literal.getStart(parsed), { end: literal.end, text: JSON.stringify(next) });
  };
  const visit = (node) => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) inspect(node.moduleSpecifier);
    else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument))
      inspect(node.argument.literal);
    else if (
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) && node.expression.text === "require"))
    )
      inspect(node.arguments[0]);
    else if (ts.isExternalModuleReference(node)) inspect(node.expression);
    ts.forEachChild(node, visit);
  };
  visit(parsed);
  let result = source;
  for (const [start, { end, text }] of [...changes].sort(([a], [b]) => b - a))
    result = result.slice(0, start) + text + result.slice(end);
  return result;
}

export function normalizeVendorImports(vendor) {
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile() && entry.name.endsWith(".ts")) {
        const source = readFileSync(path, "utf8"),
          normalized = normalizeRuntimeImports(source, path, vendor);
        if (source !== normalized) writeFileSync(path, normalized);
      }
    }
  };
  visit(join(vendor, "src"));
}

/** No PATH-selected npm probe or new infrastructure read exemptions. An
 * installed package retains its existing node_modules ancestor; checkout
 * startup retains the separately supplied host getPackageDir() in the caller. */
export function removeGlobalNpmProbe(source, file) {
  const parsed = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  assert.equal(parsed.parseDiagnostics.length, 0, `Invalid discovery source: ${file}`);
  const functions = new Map(
    parsed.statements.filter(ts.isFunctionDeclaration).map((node) => [node.name?.text, node]),
  );
  assert.deepEqual([...functions.keys()].sort(), [
    "discoverGlobalNodeModulesRoot",
    "discoverGlobalNodeModulesViaSubprocess",
    "walkUpToNodeModules",
  ]);
  const replacements = parsed.statements.flatMap((node) => {
    if (
      ts.isImportDeclaration(node) &&
      ["node:child_process", "node:fs"].includes(node.moduleSpecifier.text)
    ) {
      return [{ start: node.getFullStart(), end: node.end, text: "" }];
    }
    if (
      ts.isFunctionDeclaration(node) &&
      node.name?.text === "discoverGlobalNodeModulesViaSubprocess"
    ) {
      return [{ start: node.getFullStart(), end: node.end, text: "" }];
    }
    if (ts.isFunctionDeclaration(node) && node.name?.text === "discoverGlobalNodeModulesRoot") {
      return [
        {
          start: node.getFullStart(),
          end: node.end,
          text: `\n\n// Installed packages retain the same node_modules ancestor. Development\n// checkouts use the caller's explicit host package directory, never PATH/npm.\nexport function discoverGlobalNodeModulesRoot(fromUrl = import.meta.url): string | null {\n  return walkUpToNodeModules(fromUrl);\n}`,
        },
      ];
    }
    return [];
  });
  let result = source;
  for (const { start, end, text } of replacements.sort((a, b) => b.start - a.start))
    result = result.slice(0, start) + text + result.slice(end);
  assert(
    !/spawnSync|discoverGlobalNodeModulesViaSubprocess|node:child_process/.test(result),
    "Unsupported npm discovery layout",
  );
  return result;
}
