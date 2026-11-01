# Optional Agent workspaces

The model-facing choices are independent:

- `profile: "worker" | "researcher"` selects tools/capabilities. Worker maps to
  the stable internal `editor` profile ID. No legacy profile aliases or
  capabilities are supported.
- `workspace: "shared" | "worktree"` selects the working copy. Omission means
  shared. Both profiles can select either mode. Neither is an OS sandbox.

A worker may read/edit, use Bash/Git and run builds under normal permissions
in its **assigned workspace**, not necessarily the shared checkout.
A review-only assignment is an instruction, not an enforced readonly ceiling.
Researcher keeps its read-only file tools and web tools, without Bash/edit/write.
Basic credential/resource protection and user-configured denies remain.

## Shared

The Agent uses the original cwd, including uncommitted files and existing build
outputs/dependencies. There is no copy or setup cost. The parent coordinates
concurrent edits and Git use through task ownership and ordinary workflow.
No child-only blanket Git mutation ban is imposed on workers.

## Worktree

`agent_spawn({ ..., workspace: "worktree" })` asks the trusted runtime to create
a private detached worktree when the Agent actually starts. Queueing,
argument preparation and accepted-request replay do not create a worktree.
Creation resolves a local HEAD commit and records it; it never creates a named
branch, contacts a remote, merges or commits. Unsupported/failed setup fails
visibly, never silently falls back to the shared cwd.

The working copy is retained for that Agent's follow-ups and answers. Workspace
cannot be changed by `agent_run`, steering or routing changes. The child is told
its actual cwd and baseline. Wait/read/list expose confirmed binding and small
observed retained-path summaries as described below; shared and unbound tasks
omit `workspace`. Queries add the bounded `workspace_pending: true` control only
while a queued/running task awaits binding, has not exited and has no recovery
facts. It does not promise eventual creation. The detail pane renders observed
recovery facts, without inventing a working cwd/base or relying on an error-message
tail.

Only the committed baseline is checked out, including any configuration files
already tracked there; checkout is not a secret-scrubbing export. Current
uncommitted changes, untracked/ignored files, installed dependencies and build
caches are **not copied**. Host/user credentials and settings are not copied into
the worktree. To inspect pending local changes, use shared mode. The parent must
choose how to prepare dependencies and explicitly integrate accepted results;
there is no automatic installation, patch transfer or merge.

Source project instructions/settings and permission configuration are inherited
from the admitted source cwd. A checked-out `.pi` directory cannot silently
replace that source policy. Tool paths and execution resolve against the actual
worktree cwd. The authority's live per-session binding maps the **whole known
checkout root** to its source repository root, including sibling paths above a
nested cwd. These aliases add deny/ask restrictions only, never imported ALLOW
rules or execution/external-directory exemptions. Source configuration discovery
still uses the admitted source cwd; it is not moved to the repository root.
Other checkouts are not mapped by that binding and retain ordinary external
policy (normally ask under the seed at the default state location). Explicit
external allows, session grants and yolo still apply to ordinary asks; worktrees
are not cross-session content isolation.

## Dispatch paths and binding

All relative `dispatch.inputs`, `ownership` and `tree` paths resolve from the
Agent's **execution cwd**, just like its tools. Absolute paths keep their
meaning; use them to reference the source checkout or another explicit location.
For a nested source cwd, the worktree execution cwd preserves that subdirectory,
not the checkout root. A first worktree task can declare relative inputs,
ownership and a build tree together; no preliminary spawn/list/run is needed.
Source cwd remains the authority/settings inheritance base, not the dispatch
path base. The child dispatch preface names both roles.

Before a worktree is initialized, all relative declarations, including
`../foo`, are provisional Agent-local paths. Source candidates receive deny-only
preflight (including applicable external-directory surfaces), never source
existence checks or imported ALLOW. Different Agents' provisional resources
have no known overlap yet; that is not proof of disjointness. Absolute paths
receive ordinary checks immediately. Preparation, admission and replay allocate
no worktree. A source-candidate deny can conservatively reject even an escaping
relative declaration such as `../outside` before its actual worktree target is
known. The error identifies provisional source preflight, not a confirmed
worktree path; do not bypass it by dropping declarations or trying another alias.

After successful session/workspace binding and before history begin or child
input, runtime resolves real lexical/canonical paths, checks actual input
existence and tree type, actual external boundaries and permissions, and source
restriction aliases through the live authority binding. Core rechecks active
claims before acquiring any tree lease. This is a one-time refinement of
provisional claims to real resources. Already-bound ownership/tree resources
cannot change, and subsequent pump/answer checks require strict equality of
those claimed resources. Inputs are not resource locks: each check revalidates
the declared inputs' actual paths, permissions and existence, allowing an
`after` task's predecessor to produce an input symlink without freezing its old
target. Every prepared field must still correspond to its literal declaration.
See [task dispatch](task-dispatch.md) for admission and claim lifecycle.

