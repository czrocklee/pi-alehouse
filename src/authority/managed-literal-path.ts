// A decoded shell filename is already filesystem data, not tool-input spelling.
// Never trim it, strip @/quotes, or expand ~/$HOME a second time. Only path
// resolution, flavor equivalence and best-effort symlink resolution apply.
import { canonicalizePath } from "#src/path/canonicalize-path.ts";
import type { PathFlavor } from "#src/path/path-flavor.ts";

export function filesystemLiteralForms(
  literal: string,
  { cwd, resolveBase = cwd, flavor }: { cwd: string; resolveBase?: string; flavor: PathFlavor },
): { lexical: string; aliases: string[]; canonical: string } {
  if (!literal) return { lexical: "", aliases: [], canonical: "" };
  const lexical = flavor.comparable(literal, resolveBase);
  const normalizedCwd = flavor.comparable(cwd, cwd);
  const relative = flavor.isWithin(lexical, normalizedCwd)
    ? flavor.impl.relative(normalizedCwd, lexical)
    : "";
  return {
    lexical,
    aliases: [...new Set([lexical, ...(relative ? [relative] : []), literal])],
    canonical: flavor.fold(canonicalizePath(lexical, flavor)),
  };
}
