// Local, version-pinned extension of the existing pipeline, not an authorizer.
// The upstream reader core is unchanged; exact env Git proofs use a separate,
// complete-program wrapper exception, never a general indirection exemption.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, posix, relative, resolve, sep } from "node:path";
import type { PathNormalizer } from "#src/path/path-normalizer";
import type { TokenEffect } from "#src/access-intent/effect";
import type { BashPathRuleCandidate, BashExternalPath } from "./bash-path-resolver";
import { getParser, parseUnresolvedWithin, type TSNode } from "./parser";
import { proveCommandEffect } from "./command-effects";
import { gitStatusFlags, gitHistoryOptionLength, gitLogRevision, gitDiffRevision, gitPathWord } from "./git-read-grammar";

const READ: TokenEffect = { effect: "read", source: "managed-literal" };

// Smaller than shell syntax: whole-word quotes, no expansion, concatenation,
// globbing, assignments-as-prefixes, comments, or redirects.
export function literalWords(source: string): string[] | undefined {
  const words: string[] = [];
  let rest = source.trim();
  while (rest) {
    const match = /^(?:'([^'\n]*)'|"([^"$`\\\n]*)"|([A-Za-z0-9_./:%=+@^,~-]+))(?=\s|$)/.exec(rest);
    if (!match || match[3]?.startsWith("~")) return;
    words.push(match[1] ?? match[2] ?? match[3]);
    rest = rest.slice(match[0].length).trimStart();
  }
  return words.length ? words : undefined;
}

