# Cooperative Git permission migration

This is a behavior-change notice for the cooperative worker migration, not a
public release approval. Use [matched resources and a fresh process](development.md#matched-resource-migration);
initialization never replaces existing user policies or managed definitions.
See the current [Git contract](git-read-proof.md).

## Changes to existing workflows

- With the neutral seed, `git status --short`, `git log -1` and
  `git diff --stat` now **ask** for both parent and worker. They no longer get
  the former repository-query automatic allowance. Only the bounded literal
  Git version lane can qualify for fixed-query automatic allowance.
- Worker Git writes no longer have an additional child-only blanket mutation
  deny. Ordinary add/commit and other repository operations follow Bash/path
  permission rules. No blanket Git allow is added.
- Existing broad user allows now have their ordinary scope. For example,
  `git log *: allow` can cover `git log --ext-diff -p`; the retired metadata
  grammar guard no longer narrows that allow. Such a call does not ask, so it
  does not reach Jev or its hard checkpoints. Review broad rules before use,
  especially in repositories with executable Git helpers or configuration.
- **Yolo skips review of ordinary asks**, including worker Git mutations such
  as force-push and hard reset. It skips Jev and its hard checkpoints too.
  This is distinct from the deny-only static guard, selected configured
  denies, directional path restrictions and invalid-config/resource floors,
  which remain enforced. Do not turn on yolo expecting destructive Git asks
  to stay human merely because they have a Jev checkpoint.
- Approval of the complete `env git ...` unit can satisfy a subsequent retry,
  including its selected ordinary inner asks. It is not a grant to an inner
  spelling, extra redirect-buried argv, a configured deny or a path deny.

## Retained safeguards and their scope

Model-requested Git environment prefixes that replace PATH, dynamic loaders
(`LD_*`/`DYLD_*`) or named executable helpers/pagers/editors are rejected by
the deny-only guard. This includes EDITOR, VISUAL and GIT_PROXY_COMMAND as well
as the Git-specific editor/transport variables. This applies to inline assignments and supported `env`
prefixes. It does not rewrite the command or alter an operator's launch
environment. Other assignment-bearing Git asks stay eligible for ordinary
human approval, but cannot be approved solely by Jev. The variable inventory
is bounded, not a complete shell/environment sandbox.

For eligible asks, Jev's existing hard-checkpoint mechanism keeps selected
high-impact operations human: push, hard/merge reset, forced or interactive
clean, path-discarding checkout/restore, forced switch, forced branch/tag
updates and branch deletion (including combined short flags and --delete-merged
with reordered options), stash clear/drop, ref updates and filter-branch, among
the existing checkpoints. Checkout patch groups with attached context counts
(such as `-pU3`) stay human; `-U`/`--unified`/`--inter-hunk-context` values remain
data rather than extra option flags. Bounded destructive long-option
prefixes are recognized at option positions, not after `--` or as required option
values. Ambiguous prefixes may conservatively checkpoint even if Git rejects
them; this is not proof of native acceptance. Checkout bare ref/path operands
and implicit patch/pathspec sources are conservatively human because no
repository probe distinguishes a branch from a path; `checkout -` and ordinary
branch creation remain controls, not claimed data-loss cases.
A checkpoint defers to ordinary approval; it is **not a configured deny** and
does not override an already applicable allow or yolo.

The literal collector adds restrictions for recognized wrapper/absolute Git
spellings, known historical filename suffixes even with an unknown revision or
cwd, explicit outputs and actual redirects. Unknown repository roots stay
unknown; no variable expansion, hidden Git probe, object attribution or
historical content walk is performed. A known filename can still be checked
as a literal restriction without guessing an absolute root. DATA operands
are not reinterpreted as filenames.

There is no complete file-by-file secrecy promise for glob pathspecs, arbitrary
history, bare object IDs, batch pipelines, opaque programs or Git's internal
helper IO. A deny that has been recognized and selected is not erased by
session approval/yolo; this does not prove every dynamic shell spelling will
select the intended rule. In particular, unsupported `command -p` wrappers
and generated subcommand names retain old command-deny recognition gaps.
Do not rely on ordinary Git access for complete historical-content separation.

Git command bytes, executable selection, environment and leading `cd` remain
unchanged. No zero-write, zero-lock, automatic retry, OS isolation or hidden
execution-hardening guarantee is introduced.
