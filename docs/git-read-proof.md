# Git commands in cooperative workers

Use ordinary Git in the parent or a `worker` (internal `editor`). A review-only
task is not a read-only Git environment. Scouts have no model-facing Bash;
see [scout web access](security.md#researcher-web-access) for separate web helper
effects.

## Original command and normal permission

Repository queries and mutations use normal Bash approval. The neutral seed
asks for `git status --short`, `git log -1` and `git diff --stat` in both the
parent and worker. Only bounded literal Git version queries can qualify for
the automatic fixed-query lane; repository queries do not. There is no blanket
Git allow, worker-only blanket mutation deny, or second authorization matrix.
The Git command, environment, executable selection and leading `cd` are not
rewritten. Hardening a non-Git command does not rewrite a `cd` shared with Git.

Selected denies and specific asks in the raw global, project, agent and
project-agent Bash scopes remain relevant before session composition. A
selected deny survives session grants and yolo. Directional path checks,
external-directory approval and [safety floors](security.md#model-tool-policy)
still apply. Invalid configuration can leave a fail-closed ask which yolo
cannot satisfy.

**Review broad allows before using them.** An applicable allow does not reach
Jev or its checkpoints. Yolo also skips Jev on ordinary asks, including Git
writes. For eligible asks, Jev defers assignment-bearing or high-impact Git
requests to a human; a checkpoint is not a deny. The separate deny-only guard
can block selected execution-environment prefixes explicitly requested by the
model. It is not a check of the operator's inherited environment.

## Limited literal inventory, not historical provenance

The classifier recognizes bounded literal file operands, historical `rev:path`
spellings and explicit output files. It can use safely observed conventional
repository-root aliases; an unknown root stays unknown. These facts add
restrictions, not grants. Actual redirects, output writes and sibling commands
are checked independently. Arguments recovered after a redirect can add an ask
or deny, never an allow based on an incomplete command. A dynamic `cd` leaves
an unknown base for ordinary external-directory checks.

Classification does not run Git, walk objects or attribute content to historical
files. Path denies are useful for identifiable files, but do not track arbitrary
history, bare objects, patch output or batch input. They do not govern all
internal Git IO or helper behavior. **Do not delegate a repository that needs
file-by-file separation of historical content.**

## Index locks and limits

Parent and children share the working directory. Coordinate edits, staging and
other repository writes; Alehouse does not create or manage worktrees. Separate
worktrees can reduce same-index contention, but share objects, most refs and
configuration.

Native Git can refresh index caches and take locks, even during queries. There
is no zero-write promise, automatic retry or safe lock deletion. An operator
can choose `GIT_OPTIONAL_LOCKS=0` at launch; Alehouse does not inject it. It does
not disable required writer locks or all IO. If a lock is present, inspect and
coordinate with the potential writer rather than deleting it to make work proceed.

The optional [execution-start source observation](task-dispatch.md#execution-start-observations)
for declared checks uses trusted absolute Git in a separate bounded process.
It is advisory metadata, not command classification, execution proof or an
atomic repository snapshot.