A post-binding preflight failure fails that task, but keeps an already-created
healthy session idle and reusable. Input missing, wrong tree type, permission
deny and resource conflict remain distinct errors. In particular, source dirty
or untracked inputs do not appear in a committed worktree. Setup/SDK assembly
failure is different and retains observed recovery facts under the existing
cleanup rules. Checks observe the actual execution cwd, not proof that source
was tested; source-state capture may remain unknown for linked layouts.

Eligible forwarded worktree asks currently defer from Jev as
`delegation_unbound` to ordinary human handling: its review evidence is still
source-cwd-based. Do not relax the cwd comparison alone. This does not affect
existing configured allows or yolo, which can satisfy ordinary asks before Jev.

## Workspace and recovery metadata

Only `agent_wait`, `agent_read` and `agent_list` expose a confirmed worktree
`workspace`, describing the **original task**, never a later Agent binding:

```ts
interface TaskWorkspace {
  mode: "worktree";
  cwd: string;
  source_cwd: string;
  base_commit: string;
  checkout_root?: string;
}
```

These are the four success-binding fields plus optional checkout root. `cwd`
can be below `checkout_root` for a source subdirectory. Shared or unbound tasks
omit `workspace`; no public `state`, `recovery_manifest` or recovery-state matrix
is exposed. Ordinary action, interrupt and kill replies omit workspace details.
SDK assembly failure never fabricates a successful execution binding.

Failures may expose `retained_paths` with at most two entries: an observed
private allocation directory or verified checkout root, plus a created manifest.
An intended nonexistent checkout target is not shown. A manifest pointer is not a
durability claim; a verified checkout may still precede failed SDK assembly.
Paths grant no execution or permission authority and trigger no retry/hydration.
Internal recovery transport retains typed, frozen errors and cleanup authority.
The human detail pane displays observed allocation/manifest locations on partial
failure, and verified checkout/cwd/base on checkout-ready assembly failure. It
distinguishes retained files from a usable initialized session; neither rendering
nor recovery facts fill a missing successful workspace binding. This public
simplification does not remove retained artifacts.

Whole optional fields may yield under the 65536-byte cap with
`response_limit_reached`, rather than clipping paths. Result text is fitted before
optional location fields; bounded controls, including workspace_pending, remain
reserved. There is no metadata view,
new details flag or metadata cursor, and no guarantee that repeated reads can
recover an overlarge optional path. The read-only task selector and real result
paging remain, including after kill within this Owner; see
[result cursors](tool-contract.md#result-cursors).
`agent_list` lists only bounded killed names, not a full history dump.

## Retention and cleanup

Worktrees default to `$XDG_STATE_HOME/pi-alehouse/worktrees`, or
`~/.local/state/pi-alehouse/worktrees` when XDG_STATE_HOME is absent or relative.
Each allocation has a private directory outside the protected Pi agent directory.
No existing user file, symlink or directory permissions are replaced to make it
usable. Once opened, a private recovery manifest records observed allocation,
source and eventual baseline/stage facts, including retained partial failures.
A failure before opening it has no manifest pointer; an intended checkout target
is not proof that it exists. Do not put credentials in that manifest.
This is persistent default placement, not an unlimited-retention, backup or
power-loss guarantee: custom state locations may be volatile or broadly allowed.
Loss/removal of a detached worktree can leave its unique commits reclaimable by
later Git prune/gc; preserve accepted work explicitly.

There is deliberately **no automatic worktree deletion** on completion, stop,
kill, failed assembly or Owner shutdown. Session release revokes session-bound
authority; it is not acceptance of edits or proof that every descendant process
has exited. Paths remain available for inspection/manual recovery. After the
work has stopped and results have been accepted or explicitly discarded, an
operator can remove the worktree using ordinary Git management. Never force
remove an unknown/dirty worktree as incidental cleanup.

## Limits

Separate worktrees have separate indexes and working files; they still share
objects, most refs and configuration. Programs can access other host paths,
main-worktree files or shared repository state. No strict readonly, zero-lock,
complete file-by-file historical secrecy, hard process termination or OS
isolation guarantee follows. The helper's own fixed Git invocation is not an
execution rewrite of a worker's later Bash request.

The authority registry accepts at most 4096 cumulative successful worktree
session bindings per Pi process, including bindings whose later assembly fails.
Release leaves a tombstone so stale contexts cannot revert to cwd-based policy;
it does not restore registry capacity. At the limit new worktree assembly fails
visibly. After confirmed Owner closure, use a fresh Pi process; there is no
registry eviction, retry/force-release endpoint or supported live reload.

Creation requires a verified absolute Git. The launcher checks `/usr/bin/git`,
`/bin/git`, and `/run/current-system/sw/bin/git`, or an explicit absolute
`PI_HARNESS_GIT`; it never searches project PATH. Shared mode needs no Git, but
worktree setup fails visibly if none is available. The primary worktree tests
require this dependency too; see [development](development.md#tests-and-scope).

Only controlled local fixtures are part of the default validation. No real
provider, remote Git, human approval, installation or deployment is implied.
Changes require matched generated resources and fresh Pi processes; no hot
replacement of a running Owner and no automatic rewrite of user definitions.
