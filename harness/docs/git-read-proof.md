# Managed Git read proof

Git read proof is a narrow extension of the managed permission pipeline, not an
independent authorizer or an OS sandbox. It classifies literal execution and
supplies read-path candidates; the normal Bash, path and external-directory
rules decide the outcome. Worker Git mutations remain denied and belong to the
parent. See [security](security.md) and [limitations](limitations.md).

## Grammar and literal spelling

[`extensions/lib/git-read-grammar.ts`](../../extensions/lib/git-read-grammar.ts)
is the import-free source of shared status flags, history option lengths,
pretty/date validation, revision atoms and literal path words. The static guard
and managed overlay share these primitives, not an identical acceptance policy.

- History values must be attached: `--format=...`, `--pretty=...`, `--date=...`.
  Counts retain their supported attached and separate-operand forms.
- Pretty values accept exact safe builtins (`medium`, `short`, `full`, `fuller`,
  `raw`, `oneline`, `reference`), explicit `format:`/`tformat:` templates, or
  implicit templates containing `%`. Templates are scanned by token: `%G`
  signature-verification placeholders, byte escapes, color, widths and trailers
  are rejected; `%%G?` is literal text. Unknown named pretty aliases are not
  proved, even if their configured expansion looks harmless.
- Dates use enumerated modes or a bounded `format:`/`format-local:` template
  with a fixed strftime directive and literal alphabet. Literal control
  characters, NUL and line breaks are rejected.
- Status accepts exact `--ignore-submodules=all`, not a bare option, abbreviation
  or another ignore mode.
- Log supports ranges, multiple revision words, `^A` and `--not`; a revision
  word cannot start with an option. Diff uses stricter revision atoms and splits
  supported ranges in its caller. Path words remain a restricted literal
  language, not arbitrary Git pathspec magic or a path permission.

The managed overlay has a **Git-only** concatenation decoder. It accepts literal
quoted fragments such as `--format='%H %P %s'` and `--date=format:'%Y %m'`, then
re-encodes words for execution. It rejects expansions and unsupported shell
syntax. The non-Git `literalWords` decoder and its reader/scratch consumers are
unchanged. Quoting does not widen the path grammar; apostrophe-containing
pathspecs are not supported.

## Static floor and managed env route

The independent static query check remains exactly `status`, `log`, `show`.
It permits supported metadata spelling, but bare `show` must have
`-s`/`--no-patch` and an explicit commit-constrained revision such as `HEAD^0`.
Bare historical-file show remains statically blocked. Bare `git log -- path...`
is accepted only when **every** following word passes the restricted
`gitPathWord` grammar; `--` does not unconditionally admit arbitrary pathspecs.
Those paths still need normal path/external authorization. **Diff never enters
this static query check**; its other denies and gates still apply.
Wrapped queries retain their existing static skip behavior.

The managed wrapper lane admits only exact bare `env git ...`: no env flags,
assignments, quoted wrapper spelling or other wrappers. For example,
`env git show HEAD:docs/file.md` and `env git log -- docs/file.md` can reach the
repository-aware proof, but are not permission grants. `env -i git ...`,
`env FOO=1 git ...` and unsupported Git configuration/global options receive no
managed proof. Unsupported wrappers keep their ordinary behavior.

Admission requires a complete read proof for the shell program and a narrowly
marked env Git unit. The wrapper-floor exception also requires the managed read
opt-in and valid policy scope; it is not a general wrapper exemption. Both inner
Git and outer env requests are resolved in their original and hardened spellings,
including command-specific asks/denies. Originals come from a private WeakMap
bound to the actual input object and unchanged hardened command, not model
fields. The decision and session-grant surface remain the outer request.
The authority also checks the original spelling against the independent static
Bash deny floor **before** hardening or probes. Injected flags and pinned object
IDs cannot hide an exact original deny behind a Bash session grant.

A Bash-surface session grant skips only its own gate, not path or
external-directory gates. Static checking is independent. Ordinary session
rules may override ordinary configuration denies through normal permission
composition; the immutable-resource floor and reader write ceiling are separate
and are not widened by session grants or yolo.

The pre-existing mismatch between bare and env-wrapped Git configuration-spelling
denies is **not fixed by this scope**. Such unsupported forms gain no managed
proof; this is not a claim of universal static deny parity. Env does not override
denies or guarantee approval.

## Repository-aware content proof

The managed historical-file show route is exact `env git`, not bare static show.
Literal log pathspecs can use bare `git` or that exact env lane. The
authority calls `hardenGitInput(input, ctx.cwd)` before gating. Eligible requests are pinned
from the requested revision to immutable `TREEOID:path`, with execution and
object probes both disabling replacements. Exact-path `ls-tree` mode/type checks
are combined with `cat-file` verification of the actual object type. Only blob
modes `100644`, `100755`, `120000` qualify; trees, gitlinks and commit objects do
not. A symlink blob exposes its stored link text, not target contents. The
original request remains subject to its rules after pinning, and the requested
path remains a read candidate.

