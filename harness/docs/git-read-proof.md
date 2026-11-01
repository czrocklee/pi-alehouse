# Git commands in cooperative workers

Workers are cooperative local developers, not a readonly execution sandbox.
`worker` is the model-facing name of the stable internal `editor` profile. See [security](security.md) and
[workspaces](workspaces.md).

See the [migration notice](git-permission-migration.md) for query auto-to-ask,
broad user allows, worker mutations and yolo/checkpoint behavior changes.

## Original command and normal permission

The model's Git command, environment, executable selection and leading `cd`
remain unchanged on allow, ask and deny. No injected flags, pinned objects,
forced format, hidden environment override or execution-rewrite audit. Existing
non-Git hardeners remain separate; a mixed program must not rewrite a shared
leading `cd` when Git is present.

There is no blanket Git allow, and no worker-specific blanket Git mutation
ban. Ordinary repository queries and mutations use normal Bash permission.
Only the bounded literal Git version form can qualify for automatic fixed-query
allowance. Git add/commit and other writes never gain a readonly shortcut.
Explicit configured command denies/specific asks, path checks, external-directory
checks, basic dangerous-operation guards and immutable resource protection
remain. Researcher has no Bash/edit/write tools. No live user definition or
policy is overwritten by building this package.

Dangerous model-requested PATH/loader/helper environment prefixes remain a
deny-only guard concern. Other assignment-bearing Git asks and selected
high-impact Git asks defer to human approval instead of model-only Jev review.
These checkpoints apply to asks, not existing allows or yolo; they are not a
second Git authorization matrix.

Raw global/project/agent/project-agent Bash restrictions are checked before
session composition. A selected explicit deny is not erased by a recorded
Bash grant or yolo. Ordinary asks retain the configured approval behavior,
including yolo; invalid-config fail-closed asks remain distinct.

## Limited literal inventory, not historical provenance

`permission-system/managed-git-query.ts` keeps a bounded literal inventory of
identifiable file operands, historical `rev:path` spellings and explicit output
files. It does **not** execute Git subprocesses to discover historical file
ownership, replay commit selection, list trees, resolve blob provenance or
classify helpers/configuration. There is no complete file-by-file protection
claim for arbitrary Git history, bare object IDs, patch output or batch stdin.
Allowing ordinary Git access exposes repository history under this cooperative
contract; do not delegate repositories that require such content separation.

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

## Worktrees, index locks and limits

Optional worktrees have independent checked-out files and indexes. They reduce
ordinary shared-file/index contention, but still share repository objects,
most refs and configuration. They are not OS isolation, a secrecy boundary,
or a promise of no conflicts. Git is not confined to the selected cwd by the
worktree option.

Native Git can update index caches and use locks. No physical zero-write,
automatic retry or safe lock deletion claim is made. An operator may explicitly
choose `GIT_OPTIONAL_LOCKS=0` when launching; the product does not inject it into
worker commands. That setting affects the whole process, not required writer
locks or every helper's IO.

## Source and validation

Shared literal grammar remains in `extensions/lib/git-read-grammar.ts`.
`native-git-patch.mjs` integrates the inventory; `native-git-restrictions-patch.mjs`
retains raw-scope restrictions. The compatibility `hardenGitInput` API does not
rewrite Git. Generated copies are not source.

Tests distinguish the new cooperative contract from retired historical-provenance
expectations. A permission allowance is not requested-command execution.
Run a matched fresh build, focused runtime regressions, the package gate and
portable policy tests. Local evidence is not public release or deployment
acceptance. Installation requires separate authorization and fresh processes.
