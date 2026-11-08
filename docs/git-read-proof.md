# Git commands in cooperative workers

Workers are cooperative local developers, not a readonly execution sandbox.
`worker` is the model-facing name of the stable internal `editor` profile. See [security](security.md).

## Original command and normal permission

The model's Git command, environment, executable selection and leading `cd`
remain unchanged on allow, ask and deny. No injected flags, pinned objects,
forced format, hidden environment override or execution-rewrite audit. Existing
non-Git hardeners remain separate; a mixed program must not rewrite a shared
leading `cd` when Git is present.

There is no blanket Git allow, and no worker-specific blanket Git mutation
ban. Ordinary repository queries and mutations use normal Bash permission.
Only the bounded literal Git version form can qualify for automatic fixed-query
allowance; with the neutral seed, `git status --short`, `git log -1` and
`git diff --stat` ask for both parent and worker. Git add/commit and other
writes never gain a readonly shortcut.
Explicit configured command denies/specific asks, path checks, external-directory
checks, basic dangerous-operation guards and immutable resource protection
remain. Scout (internal `researcher`) has no model-facing Bash/edit/write tools.
That ceiling does not describe upstream web subprocess or cache effects; see
[researcher web access](security.md#researcher-web-access). No live user definition or
policy is overwritten by building this package.

Dangerous model-requested PATH/loader/helper environment prefixes remain a
deny-only guard concern, including requested EDITOR, VISUAL and GIT_PROXY_COMMAND
prefixes, never the operator's inherited environment. Inline assignments before
an allowed non-Git command are not guard refusals but a
[static-allow exclusion](security.md#static-guard-static-allow-exclusion-and-redirect-targets):
the allow is set aside and the call takes ordinary approval. Other assignment-bearing
Git asks and selected high-impact Git asks defer to human approval instead of
model-only Jev review. The checkpoint inventory covers push, hard/merge reset,
forced or interactive clean, path-discarding checkout/restore, forced switch,
forced branch/tag updates, branch deletion (including combined short flags and
reordered `--delete-merged`), stash clear/drop, ref updates and filter-branch.
Patch groups with attached context counts (such as `-pU3`) stay human, while
`-U`/`--unified`/`--inter-hunk-context` values remain data. Bounded destructive
long-option prefixes are recognized at option positions, not after `--` or as
required option values; ambiguous prefixes may conservatively checkpoint even
if Git would reject them. Checkout operands that could be paths, implicit patch
mode and pathspec-file input conservatively checkpoint without repository IO;
previous-branch `checkout -` and ordinary branch creation are not claimed
destructive cases. Option values and `--` keep their argv roles. These
checkpoints apply to asks, not existing allows or yolo; a checkpoint defers to
ordinary approval and is not a configured deny. They are not a second Git
authorization matrix.

Raw global/project/agent/project-agent Bash restrictions are checked before
session composition. A selected explicit deny is not erased by a recorded
Bash grant or yolo. Ordinary asks retain the configured approval behavior,
including yolo; invalid-config fail-closed asks remain distinct. Existing broad
user allows keep their ordinary scope: `git log *: allow` can cover
`git log --ext-diff -p`, and such a call never asks, so it never reaches Jev
or its hard checkpoints. Review broad rules before relying on them, especially
in repositories with executable Git helpers or configuration. Session yolo
satisfies ordinary asks — including worker Git mutations such as force-push
and hard reset — and skips Jev review and its checkpoints; the deny-only static
guard, selected configured denies, directional path restrictions and
invalid-config/resource floors still apply. Approval of a complete
`env git ...` unit can satisfy a subsequent retry, including its selected
ordinary inner asks; it is not a grant to an inner spelling, extra
redirect-buried argv, a configured deny or a path deny.

## Limited literal inventory, not historical provenance

`src/authority/managed-git-query.ts` keeps a bounded literal inventory of
identifiable file operands, historical `rev:path` spellings and explicit output
files. It does **not** execute Git subprocesses to discover historical file
ownership, replay commit selection, list trees, resolve blob provenance or
classify helpers/configuration. There is no complete file-by-file protection
claim for arbitrary Git history, bare object IDs, patch output or batch stdin.
Unsupported `command -p` wrappers and generated subcommand names retain
command-deny recognition gaps. Allowing ordinary Git access exposes repository
history under this cooperative contract; do not delegate repositories that
require such content separation.

Actual redirects, output writes and sibling commands retain their independent
facts. The general redirect-buried-argv recovery remains: consume only the
actual redirect destination, keep later argv in order and with operand roles.
Completed spellings can add asks/denies, never ALLOW or a truncated-command
shortcut. Literal historical paths can use safely observed conventional
filesystem repository-root aliases; unknown roots remain unknown, not guessed.
Recognized query argv effects do not grant permission or globally relabel
unknown commands as reads.

The former history/object attribution probes and
`<managed-git-unattributed>` workflow are retired. They are not replaced by a
new model judge, a mandatory human review of every unknown form, or another
per-Git-subcommand authorization matrix. Existing journals remain literal
historical evidence, not current authorization.

The speculative HOME-stability fold is also retired. Dynamic `cd` targets keep
the ordinary unknown-base behavior rather than fabricating a certain cwd.

## Index locks and limits

Agents share the parent's working directory. Alehouse does not create or manage
worktrees; ordinary Git commands remain subject to normal permissions.

Native Git can update index caches and use locks. No physical zero-write,
automatic retry or safe lock deletion claim is made. An operator may explicitly
choose `GIT_OPTIONAL_LOCKS=0` when launching; the product does not inject it into
worker commands. That setting affects the whole process, not required writer
locks or every helper's IO.

## Source and validation

Shared literal grammar remains in `src/extensions/lib/git-read-grammar.ts`.
`scripts/build/patches/native-git-patch.mjs` integrates the inventory;
`scripts/build/patches/native-git-restrictions-patch.mjs`
retains raw-scope restrictions. The `hardenNonGitInput` API does not
rewrite Git. Generated copies are not source.

Tests distinguish the new cooperative contract from retired historical-provenance
expectations. A permission allowance is not requested-command execution.
Run a matched fresh build, focused runtime regressions, the package gate and
portable policy tests. Local evidence is not public release or deployment
acceptance. Installation requires separate authorization and fresh processes.
