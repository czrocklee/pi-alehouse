# Optional Agent workspaces

The model-facing choices are independent:

- `profile: "worker" | "researcher"` selects tools/capabilities. Worker maps to
  the stable internal `editor` profile ID. No legacy profile aliases or
  capabilities are supported.
- `workspace: "shared" | "worktree"` selects the working copy. Omission means
  shared. Both profiles can select either mode. Neither is an OS sandbox.

A worker may read/edit, use Bash/Git and run builds under normal permissions.
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
its actual cwd and baseline. Worktree rows in `agent_list` expose these facts
after successful initialization; a shared row omits `workspace`. The detail pane
shows either mode. Without confirmed metadata the worktree state is
`uninitialized`, including after failed setup, not a promise of later creation.
No working cwd or base is invented; partial retained paths remain in the error.

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

Relative dispatch paths retain their existing **source cwd** base. An
uninitialized worktree Agent cannot declare `dispatch.tree`: start without it,
then use the actual absolute path from `agent_list` on a follow-up. Checks
without a tree may be declared on the first task. Use actual absolute paths
for worktree outputs once known; declarations never grant permission. Checks
observe execution cwd, not a claim that source was tested; source-state capture
may remain unknown for linked layouts.

Eligible forwarded worktree asks currently defer from Jev as
`delegation_unbound` to ordinary human handling: its review evidence is still
source-cwd-based. Do not relax the cwd comparison alone. This does not affect
existing configured allows or yolo, which can satisfy ordinary asks before Jev.

## Retention and cleanup

Worktrees default to `$XDG_STATE_HOME/pi-alehouse/worktrees`, or
`~/.local/state/pi-alehouse/worktrees` when XDG_STATE_HOME is absent or relative.
Each allocation has a private directory outside the protected Pi agent directory.
No existing user file, symlink or directory permissions are replaced to make it
usable. A private recovery manifest records allocation, source and baseline,
including retained partial failures. Do not put credentials in that manifest.
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

Creation requires a verified absolute Git. The launcher checks `/usr/bin/git`,
`/bin/git`, and `/run/current-system/sw/bin/git`, or an explicit absolute
`PI_HARNESS_GIT`; it never searches project PATH. Shared mode needs no Git, but
worktree setup fails visibly if none is available. The primary worktree tests
require this dependency too; see [development](development.md#tests-and-scope).

Only controlled local fixtures are part of the default validation. No real
provider, remote Git, human approval, installation or deployment is implied.
Changes require matched generated resources and fresh Pi processes; no hot
replacement of a running Owner and no automatic rewrite of user definitions.