Log pathspecs produce read candidates for their literal paths without traversing
historical name sets. All proved diff execution, including summary-only forms,
and every diff-related repository/configuration/index/tree/name probe disable
replacement objects with `--no-replace-objects`. Content diff uses bounded
index/tree and changed-name probes. Names returned by Git are retained: no second JavaScript prefix filter
may discard an actual changed path, including under `GIT_ICASE_PATHSPECS`.
Requested pathspecs remain candidates as well.

Content proof supports repository-root execution in conventional non-bare
repositories and linked worktrees. Native Git top-level/gitdir/common-dir
resolution must agree with the conventional `.git` administration layout and,
for linked worktrees, a verified primary-worktree relationship. The primary root
is an additional read candidate; Git administration directories are not added as
user-file candidates. A primary root outside allowed scope can require a
separate external/path decision. Bare repositories, separate-git-dir layouts,
subdirectory execution and unknown relationships decline content proof rather
than guessing the object-store scope.

The effective Git cwd (including leading `cd` and Git `-C`) must stay within the
session working-directory boundary before any Git probe runs; an external cwd
receives no probes and falls back to normal gates. Leading `cd` operands with a
`..` segment, or with a `..` segment in inherited `PWD`, are not proved: Bash
may retain a logical symlink `PWD` different from the physical base. Git `-C` retains physical chdir semantics, including
symlink/`..` resolution. The narrow exception is the
linked-worktree primary-root layout query needed to verify `mainRoot`: it may
run outside that boundary, but does not authorize other probes there. The
verified primary root still receives its own path/external decision.

Presence of partial/promisor configuration declines content proof. Index-reading
commands (`status`, `ls-files`, `diff`) also decline proof when `core.fsmonitor`
or `filter.*.clean`/`filter.*.process` configuration is present, before index/name
probes. Status and all diff forms also decline proof when a submodule found in
the index (or, for diff, the inspected historical trees) is checked out unless
the request explicitly includes exact
`--ignore-submodules=all`. `--submodule=short` only bounds output; it does not
prevent Git from running nested status/index helpers. Configured ignore settings
are not a substitute for that explicit option, and hardening does not silently
add it. Gitlink enumeration uses non-recursive stage/tree records, not nested
status commands. Unknown entries/layouts or an inspection root outside the
session boundary decline proof. These are conservative helper checks, not blanket protection from all
Git configuration, inherited environment or external programs.

Each synchronous probe invocation has a five-second timeout and a 4 MiB output
limit. These probes block the Node event loop while running: cancellation,
timers and other tool handling can be delayed until a probe returns. A tool
call may run several probes; these are not aggregate call limits or an
asynchronous cancellation guarantee.
Proved execution and probes disable lazy fetch, optional locks and paging.
There is
no persisted repository-proof cache; provenance and proof belong to an invocation.

## Intentional hardening and fallback

Supported history log/show execution receives `--no-show-signature`. Metadata
history without explicit pretty/format/oneline receives `--format=medium`, so
`format.pretty` cannot supply an unvalidated default. Historical-file show also
receives `--no-replace-objects`, `--no-ext-diff`, `--no-textconv`; every diff
receives `--no-replace-objects` as well as its required external-conversion,
submodule-output and rename controls. Unsafe
explicit options are not silently removed to manufacture a proof.

These changes are intentional: historical-file and diff replacement semantics
are disabled, the historical-file revision is fixed at hardening time, configured default pretty
output is ignored, and signatures, conversions or rename behavior can differ
where suppressed. Do not promise output equivalence under unsafe configuration
or replacement-dependent behavior. Pinning a historical tree is not a snapshot
or isolation guarantee for the whole repository.

A static diagnostic names unsupported syntax and blocks at that independent
floor. A managed diagnostic explains why a complete read proof is unavailable;
it is **not** an allow/ask/deny verdict and does not change the deciding token,
rule or approval scope. Probe failure, timeout, overflow, unsupported layout or
helper configuration falls back to the ordinary gates. That fallback may deny
under a reader capability ceiling; it does not promise an approval prompt.

## Source and generated copies

The build copies the zero-import grammar unchanged to
`runtime/policy/lib/git-read-grammar.ts` and
`runtime/permission-system/vendor/src/access-intent/bash/git-read-grammar.ts`.
[`scripts/build.mjs`](../../scripts/build.mjs) checks **each copy against the
source digest**, not just against the other copy, before publishing the matched
runtime and its integrity manifest. Never edit generated copies directly.

Changes must preserve Git-only decoding, original-request provenance, the static
query set and the narrow complete-proof wrapper exception. Validation must cover
raw spelling → decoding → hardening → complete program admission → Bash/path/
external gates → static guard, including explicit asks/denies and failed probes;
a grammar boolean or isolated positive proof does not establish that contract.
See [development](development.md#matched-resource-migration) for matched builds
and validation ownership.
