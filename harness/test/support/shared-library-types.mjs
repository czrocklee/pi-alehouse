import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

export const sharedLibraryDirectory = fileURLToPath(new URL("../../../lib/", import.meta.url));

export function readLibraryPairs(directory = sharedLibraryDirectory) {
  const names = readdirSync(directory);
  const implementations = names.filter((name) => name.endsWith(".mjs")).map((name) => name.slice(0, -4)).sort();
  const declarations = names.filter((name) => name.endsWith(".d.mts")).map((name) => name.slice(0, -6)).sort();
  assert(implementations.length > 0, "No shared JavaScript implementations found");
  assert.deepEqual(declarations, implementations, "Every shared implementation needs exactly one paired declaration");
  return implementations.map((name) => ({ name,
    implementation: readFileSync(join(directory, `${name}.mjs`), "utf8"),
    declaration: readFileSync(join(directory, `${name}.d.mts`), "utf8") }));
}

// Normalize the current leaf API's functions, objects and arrays so equivalent
// named interfaces/intersections compare structurally. Preserve optionality,
// readonly, literals and any-vs-unknown; bidirectional assignment alone misses
// drift such as an extra optional property or an any return type.
const assertions = `
type Shape<T> = 0 extends (1 & T) ? T :
  T extends (...args: infer A) => infer R ? (...args: { [K in keyof A]: Shape<A[K]> }) => Shape<R> :
  T extends object ? { [K in keyof T]: Shape<T[K]> } : T;
type Equal<A, B> =
  (<T>() => T extends Shape<A> ? 1 : 2) extends (<T>() => T extends Shape<B> ? 1 : 2)
    ? (<T>() => T extends Shape<B> ? 1 : 2) extends (<T>() => T extends Shape<A> ? 1 : 2) ? true : false
    : false;
type Assert<T extends true> = T;
`;

export function checkLibraryPairs(pairs) {
  assert(pairs.length > 0, "No shared library pairs to check");
  const scratch = mkdtempSync(join(tmpdir(), "pi-shared-types-"));
  try {
    const implementation = join(scratch, "implementation"), declaration = join(scratch, "declaration");
    mkdirSync(implementation); mkdirSync(declaration);
    const roots = [], checks = [assertions];
    for (const [index, pair] of pairs.entries()) {
      assert(/^[\w-]+$/.test(pair.name), "Expected a simple shared module name");
      const file = join(implementation, `${pair.name}.mjs`);
      // Never put a .d.mts beside the implementation: NodeNext would silently
      // prefer it and turn an implementation check into declaration self-check.
      writeFileSync(file, pair.implementation); roots.push(file);
      writeFileSync(join(declaration, `${pair.name}.d.mts`), pair.declaration);
      checks.push(`type Check${index} = Assert<Equal<typeof import("./implementation/${pair.name}.mjs"), typeof import("./declaration/${pair.name}.mjs")>>;`);
    }
    const check = join(scratch, "contracts.mts");
    writeFileSync(check, checks.join("\n")); roots.push(check);
    const program = ts.createProgram(roots, {
      target: ts.ScriptTarget.ES2023, lib: ["lib.es2023.d.ts"], types: [],
      module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext,
      allowJs: true, checkJs: true, strict: true, noUncheckedIndexedAccess: true,
      noEmit: true, skipLibCheck: false,
    });
    return ts.getPreEmitDiagnostics(program).map((diagnostic) => {
      const message = ts.formatDiagnostic(diagnostic, {
        getCurrentDirectory: () => scratch, getCanonicalFileName: (file) => file, getNewLine: () => "\n",
      });
      if (diagnostic.file?.fileName !== check || diagnostic.start === undefined) return message;
      const { line } = diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start);
      // Keep the module name visible after the temporary tree is removed.
      return `${message}  ${diagnostic.file.text.split("\n")[line]}\n`;
    });
  } finally { rmSync(scratch, { recursive: true, force: true }); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const pairs = readLibraryPairs(process.argv[2] ?? sharedLibraryDirectory);
  const failures = checkLibraryPairs(pairs);
  if (failures.length) {
    console.error(`FAIL: shared JavaScript implementation/declaration contract\n${failures.join("")}`);
    process.exitCode = 1;
  } else console.log(`PASS: ${pairs.length} shared JS implementations checked independently against paired declarations`);
}