// Git alone accepts literal concatenation. Keep the older decoder for every
// other managed reader and scratch-file effect: this is not a shell expansion
// engine or a widening of their argument language.
export function gitLiteralWords(source: string): string[] | undefined {
  const words: string[] = [];
  let i = 0;
  while (i < source.length) {
    while (/[ \t]/.test(source[i] ?? "") && i < source.length) i++;
    if (i === source.length) break;
    let word = "", started = false;
    while (i < source.length && !/[ \t]/.test(source[i])) {
      const char = source[i++];
      if (char === "'" || char === '"') {
        started = true;
        const end = source.indexOf(char, i);
        if (end < 0) return;
        const fragment = source.slice(i, end);
        if (/[\x00-\x1f\x7f]/.test(fragment) || (char === '"' && /[$`\\]/.test(fragment))) return;
        word += fragment; i = end + 1;
      } else if (char === "\\" && source[i] === "'") {
        // Exactly the escaped apostrophe emitted by shellWord. No arbitrary
        // escapes, line continuations or expansion-capable double quotes.
        word += "'"; started = true; i++;
      } else {
        if (!/[A-Za-z0-9_./:%=+@^,~-]/.test(char) ||
            // Bash also expands unquoted ~ after ':' in assignment-like
            // operands (A=b:~). Do not rely on Git grammar rejecting them.
            (char === "~" && (!started || /^[A-Za-z_][A-Za-z0-9_]*=(?:.*:)?$/.test(word)))) return;
        word += char; started = true;
      }
    }
    if (!started) return;
    words.push(word);
  }
  if (words[0] === "git") return words;
  // An operand/assignment-taking wrapper is NOT transparent. Only this exact
  // wrapper spelling has a separately proven managed lane and inner policy.
  if (/^env[ \t]+git(?:[ \t]|$)/.test(source) && words[0] === "env" && words[1] === "git") return words;
}

export function managedGitInnerCommand(source: string): string | undefined {
  const words = gitLiteralWords(source);
  if (words?.[0] === "env") return source.replace(/^env[ \t]+/, "");
}

function printingSed(words: string[]): boolean {
  // Only literal numeric print clauses; preserve their order and overlap (sed
  // may print a line more than once). Never rewrite into a wider single range.
  const clauses = (words[2] ?? "").split(";");
  return words[0] === "sed" && words[1] === "-n" && clauses.length <= 32 &&
    clauses.every(clause => /^[1-9]\d*(?:,(?:[1-9]\d*|\$))?p$/.test(clause)) &&
    words.slice(3).every(word => word === "-" || !word.startsWith("-"));
}

function resourceMetadata(words: string[]): boolean {
  const [head, ...args] = words;
  if (head === "free") return args.every(arg => ["-h", "-m", "-g", "-b", "-k", "--si", "--total", "--wide"].includes(arg));
  if (head === "df") return args.every(arg => !arg.startsWith("-") || ["-h", "-H", "-T", "-i", "-P", "--total", "--"].includes(arg));
  return false;
}

const exposedEnvironment = new Set(["PI_MODEL", "PI_MODEL_ID", "PI_PROVIDER", "BUILD_DIR", "AOBUS_BUILD_ROOT", "AOBUS_STATE_ROOT"]);
const commandProbes = new Set(["pi", "alejandra", "mypy"]);
const ordinaryFileWord = (word: string) => word !== "." && pathWord(word);

type ManagedInspection = { files: string[] };
// Exact hardened execution spellings, not patterns over arbitrary tool families.
function managedInspection(words: string[]): ManagedInspection | undefined {
  if (words.length === 4 && words[0] === "type" && words[1] === "-P" && words[2] === "--" && commandProbes.has(words[3])) return { files: [] };
  if (words.length > 2 && words[0] === "printenv" && words[1] === "--" && words.slice(2).every(word => exposedEnvironment.has(word))) return { files: [] };
  if (words.length === 7 && words.slice(0, 6).join(" ") === "bash --noprofile --norc -p -n --" && ordinaryFileWord(words[6])) return { files: [words[6]] };
}

// Effect attribution is NOT a Bash allowance or a general wrapper-floor
// exemption. Only the exact hardened spellings above enter the new lane.
export function managedReaderEffect(source: string): TokenEffect | undefined {
  const words = literalWords(source);
  if (!words) return;
  const [head, ...args] = words;
  if (managedInspection(words) || ["cut", "nl", "readlink", "tr"].includes(head) || printingSed(words) || resourceMetadata(words)) return READ;
  if (head === "uniq" && (args.length === 0 || args.join(" ") === "-c")) return READ;
  if (head === "sha256sum") {
    let operands = false;
    for (const arg of args) {
      if (arg === "--") { operands = true; continue; }
      if (operands || !arg.startsWith("-") || arg === "-") continue;
      if (!/^-([btz]+)$/.test(arg) && !["--binary", "--text", "--tag", "--zero", "--help", "--version"].includes(arg)) return;
    }
    return READ;
  }
  if (head === "printf") {
    const format = args[0] === "--" ? args[1] : args[0];
    if (format !== undefined && !format.startsWith("-") && !format.replace(/%(s|%)/g, "").includes("%")) return READ;
  }
}

export type ManagedGitDiagnostic = { code: string; reason: string; token?: string };
type GitProof = { kind: "metadata" | "diff" | "blob"; sub: string; paths: string[]; directory?: string; revisions?: string[]; cached?: boolean; noRenames?: boolean; ignoreSubmodulesAll?: boolean; blobRevision?: string };
const revisionWord = gitDiffRevision;
const gitGlobals = new Set(["--no-lazy-fetch", "--no-optional-locks", "--no-pager", "-P", "--no-replace-objects"]);
const directoryWord = (word: string) => word === word.trim() && /^\/?[A-Za-z0-9_.-][A-Za-z0-9_./ -]*$/.test(word) && !word.startsWith("-");
function gitInvocation(words: string[]) {
  const wrapped = words[0] === "env" && words[1] === "git";
  if (words[wrapped ? 1 : 0] !== "git") return;
  let i = wrapped ? 2 : 1, directory: string | undefined;
  const globals: string[] = [];
  while (i < words.length && words[i].startsWith("-")) {
    if (gitGlobals.has(words[i])) globals.push(words[i++]);
    else if (words[i] === "-C" && directory === undefined && words[i + 1] && directoryWord(words[i + 1])) {
      directory = words[i + 1]; i += 2;
    } else return;
  }
  return { sub: words[i], args: words.slice(i + 1), globals, directory, wrapped };
}
const diffFlags = new Set(["--no-ext-diff", "--no-textconv", "--no-renames", "--ignore-submodules=all", "--submodule=short", "--stat", "--check", "--name-only", "--name-status", "--cached", "--staged", "--patch", "-p", "--no-color", "--color=never", "--numstat", "--shortstat", "--summary", "--exit-code", "--quiet"]);
// Both spellings select content, even when combined with a summary option.
const unifiedContextFlag = (flag: string) => /^(?:-U|--unified=)\d{1,4}$/.test(flag);
const pathWord = gitPathWord;
const objectId = (word: string) => /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(word);
function blobOperand(word: string): { revision: string; path: string } | undefined {
  const colon = word.indexOf(":");
  if (colon < 1) return;
  const revision = word.slice(0, colon), path = word.slice(colon + 1);
  if (!/^[A-Za-z0-9_@][A-Za-z0-9_./~^@{}+-]*$/.test(revision) || revision.includes("..") ||
      !pathWord(path) || path.startsWith("./") || path !== posix.normalize(path)) return;
  return { revision, path };
}
const explicitPretty = (args: string[]) => args.some(arg => arg === "--oneline" || arg === "--format" || arg === "--pretty" || arg.startsWith("--format=") || arg.startsWith("--pretty="));

function inspectGit(source: string, reject?: (diagnostic: ManagedGitDiagnostic) => void): GitProof | undefined {
  const fail = (code: string, reason: string, token?: string) => { reject?.({ code, reason, ...(token === undefined ? {} : { token }) }); return undefined; };
  const words = gitLiteralWords(source);
  const invocation = words && gitInvocation(words);
  if (!invocation) return fail("git-syntax", "Unsupported Git spelling, wrapper, assignment or shell expansion.");
  // Hardening is part of the execution, not a property of probes alone.
  if (!["--no-lazy-fetch", "--no-optional-locks"].every(flag => invocation.globals.includes(flag)) ||
      !invocation.globals.some(flag => flag === "--no-pager" || flag === "-P"))
    return fail("git-hardening", "Git execution must disable lazy fetch, optional locks and paging.");
  const { sub, args, directory } = invocation;
  if (invocation.globals.includes("--no-replace-objects") && sub !== "show" && sub !== "diff")
    return fail("git-global", "Replacement control is currently proved only for show and diff.", "--no-replace-objects");
  if (sub === "diff" && !invocation.globals.includes("--no-replace-objects"))
    return fail("git-hardening", "Diff execution must disable object replacements.", "--no-replace-objects");
  const separator = args.indexOf("--");
  const flags = separator < 0 ? args : args.slice(0, separator);
  const paths = separator < 0 ? [] : args.slice(separator + 1);
  const badPath = paths.find(path => !pathWord(path));
  if (badPath !== undefined) return fail("git-pathspec", "Only literal, repository-relative pathspecs are proved.", badPath);
  if (sub === "status" && flags.every(arg => gitStatusFlags.has(arg))) return { kind: "metadata", sub, paths, directory,
    ignoreSubmodulesAll: flags.includes("--ignore-submodules=all") };
  if (sub === "ls-files" && flags.every(arg => ["--cached", "-c", "--stage", "-s", "-z", "--others", "--exclude-standard"].includes(arg))) return { kind: "metadata", sub, paths, directory };
  if (sub === "branch" && args.every(arg => ["--show-current", "--list", "--all", "-a", "--remotes", "-r", "-v", "-vv"].includes(arg))) return { kind: "metadata", sub, paths: [], directory };
  // Verbose remote output can contain inline credentials; never prove it.
  if (sub === "remote" && args.length === 0) return { kind: "metadata", sub, paths: [], directory };
  if (sub === "rev-parse" && (["HEAD", "--show-toplevel", "--git-path hooks"].includes(args.join(" ")) ||
      (args.length === 2 && ["--short", "--short=12", "--verify", "--abbrev-ref", "--symbolic-full-name"].includes(args[0]) && revisionWord(args[1])))) return { kind: "metadata", sub, paths: [], directory };
  if (sub === "show" && separator < 0) {
    const operands = flags.filter(arg => !["--no-show-signature", "--no-ext-diff", "--no-textconv"].includes(arg));
    const blob = operands.length === 1 ? blobOperand(operands[0]) : undefined;
    if (blob) {
      if (!invocation.globals.includes("--no-replace-objects") ||
          !["--no-show-signature", "--no-ext-diff", "--no-textconv"].every(arg => flags.includes(arg)))
        return fail("git-hardening", "Blob show requires replacement, signature and external-conversion hardening.");
      return { kind: "blob", sub, paths: [blob.path], directory, blobRevision: blob.revision };
    }
  }
  if (sub === "log" || sub === "show") {
    if (!flags.includes("--no-show-signature") || !explicitPretty(flags))
      return fail("git-hardening", "History execution needs a safe explicit format and --no-show-signature.");
    if (sub === "show" && separator >= 0) return fail("git-show", "Metadata show cannot carry pathspecs.", "--");
    let commit = false;
    for (let i = 0; i < flags.length; i++) {
      const arg = flags[i];
      const consumed = gitHistoryOptionLength(flags, i);
      if (consumed) { i += consumed - 1; continue; }
      if (sub === "show" && (/^HEAD(?:[~^][0-9]*)+$/.test(arg) ||
          (/\^\{commit\}$/.test(arg) && gitLogRevision(arg.slice(0, -9))))) { commit = true; continue; }
      // -- forces revision interpretation; otherwise Git may treat a revision
      // as an implicit file path. Hardening adds it to every proved log.
      if (sub === "log" && separator >= 0 && gitLogRevision(arg)) continue;
      return fail("git-token", "Unsupported Git history token or unsafe pretty/date value.", arg);
    }
    if (sub === "show" && (!commit || !flags.some(arg => arg === "-s" || arg === "--no-patch")))
      return fail("git-show", "Metadata show needs -s/--no-patch and a commit-constrained revision; blob show needs one rev:path.");
    return { kind: "metadata", sub, paths, directory };
  }
  if (sub === "diff" && ["--no-ext-diff", "--no-textconv"].every(arg => flags.includes(arg)) &&
      (flags.includes("--submodule=short") || flags.includes("--ignore-submodules=all"))) {
    const revisions: string[] = [];
    for (const flag of flags) {
      if (diffFlags.has(flag) || ["-z", "--binary"].includes(flag) || unifiedContextFlag(flag) || /^--diff-filter=[ACDMRTUXBacdmrtuxb]+$/.test(flag)) continue;
      const ends = flag.split("..");
      if (ends.length > 2 || !ends.every(revisionWord)) return fail("git-token", "Unsupported Git diff token.", flag);
      revisions.push(...ends);
    }
    if (revisions.length > 2 || (paths.length && !flags.includes("--no-renames")))
      return fail("git-diff-scope", "Diff needs at most two revisions and disabled renames for pathspecs.");
    const content = flags.some(flag => ["-p", "--patch", "--binary", "--check"].includes(flag) || unifiedContextFlag(flag));
    const summaryOnly = !content && flags.some(flag => ["--stat", "--numstat", "--shortstat", "--summary", "--name-only", "--name-status"].includes(flag));
    return { kind: summaryOnly ? "metadata" : "diff", sub, paths, directory, revisions,
      cached: flags.some(flag => ["--cached", "--staged"].includes(flag)), noRenames: flags.includes("--no-renames"),
      ignoreSubmodulesAll: flags.includes("--ignore-submodules=all") };
  }
  return fail("git-command", "Git subcommand or options have no managed read proof.", sub);
}

// Bounded local probes; no user options and never implicit partial-clone fetch.
function gitOutput(cwd: string, args: string[], literalPaths = false): string {
  return execFileSync("git", ["--no-lazy-fetch", "--no-optional-locks", "--no-pager", "--no-replace-objects", ...args], {
    cwd, encoding: "utf8", timeout: 5000, maxBuffer: 4 * 1024 * 1024,
    // Only the independent all-index gitlink inventory forces literal paths.
    // Changed-name probes MUST keep execution's ambient pathspec semantics.
    ...(literalPaths ? { env: { ...process.env, GIT_LITERAL_PATHSPECS: "1",
      GIT_GLOB_PATHSPECS: "0", GIT_NOGLOB_PATHSPECS: "0", GIT_ICASE_PATHSPECS: "0" } } : {}),
    stdio: ["ignore", "pipe", "ignore"],
  });
}
function gitNames(cwd: string, args: string[], literalPaths = false): string[] {
  const output = gitOutput(cwd, args, literalPaths);
  if (output && !output.endsWith("\0")) throw new Error("Incomplete Git name list");
  return output.split("\0").filter(Boolean);
}
function hasGitConfig(cwd: string, pattern: string): boolean {
  try { return gitOutput(cwd, ["config", "--name-only", "--get-regexp", pattern]).length > 0; }
  catch (error) {
    // Git documents status 1 for no matching key. Timeout, malformed config,
    // overflow and every other failure are not evidence of absence.
    const failed = error as { status?: number; stdout?: string };
    if (failed.status === 1 && failed.stdout === "") return false;
    throw error;
  }
}
function uncertainGitCd(directory: string): boolean {
  // Bash can retain an inherited logical PWD whose own '..' is normalized by
  // even `cd .`. Refuse both sources of ambiguity before any Git probe.
  return [directory, process.env.PWD ?? ""].some(path => path.split(/[\\/]/).includes(".."));
}

// Native realpath preserves physical symlink/.. semantics used by Git -C.
// path.resolve/join on the operand first would select a different repository.
function canonicalGitDirectory(base: string, directory?: string): string {
  const root = realpathSync.native(base);
  return directory ? realpathSync.native(isAbsolute(directory) ? directory : `${root}${sep}${directory}`) : root;
}

function hasCheckedOutSubmodule(cwd: string, proof: GitProof, normalizer: PathNormalizer): boolean {
  const output = gitOutput(cwd, ["rev-parse", "--show-toplevel"]);
  const lines = output.split("\n");
  if (lines.length !== 2 || lines[1] !== "" || !isAbsolute(lines[0])) throw new Error("Unknown Git top-level");
  const top = canonicalGitDirectory(lines[0]);
  if (normalizer.isBoundaryOutsideWorkingDirectory(top)) throw new Error("External submodule inspection root");
  const links = new Set<string>();
  // Remain in the SAME cwd/config context. The absolute literal selector and
  // --full-name include sibling gitlinks when status runs from a subdirectory.
  // Parent helper config was checked before this non-recursive index query.
  for (const entry of gitNames(cwd, ["--literal-pathspecs", "ls-files", "--stage", "--full-name", "-z", "--", top], true)) {
    const match = /^([0-7]{6}) ([0-9a-f]{40}|[0-9a-f]{64}) [0-3]\t([^\0]+)$/.exec(entry);
    if (!match) throw new Error("Unknown index entry");
    if (match[1] === "160000") links.add(match[3]);
  }
  if (proof.sub === "diff") {
    for (const rev of new Set(["HEAD", ...(proof.revisions ?? [])])) {
      for (const entry of gitNames(cwd, ["ls-tree", "-r", "--full-tree", "-z", `${rev}^{tree}`])) {
        const match = /^([0-7]{6}) (?:blob|tree|commit) ([0-9a-f]{40}|[0-9a-f]{64})\t([^\0]+)$/.exec(entry);
        if (!match) throw new Error("Unknown tree entry");
        if (match[1] === "160000") links.add(match[3]);
      }
    }
  }
  for (const path of links) {
    if (!pathWord(path)) return true;
    try { lstatSync(`${top}${sep}${path}`); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      return true;
    }
    let directory: string;
    try { directory = canonicalGitDirectory(top, path); }
    catch { return true; } // An existing but dangling gitlink path is uncertain.
    if (normalizer.isBoundaryOutsideWorkingDirectory(directory)) return true;
    try {
      // Both the normal .git file and old-form .git directory count. Any other
      // filesystem object, broken link or inaccessible state is uncertainty,
      // not evidence that Git will never inspect this submodule.
      lstatSync(join(directory, ".git"));
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") return true;
    }
  }
  return false;
}

function repositoryLayout(cwd: string): { mainRoot?: string } | undefined {
  const roots = (base: string) => {
    const output = gitOutput(base, ["rev-parse", "--path-format=absolute", "--show-toplevel", "--git-dir", "--git-common-dir"]);
    const paths = output.endsWith("\n") ? output.slice(0, -1).split("\n") : [];
    if (paths.length !== 3 || !paths.every(isAbsolute)) return;
    return paths.map(path => realpathSync(path));
  };
  const found = roots(cwd);
  if (!found) return;
  const [top, gitdir, common] = found;
  if (top !== realpathSync(cwd)) return;
  if (gitdir === common) {
    if (common !== join(top, ".git") || !lstatSync(common).isDirectory()) return;
    return {};
  }
  // Only a conventional shared administration directory has an unambiguous
  // primary worktree root. Separate gitdirs, bare primaries and other layouts
  // decline proof rather than guessing dirname(commonDir) is a worktree.
  if (basename(common) !== ".git" || dirname(gitdir) !== join(common, "worktrees") || !lstatSync(common).isDirectory()) return;
  const mainRoot = dirname(common), main = roots(mainRoot);
  if (!main || main[0] !== mainRoot || main[1] !== common || main[2] !== common) return;
  return { mainRoot };
}
function blobInTree(cwd: string, tree: string, path: string): boolean {
  const entries = gitNames(cwd, ["ls-tree", "-z", "--full-tree", tree, "--", path]);
  if (entries.length !== 1) return false;
  const match = /^(100644|100755|120000) blob ([0-9a-f]{40}|[0-9a-f]{64})\t([^\0]+)$/.exec(entries[0]);
  if (!match || match[3] !== path) return false;
  // ls-tree derives its type label from tree mode; replace refs or a malformed
  // tree can disagree with the actual object. Execution also disables replace.
  return gitOutput(cwd, ["cat-file", "-t", match[2]]) === "blob\n";
}
function pinBlob(cwd: string, proof: GitProof): string | undefined {
  const output = gitOutput(cwd, ["rev-parse", "--verify", "--end-of-options", `${proof.blobRevision}^{tree}`]);
  const tree = output.endsWith("\n") ? output.slice(0, -1) : "";
  if (!objectId(tree) || !blobInTree(cwd, tree, proof.paths[0])) return;
  return `${tree}:${proof.paths[0]}`;
}

type ScopeProof = { ruleCandidates: BashPathRuleCandidate[]; externalAccesses: BashExternalPath[] };
export function managedGitProof(source: string, normalizer: PathNormalizer, workdir?: string, reject?: (diagnostic: ManagedGitDiagnostic) => void): ScopeProof | undefined {
  const fail = (code: string, reason: string) => { reject?.({ code, reason }); return undefined; };
  const proof = inspectGit(source, reject);
  if (!proof) return;
  let cwd: string;
  try {
    cwd = canonicalGitDirectory(normalizer.resolveBase(""), workdir);
    if (proof.directory) cwd = canonicalGitDirectory(cwd, proof.directory);
  } catch { return fail("git-cwd", "The Git execution directory cannot be established."); }
  // External gates run AFTER analysis. They cannot authorize earlier probes.
  if (normalizer.isBoundaryOutsideWorkingDirectory(cwd))
    return fail("git-external-cwd", "Managed Git probes do not run in an external execution directory.");
  let names = proof.paths;
  let mainRoot: string | undefined;
  try {
    // Index readers can invoke configured helpers even with textconv/ext-diff
    // disabled. Probe configuration before any index/name query; unknown helper
    // configurations stay on the ordinary permission path, not a read proof.
    if (["status", "ls-files", "diff"].includes(proof.sub) &&
        hasGitConfig(cwd, "^(core\\.fsmonitor|filter\\..*\\.(clean|process))$"))
      return fail("git-helper-config", "Configured index/content helpers prevent a managed Git read proof.");
    if (proof.kind === "diff" || proof.kind === "blob") {
      const layout = repositoryLayout(cwd);
      if (!layout) return fail("git-layout", "Content proof needs the repository root and a conventional non-bare Git/worktree layout.");
      mainRoot = layout.mainRoot;
      if (hasGitConfig(cwd, "^(extensions\\.partialclone|remote\\..*\\.(promisor|partialclonefilter))$"))
        return fail("git-partial-clone", "Content proof is unavailable for a partial/promisor clone; lazy fetch remains disabled.");
    }
    if (["status", "diff"].includes(proof.sub) && !proof.ignoreSubmodulesAll &&
        hasCheckedOutSubmodule(cwd, proof, normalizer))
      return fail("git-submodule-helper", "Checked-out or uncertain submodules need ordinary review, or explicit --ignore-submodules=all.");
    if (proof.kind === "blob") {
      if (!proof.blobRevision || !objectId(proof.blobRevision))
        return fail("git-blob-unpinned", "Historical file could not be pinned to an immutable tree and a verified blob.");
      if (!blobInTree(cwd, proof.blobRevision, proof.paths[0]))
        return fail("git-blob-type", "Historical file must resolve to exactly one actual blob, not a tree, gitlink or commit.");
    }
    if (proof.kind === "diff") {
      const indexed = gitNames(cwd, ["ls-files", "--cached", "-z"]);
      const trees = [...new Set(["HEAD", ...(proof.revisions ?? [])])];
      const committed = trees.flatMap(rev => gitNames(cwd, ["ls-tree", "-r", "--name-only", "-z", `${rev}^{tree}`]));
      const knownNames = new Set([...indexed, ...committed]);
      let all = [...knownNames];
      if (proof.noRenames) {
        // A bounded names-only query selects actual changed paths. This exposes
        // metadata, never patch text, and prevents an UNCHANGED protected file
        // from denying every ordinary whole-tree diff/check in the repository.
        // Renames/copies must be disabled in the actual command as well.
        // Keep gitlink OID/dirty metadata visible, with the same ignore policy
        // as execution. Short format never renders nested logs or file diffs.
        const changed = gitNames(cwd, ["diff", "--no-ext-diff", "--no-textconv", "--submodule=short", "--no-renames", "--name-only", "-z",
          ...(proof.ignoreSubmodulesAll ? ["--ignore-submodules=all"] : []),
          ...(proof.cached ? ["--cached"] : []), ...(proof.revisions ?? []), "--", ...proof.paths]);
        if (changed.some(name => !knownNames.has(name))) return fail("git-unknown-path", "Git reported a changed path outside the inspected index/tree names.");
        all = changed;
      }
      // Git already applied the pathspec. A second JS prefix filter disagrees
      // with e.g. GIT_ICASE_PATHSPECS and can discard a protected actual name.
      // With no selector, use the index/tree union conservatively.
      names = all;
      if (![...names, ...proof.paths].every(pathWord)) return fail("git-path-name", "Git returned a path outside the supported literal path language.");
      // Git compares a tracked symlink's link text, not its target contents.
      // Still retain lexical AND canonical checks below; do not abandon the
      // whole proof just because an unrelated tracked documentation link exists.
    }
    const tokens = [...new Set([...names, ...proof.paths])];
    const ruleCandidates = tokens.map(token => ({ token,
      path: normalizer.forPath(token, { resolveBase: cwd }), effect: READ }));
    if (proof.directory) ruleCandidates.push({ token: proof.directory, path: normalizer.forPath(cwd), effect: READ });
    if (mainRoot) ruleCandidates.push({ token: mainRoot, path: normalizer.forPath(mainRoot), effect: READ });
    const externalAccesses = ruleCandidates.filter(({ path }) =>
      normalizer.isBoundaryOutsideWorkingDirectory(path.boundaryValue())).map(({ path, effect }) => ({ path, effect }));
    return { ruleCandidates, externalAccesses };
  } catch { return fail("git-probe-failed", "A bounded local Git probe failed, timed out or exceeded its output limit."); }
}

type LiteralUnit = { text: string; words: string[]; start: number; end: number };
// Reuse upstream's actual AST. Only fully literal commands joined by ordinary
// foreground operators enter this lane; wrappers need a separate exact proof.
export function literalProgram(root: TSNode): LiteralUnit[] | undefined {
  if (parseUnresolvedWithin(root)) return;
  const units: LiteralUnit[] = [];
  const walk = (node: TSNode): boolean => {
    if (!node.isNamed) return ["&&", "||", ";", "|"].includes(node.text);
    if (node.type === "command") {
      const words = gitLiteralWords(node.text) ?? literalWords(node.text);
      if (!words || !/^[a-z][a-z0-9-]*$/.test(words[0])) return false;
      units.push({ text: node.text, words, start: node.startIndex, end: node.endIndex });
      return true;
    }
    if (!["program", "list", "pipeline"].includes(node.type)) return false;
    for (let i = 0; i < node.childCount; i++) if (!walk(node.child(i)!)) return false;
    return true;
  };
  return walk(root) && units.length ? units : undefined;
}

export type ManagedStaticFileScope = {
  readonly command: string;
  readonly marked: readonly boolean[];
  readonly accesses: readonly { token: string; path: string; resolveBase?: string; effect: "read" | "write" }[];
};

const originals = new WeakMap<object, { command: string; units: string[]; fileScope?: ManagedStaticFileScope }>();
// Provenance requires the same input object and unchanged hardened command.
export function originalGitCommands(input: Record<string, unknown>): string[] | undefined {
  const original = originals.get(input);
  return original?.command === input.command ? original.units : undefined;
}

// The pipeline can obtain a file-effect scope only for the exact input object
// mutated by this module. A JSON field with the same name has no authority.
export function managedStaticFileScope(input: Record<string, unknown>): ManagedStaticFileScope | undefined {
  const original = originals.get(input);
  return original?.command === input.command && original.fileScope?.command === input.command
    ? original.fileScope : undefined;
}
const shellWord = (word: string) => /^[A-Za-z0-9_./:%=+@^,~-]+$/.test(word) ? word : `'${word.replace(/'/g, "'\\''")}'`;

export type ManagedScratchRoot = {
  readonly path: string;
  readonly dev: string;
  readonly ino: string;
  readonly uid: number;
  readonly birthtimeNs: string;
};

const STATIC_FILE_MAX_FILES = 128;
const STATIC_FILE_MAX_BYTES = 64 * 1024 * 1024;
const WRITE: TokenEffect = { effect: "write", source: "managed-literal" };

function bigintStat(path: string) {
  try { return lstatSync(path, { bigint: true }); } catch { return undefined; }
}

function noSymlinkAncestors(path: string): boolean {
  if (!isAbsolute(path)) return false;
  let current = resolve(path);
  const chain: string[] = [];
  while (current !== dirname(current)) { chain.push(current); current = dirname(current); }
  chain.push(current);
  for (const item of chain.reverse()) {
    const stat = bigintStat(item);
    if (!stat || stat.isSymbolicLink()) return false;
  }
  return true;
}

function validScratchRoot(record: ManagedScratchRoot): boolean {
  if (!/^\/tmp\/tmp\.[A-Za-z0-9]+$/.test(record.path) || resolve(record.path) !== record.path) return false;
  const stat = bigintStat(record.path);
  const euid = process.geteuid?.();
  return !!stat && stat.isDirectory() && !stat.isSymbolicLink() && euid !== undefined &&
    record.uid === euid && Number(stat.uid) === euid && Number(stat.mode & 0o777n) === 0o700 &&
    stat.dev.toString() === record.dev && stat.ino.toString() === record.ino &&
    stat.birthtimeNs.toString() === record.birthtimeNs && noSymlinkAncestors(record.path);
}

const under = (root: string, path: string) => {
  const rel = relative(root, path);
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
};

function rootFor(path: string, roots: readonly ManagedScratchRoot[]): ManagedScratchRoot | undefined {
  return roots.filter(root => under(root.path, path)).sort((a, b) => b.path.length - a.path.length)[0];
}

function validateExistingChain(root: ManagedScratchRoot, path: string, plannedDirs: Set<string>): boolean {
  let current = dirname(path);
  while (current !== root.path) {
    if (!under(root.path, current)) return false;
    if (!plannedDirs.has(current)) {
      const stat = bigintStat(current);
      if (!stat || !stat.isDirectory() || stat.isSymbolicLink() || stat.dev.toString() !== root.dev) return false;
    }
    current = dirname(current);
  }
  return true;
}

type PlannedFile = { size: number; sourceDev: string; sourceIno: string };
// Keep lexical operands and normalized path-policy values aligned. In
// particular, do not let trimming or URI-like prefixes disappear in resolve().
const staticFileOperand = (word: string) => {
  if (word === ".") return true;
  if (!/^(?:\/)?[A-Za-z0-9_.-][A-Za-z0-9_./ -]*$/.test(word) || word.startsWith("-") || word.endsWith("/")) return false;
  const path = word.startsWith("./") ? word.slice(2) : word;
  return path.split("/").every((part, index) => (part !== "" || (index === 0 && path.startsWith("/"))) &&
    part !== "." && part !== ".." && part === part.trim());
};

/**
 * Harden a deliberately tiny mkdir/cp language and privately attach its exact
 * read/write scope to the actual mutable SDK input object. The scratch records
 * are provenance, not a path-policy override; downstream gates still resolve
 * every access on their normal directional surfaces.
 */
export async function hardenStaticFileInput(
  input: Record<string, unknown>,
  scratchRoots: readonly ManagedScratchRoot[],
  sessionCwd: string,
): Promise<{ version: 1; originalDigest: string; executionDigest: string } | undefined> {
  // A scope is a proof for this invocation, never a reusable grant on an input
  // object. SDK callers may reuse objects after execution or across sessions.
  const previous = originals.get(input);
  if (previous?.fileScope) originals.set(input, { command: previous.command, units: previous.units });
  if (typeof input.command !== "string" || scratchRoots.length === 0) return;
  const source = input.command;
  const tree = (await getParser()).parse(source);
  if (!tree) return;
  try {
    const units = literalProgram(tree.rootNode);
    if (!units || units.some(unit => source.slice(unit.start, unit.end) !== unit.text)) return;
    if (source.slice(0, units[0].start).trim() || source.slice(units.at(-1)!.end).trim()) return;
    for (let i = 1; i < units.length; i++) {
      if (!/^\s*&&\s*$/.test(source.slice(units[i - 1].end, units[i].start))) return;
    }

    const roots = scratchRoots.filter(validScratchRoot);
    if (roots.length === 0) return;
    let cwd = resolve(sessionCwd);
    let first = 0;
    const replacements: string[] = [];
    const accesses: Array<{ token: string; path: string; resolveBase?: string; effect: "read" | "write" }> = [];
    const marked: boolean[] = [];
    if (units[0].words[0] === "cd") {
      if (units[0].words.length !== 2 || units.length < 2 || !staticFileOperand(units[0].words[1])) return;
      const previousCwd = cwd;
      cwd = resolve(cwd, units[0].words[1]);
      const stat = bigintStat(cwd);
      if (!stat?.isDirectory() || !noSymlinkAncestors(cwd)) return;
      // Absolute operands cannot be options or follow CDPATH. Keep the same
      // option-free spelling accepted by the independent static guard.
      replacements.push(`cd ${shellWord(cwd)}`);
      accesses.push({ token: units[0].words[1], path: cwd, resolveBase: previousCwd, effect: "read" });
      marked.push(false);
      first = 1;
    }
    if (units.slice(first).some(unit => unit.words[0] === "cd")) return;

    const plannedDirs = new Set<string>();
    const plannedFiles = new Map<string, PlannedFile>();
    let fileCount = 0;
    let byteCount = 0;
    const checkedRoots = new Set<string>();
    const checkDestination = (path: string) => {
      const root = rootFor(path, roots);
      if (!root || !validScratchRoot(root) || !validateExistingChain(root, path, plannedDirs)) return undefined;
      checkedRoots.add(root.path);
      return root;
    };
    const sourceFile = (path: string): PlannedFile | undefined => {
      const planned = plannedFiles.get(path);
      if (planned) return planned;
      const stat = bigintStat(path);
      if (!stat || !stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1n || !noSymlinkAncestors(path)) return;
      const containing = roots.find(root => path === root.path || under(root.path, path));
      if (containing && stat.dev.toString() !== containing.dev) return;
      return { size: Number(stat.size), sourceDev: stat.dev.toString(), sourceIno: stat.ino.toString() };
    };

    for (let index = first; index < units.length; index++) {
      const { words } = units[index];
      if (words[0] === "mkdir") {
        if (words.length < 3 || words[1] !== "-p" || !words.slice(2).every(staticFileOperand)) return;
        const paths = words.slice(2).map(word => resolve(cwd, word));
        for (const [pathIndex, path] of paths.entries()) {
          const root = rootFor(path, roots);
          if (!root || !validScratchRoot(root)) return;
          checkedRoots.add(root.path);
          accesses.push({ token: words[pathIndex + 2], path, resolveBase: cwd, effect: "write" });
          const implied: string[] = [];
          let current = path;
          while (current !== root.path) {
            if (!under(root.path, current)) return;
            const existing = bigintStat(current);
            if (existing) {
              if (!existing.isDirectory() || existing.isSymbolicLink() || existing.dev.toString() !== root.dev) return;
            } else if (!plannedDirs.has(current)) implied.push(current);
            current = dirname(current);
          }
          for (const directory of implied.reverse()) {
            plannedDirs.add(directory);
            accesses.push({ token: directory, path: directory, effect: "write" });
          }
        }
        replacements.push(["mkdir", "-p", "--", ...paths].map(shellWord).join(" "));
        marked.push(true);
        continue;
      }
      if (words[0] !== "cp" || words.length < 3 || !words.slice(1).every(staticFileOperand)) return;
      const sources = words.slice(1, -1).map(word => resolve(cwd, word));
      const requestedTarget = resolve(cwd, words.at(-1)!);
      const targetStat = bigintStat(requestedTarget);
      const targetIsDirectory = plannedDirs.has(requestedTarget) || !!targetStat?.isDirectory();
      if (sources.length > 1 && !targetIsDirectory) return;
      if (targetStat && (targetStat.isSymbolicLink() || (targetIsDirectory && !targetStat.isDirectory()))) return;
      // Preserve rules on the explicit directory operand as well as on every
      // derived child. An exact directory deny must not disappear on expansion.
      accesses.push({ token: words.at(-1)!, path: requestedTarget, resolveBase: cwd, effect: "write" });
      const destinations = sources.map(src => targetIsDirectory ? join(requestedTarget, basename(src)) : requestedTarget);
      const sourceFacts = sources.map(sourceFile);
      if (sourceFacts.some(item => !item)) return;
      for (let i = 0; i < destinations.length; i++) {
        const dest = destinations[i];
        const root = checkDestination(dest);
        const fact = sourceFacts[i]!;
        if (!root || dest === sources[i] || bigintStat(dest) || plannedDirs.has(dest) || plannedFiles.has(dest)) return;
        if (++fileCount > STATIC_FILE_MAX_FILES || (byteCount += fact.size) > STATIC_FILE_MAX_BYTES) return;
        plannedFiles.set(dest, fact);
        accesses.push({ token: words[i + 1], path: sources[i], resolveBase: cwd, effect: "read" });
        accesses.push({ token: dest, path: dest, effect: "write" });
      }
      replacements.push(targetIsDirectory
        ? ["cp", "--no-dereference", `--target-directory=${requestedTarget}`, "--", ...sources].map(shellWord).join(" ")
        : ["cp", "--no-dereference", "--no-target-directory", "--", sources[0], destinations[0]].map(shellWord).join(" "));
      marked.push(true);
    }
    if (checkedRoots.size === 0 || replacements.length !== units.length) return;

    let command = source;
    for (let i = units.length - 1; i >= 0; i--)
      command = command.slice(0, units[i].start) + replacements[i] + command.slice(units[i].end);
    if (command === source) return;
    const scope: ManagedStaticFileScope = { command, marked, accesses };
    input.command = command;
    originals.set(input, { command, units: units.map(unit => unit.text), fileScope: scope });
    const hash = (value: string) => createHash("sha256").update(value).digest("hex");
    return { version: 1, originalDigest: hash(source), executionDigest: hash(command) };
  } finally { tree.delete(); }
}

export function managedStaticFileProof(
  scope: ManagedStaticFileScope | undefined,
  command: string,
  normalizer: PathNormalizer,
): (ScopeProof & { marked: boolean[] }) | undefined {
  if (!scope || scope.command !== command) return;
  const ruleCandidates = scope.accesses.map(({ token, path, resolveBase, effect }) => ({
    token, path: resolveBase === undefined ? normalizer.forPath(path) : normalizer.forPath(token, { resolveBase }),
    effect: effect === "read" ? READ : WRITE,
  }));
  const externalAccesses = ruleCandidates.filter(({ path }) =>
    normalizer.isBoundaryOutsideWorkingDirectory(path.boundaryValue())).map(({ path, effect }) => ({ path, effect }));
  return { ruleCandidates, externalAccesses, marked: [...scope.marked] };
}

function hardenedUnit(words: string[], cwd?: string, sessionRoot?: string): string | undefined {
  if (words.length === 3 && words[0] === "command" && words[1] === "-v" && commandProbes.has(words[2]))
    return ["type", "-P", "--", words[2]].map(shellWord).join(" ");
  if (words.length === 3 && words[0] === "bash" && words[1] === "-n" && ordinaryFileWord(words[2]))
    return ["bash", "--noprofile", "--norc", "-p", "-n", "--", words[2]].map(shellWord).join(" ");
  if (words.length > 1 && words[0] === "printenv" && words.slice(1).every(word => exposedEnvironment.has(word)))
    return ["printenv", "--", ...words.slice(1)].join(" ");
  if (words.length > 2 && words[0] === "env" && words[1] === "printenv" && words.slice(2).every(word => exposedEnvironment.has(word)))
    return ["printenv", "--", ...words.slice(2)].join(" ");
  const invocation = gitInvocation(words);
  if (!invocation?.sub) return;
  const { sub, args, directory, wrapped, globals } = invocation;
  const separator = args.indexOf("--");
  const flags = separator < 0 ? args : args.slice(0, separator);
  const blob = sub === "show" && flags.some(arg => blobOperand(arg));
  // Disabling rename/copy detection changes filter selection, including A/D
  // and lowercase exclusions. Only do so when the user already requested it.
  if (sub === "diff" && flags.some(flag => flag.startsWith("--diff-filter=")) && !flags.includes("--no-renames")) return;
  // Never erase a requested unsafe option to manufacture a proof. Short format
  // bounds submodule disclosure without hiding gitlink or dirty-state changes.
  // Do not override the user's explicit or configured submodule ignore policy.
  const extra = (sub === "diff" ? ["--no-ext-diff", "--no-textconv", "--submodule=short", "--no-renames"] :
    blob ? ["--no-show-signature", "--no-ext-diff", "--no-textconv"] :
    sub === "log" || sub === "show" ? ["--no-show-signature", ...(!explicitPretty(flags) ? ["--format=medium"] : [])] : [])
    .filter(flag => !flags.includes(flag));
  const endOfRevisions = sub === "log" && !args.includes("--") ? ["--"] : [];
  const prefix = [...(wrapped ? ["env"] : []), "git", "--no-lazy-fetch", "--no-optional-locks", "--no-pager",
    ...(blob || sub === "diff" || globals.includes("--no-replace-objects") ? ["--no-replace-objects"] : []), ...(directory ? ["-C", directory] : []), sub, ...extra];
  let result = [...prefix, ...args, ...endOfRevisions].map(shellWord).join(" ");
  const proof = inspectGit(result);
  if (!proof) return;
  if (proof.kind === "blob") {
    if (!cwd || !sessionRoot) return;
    try {
      const base = canonicalGitDirectory(cwd, directory);
      const offset = relative(sessionRoot, base);
      if (offset === ".." || offset.startsWith(`..${sep}`) || isAbsolute(offset)) return;
      if (!repositoryLayout(base) || hasGitConfig(base, "^(extensions\\.partialclone|remote\\..*\\.(promisor|partialclonefilter))$")) return;
      const pinned = pinBlob(base, proof);
      if (!pinned) return;
      result = [...prefix, ...args.map(arg => blobOperand(arg) ? pinned : arg)].map(shellWord).join(" ");
    } catch { return; } // No rewrite or grant for an unpinned/invalid blob.
  }
  return result;
}

// Called BEFORE the authority's gate handler. SDK guarantees that in-place input
// mutation is the actual execution input; no tool replacement or gate bypass.
// Keep original command units privately so explicit ORIGINAL ask/deny rules are
// checked as well as normalized rules. The model cannot forge a WeakMap entry.
export async function hardenGitInput(input: Record<string, unknown>, sessionCwd = process.cwd()) {
  if (typeof input.command !== "string") return;
  const source = input.command;
  const tree = (await getParser()).parse(source);
  if (!tree) return;
  try {
    const units = literalProgram(tree.rootNode);
    if (!units || units.some(unit => source.slice(unit.start, unit.end) !== unit.text)) return;
    let sessionRoot: string | undefined, cwd: string | undefined;
    try { sessionRoot = cwd = canonicalGitDirectory(sessionCwd); } catch { /* No blob probes for an unknown base. */ }
    const cd = units.filter(unit => unit.words[0] === "cd");
    if (cd.length) {
      const first = cd[0];
      const rest = source.slice(first.end);
      if (cd.length !== 1 || first !== units[0] || first.words.length !== 2 ||
          !directoryWord(first.words[1]) || uncertainGitCd(first.words[1]) ||
          !/^\s*&&/.test(rest) || /;|\|\||\n/.test(rest)) cwd = undefined;
      else if (cwd) {
        try { cwd = canonicalGitDirectory(resolve(cwd, first.words[1])); } catch { cwd = undefined; }
      }
    }
    const replacements = units.map(unit => {
      // Do not turn a quoted/assigned env wrapper into this exact lane by
      // normalizing it first; the original inner policy must remain locatable.
      if (unit.words[0] === "env" && unit.words[1] === "git" && !managedGitInnerCommand(unit.text)) return undefined;
      return hardenedUnit(unit.words, cwd, sessionRoot);
    });
    if (!replacements.some(Boolean)) return;
    // Bash CDPATH can redirect a bare relative `cd` outside the checked cwd.
    // Make the ordinary leading-cd spelling explicitly cwd-relative instead.
    const first = units[0].words;
    if (first[0] === "cd" && first.length === 2 && first[1] && first[1] === first[1].trim() &&
        !first[1].startsWith("-") && !/^(?:\/|\.\.?\/|\.{1,2}$)/.test(first[1])) replacements[0] = `cd ${shellWord(`./${first[1]}`)}`;
    let command = source;
    for (let i = units.length - 1; i >= 0; i--) {
      const unit = units[i], replacement = replacements[i];
      if (replacement) command = command.slice(0, unit.start) + replacement + command.slice(unit.end);
    }
    if (command === source) return;
    input.command = command;
    originals.set(input, { command, units: units.map(unit => unit.text) });
    const hash = (value: string) => createHash("sha256").update(value).digest("hex");
    return { version: 1, originalDigest: hash(source), executionDigest: hash(command) };
  } finally { tree.delete(); }
}

// Used only for presentation when the AST is outside the literal-program lane.
// Recognizing a Git-looking unit here must never admit it or trigger probes.
export function managedGitSyntaxDiagnostic(source: string): ManagedGitDiagnostic | undefined {
  if (/^(?:env[ \t]+)?git(?:[ \t]|$)/.test(source)) return {
    code: "git-program-syntax",
    reason: "This shell structure, assignment or expansion is outside the complete literal Git read-proof language.",
  };
}

type ManagedProgramProof = ScopeProof & { marked: boolean[]; gitWrappers: (string | undefined)[] };
export function managedProgramAnalysis(root: TSNode, normalizer: PathNormalizer, workdir?: string): {
  proof?: ManagedProgramProof; diagnostics: (ManagedGitDiagnostic | undefined)[];
} {
  const units = literalProgram(root);
  if (!units) return { diagnostics: [] };
  const diagnostics: (ManagedGitDiagnostic | undefined)[] = units.map(() => undefined);
  const isGit = (unit: LiteralUnit) => unit.words[0] === "git" || (unit.words[0] === "env" && unit.words.includes("git"));
  const incomplete = (reason: string) => {
    units.forEach((unit, index) => { if (isGit(unit) && !diagnostics[index]) diagnostics[index] = { code: "git-program-scope", reason }; });
    return { diagnostics };
  };
  let cwd = normalizer.resolveBase(workdir ?? "");
  const hasGit = units.some(isGit);
  if (hasGit) {
    try { cwd = canonicalGitDirectory(normalizer.resolveBase(""), workdir); }
    catch { return incomplete("The Git execution directory cannot be established."); }
  }
  const cd = units.filter(unit => unit.words[0] === "cd");
  if (cd.length) {
    // Do not guess cwd after failed cd, pipes containing cd, multiple cd, ';',
    // or '||'. No probes run when the program cannot establish its base.
    const uncertain = () => incomplete("The shell program does not establish one deterministic Git working directory.");
    if (cd.length !== 1 || cd[0] !== units[0] || cd[0].words.length !== 2 || units.length < 2) return uncertain();
    const rest = root.text.slice(cd[0].end - root.startIndex);
    if (!/^\s*&&/.test(rest) || /;|\|\||\n/.test(rest)) return uncertain();
    if (cd[0].words[1] !== cd[0].words[1].trim() || !/^(?:\/|\.\.?\/|\.{1,2}$)/.test(cd[0].words[1])) return uncertain();
    if (hasGit) {
      // Bash can retain an inherited logical PWD through symlinks. A leading cd
      // with .. can therefore disagree with the physical session boundary.
      // Decline that form rather than probe a guessed repository; Git -C still
      // uses physical chdir semantics via canonicalGitDirectory.
      if (uncertainGitCd(cd[0].words[1])) return uncertain();
      try { cwd = canonicalGitDirectory(resolve(cwd, cd[0].words[1])); }
      catch { return uncertain(); }
    } else cwd = normalizer.forPath(cd[0].words[1], { resolveBase: cwd }).boundaryValue();
  }
  const ruleCandidates: BashPathRuleCandidate[] = [], externalAccesses: BashExternalPath[] = [], marked: boolean[] = [];
  const gitWrappers: (string | undefined)[] = units.map(() => undefined);
  let complete = true;
  for (const [index, unit] of units.entries()) {
    if (unit === cd[0]) { marked.push(false); continue; }
    if (isGit(unit)) {
      const git = managedGitProof(unit.text, normalizer, cwd, diagnostic => { diagnostics[index] = diagnostic; });
      if (git) {
        ruleCandidates.push(...git.ruleCandidates); externalAccesses.push(...git.externalAccesses); marked.push(true);
        gitWrappers[index] = managedGitInnerCommand(unit.text);
      } else { complete = false; marked.push(false); }
      continue;
    }
    const inspection = managedInspection(unit.words);
    if (inspection) {
      for (const token of inspection.files) {
        const path = normalizer.forPath(token, { resolveBase: cwd });
        try { if (!lstatSync(path.boundaryValue()).isFile()) complete = false; } catch { /* A missing literal file cannot become a recursive scan. */ }
        const candidate = { token, path, effect: READ };
        ruleCandidates.push(candidate);
        if (normalizer.isBoundaryOutsideWorkingDirectory(path.boundaryValue())) externalAccesses.push({ path, effect: READ });
      }
      marked.push(true);
      continue;
    }
    const read = managedReaderEffect(unit.text) ?? proveCommandEffect(unit.words[0], unit.words.slice(1));
    if (read.effect !== "read" && !["true", "false", "uname", "whoami", "id"].includes(unit.words[0])) complete = false;
    // Effect attribution is not a tool allowance for recursive readers.
    marked.push(printingSed(unit.words) || resourceMetadata(unit.words));
  }
  if (!complete) return incomplete("Another command in the shell program lacks a complete read-only proof.");
  return { proof: { ruleCandidates, externalAccesses, marked, gitWrappers }, diagnostics };
}

export function managedProgramProof(root: TSNode, normalizer: PathNormalizer, workdir?: string): ManagedProgramProof | undefined {
  return managedProgramAnalysis(root, normalizer, workdir).proof;
}
