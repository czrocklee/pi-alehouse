# Security and authority boundaries

Pi Alehouse's harness composes authority; it does not replace it. The patched
permission-system 32.0.3 runtime, generated worker definitions, static safety
guard, search policy, and optional Jev review policy remain outside the internal
harness and are loaded by the trusted `pi-alehouse` launcher.  A task prompt, profile name, model choice,
or UI state cannot grant a new permission or weaken a path/tool restriction.

## Explicit process and tool boundary

The root manifest has `pi.extensions: []`: neither the source `composition.ts`
nor the launcher is automatically loaded by Pi or installed as an extension via
`pi install`. The CLI starts host Pi with `--no-extensions -e` and an explicit
absolute `composition.ts` path, rejecting additional extension paths. It supplies
matched generated authority/policy paths and an absolute trusted util-linux
`flock`; direct harness extension loading without the launcher fails rather than
guessing paths. Parent web integration uses package-local pinned `pi-web-access`
0.35.0; only `researcher` children receive web tools (below). The CLI does not make a temporary npm install,
copy authentication, overwrite existing user resources, or enable arbitrary
extension discovery. Explicit initialization creates only absent resources;
the neutral routing catalogue defaults to `off`. Install a **built tarball** with
`--omit=dev --legacy-peer-deps --ignore-scripts` to avoid pulling a second Pi
SDK/runtime through dependency peer auto-installation; the host Pi is separate.

The parent's four web tools stay subject to the global permission policy.
Children receive only their profile's local `read`/Bash/search/edit tools as
filtered by the harness, plus fixed `alert_parent`/`ask_parent`. `notify_parent`
is retired and explicitly denied, not a runtime alias. They receive
no parent management tools, no nested delegation and no arbitrary extensions.
Worker (`editor` internally) receives no web tool table. Tool availability is
never network authorization. Plain `pi` has no delegation tools at all.

New model requests select `worker` or `researcher`. Worker maps to the stable
internal `editor` profile ID. No legacy profile aliases or capabilities are
supported. Either public profile can use
[shared or worktree mode](workspaces.md), independently of its tools.

| Public profile | Capability | Meaning |
| --- | --- | --- |
| `worker` (`editor` internally) | local read/edit/write/Bash/Git/builds | cooperative developer under normal permission; no web and no strict readonly promise |
| `researcher` | read-only file tools and four web tools; no Bash/edit/write | web-derived material is untrusted |

Worker has no extra child-only blanket Git mutation ban and no automatic Git
allow. Review-only work is a task instruction. User-configured command/path denies and base credential/resource/high-risk
protections remain; generated policy never overwrites live user configuration.

### Cooperative Git commands

The [migration notice](git-permission-migration.md) lists concrete changes to
seed queries, broad user allows and yolo. Selected PATH/loader/helper prefixes
requested by the model retain a deny-only guard. Other assignment-bearing Git
asks and selected destructive Git asks have Jev hard checkpoints, not an
additional per-operation permission system. The selected prefix deny inventory
includes EDITOR, VISUAL and GIT_PROXY_COMMAND as well as Git-specific editor,
pager and transport helpers; it examines requested prefixes, not inherited
environment. Checkpoints defer eligible asks to
ordinary human approval; they do not run for an existing allow or under yolo.

The current contract is [literal Git restrictions](git-read-proof.md): repository
queries and writes use ordinary Bash permission, with no Git subprocess probing
or historical file-provenance claim. Only bounded literal version queries can
qualify for the automatic fixed-query lane. Raw configured Bash denies/specific
asks, explicit path/output facts and actual redirects remain independent.
Worker Git mutations do not receive a readonly shortcut. Worktree selection is
not a grant; source project policy is inherited while tool paths resolve at the
actual child cwd. See [workspaces](workspaces.md).

There is no complete historical-content separation promise for a worker with
ordinary Git access. Literal path denies remain useful protection, not a data
taint tracker for repository objects. A selected configured deny survives session
grants/yolo; ordinary asks keep ordinary approval, and invalid configuration
still fails closed. Researcher has no Bash tool and keeps its profile ceiling.

Git commands are never silently rewritten. Native index cache writes and locks
remain possible; separate worktrees reduce same-index contention but share
objects, most refs and configuration. No zero-write, automatic retry, safe lock
removal or freedom-from-conflicts claim is made. The host's fixed worktree setup
commands are separate from the worker's unchanged Bash execution. Ordinary Git
is not reauthorized through a second per-operation effect matrix.

### Workspace binding and retention

Spawn fixes shared (default) or worktree mode independently of profile; neither
lets the caller choose an arbitrary directory. Runtime creates a private detached
worktree only at actual execution/session initialization, pinned to a
recorded local HEAD commit. Admission, preparation and replay create none. Setup
failure is visible, never silent shared fallback. No dirty/untracked/ignored
files, installed dependencies or build caches are transferred, nor host/user
credentials or settings. Committed configuration files remain in the checkout;
this is not a secret-scrubbing export. There is no automatic install, patch
transfer or merge.

The child's actual cwd is its workspace. Core admission and source `settings.cwd`
remain immutable; source project instructions, settings, permission configuration
and trust are inherited through a live binding. Checked-out `.pi` content cannot
replace source authority. The trusted whole checkout root maps to the source
repository root for restriction aliases, including siblings above a nested cwd.
Aliases add deny/ask only, never ALLOW or external-directory exemptions. Other
checkouts keep ordinary external policy, not inherited source deny. Relative
dispatch paths use execution cwd; source cwd remains the policy/settings base.
First-task worktree inputs/ownership/tree can be relative, including `..`.
Before binding, source candidates are deny-only checks, not existence or ALLOW
facts; provisional paths are not proof of disjoint resources. Binding performs
actual canonical/boundary/permission/input/claim checks before child input, using
the live authority-owned alias seam, not a caller-supplied root. A healthy
session survives a binding preflight failure idle/reusable. See
[workspace binding](workspaces.md#dispatch-paths-and-binding). Checks observe
actual child cwd. Only wait/read/list expose whole
Run-local confirmed workspace bindings: four fields plus optional checkout root,
without public state or recovery_manifest. Queries reserve a bounded
workspace_pending:true control for queued/running worktree tasks still awaiting
binding, not exited tasks or tasks with recovery facts. Ordinary
action/interrupt/kill omit workspace details. Failures may expose small retained_paths containing observed
allocation directories, verified checkout roots and created manifests, never an
intended nonexistent target. Verified checkout can precede failed SDK assembly;
no later Agent baseline fills an earlier task's missing binding. Internal
recovery transport preserves typed/frozen errors and cleanup authority. The human
detail pane renders those observed retained locations without promoting them to
successful session binding. Optional paths fit after result text and may yield
whole under the cap, without a metadata-retrieval mode or unlimited recovery
promise. See [workspace metadata](workspaces.md#workspace-and-recovery-metadata).
Linked-layout source-state capture may stay unknown.

Worktrees and private recovery manifests are not deleted on completion, kill,
failure or shutdown. Default storage is XDG_STATE_HOME/pi-alehouse/worktrees
(absolute XDG_STATE_HOME only, otherwise ~/.local/state), outside agentDir and not
TMPDIR. This restores ordinary external-directory asks for cross-session reads
under the seed, not forced isolation against configured allows/grants/yolo.
Persistent placement is not backup or perpetual retention; custom volatile or
broadly allowed state locations can differ. Session release revokes bound authority; it does not delete files,
accept edits or prove all descendants exited. Cleanup is manual, after work has
stopped and results are accepted or explicitly discarded; no new cleanup tool
exists. Separate indexes/files reduce contention, but objects, most refs and
configuration remain shared. Worktree mode does not confine Git or provide
strict readonly, historical secrecy, zero locks or OS isolation. See
[workspaces](workspaces.md).

### Redirect-buried argv and home `cd`

The pinned parser buries words after a redirect destination (`cmd 2>/dev/null
a b`, `cmd <<EOF a`) in the redirect node, while Bash passes them to the
command. They take the owning command's token roles and effect over its
completed argv; the real destination keeps its redirect effect. The completed
spelling is classified afresh and can add a command-rule ask or deny, never an
allow or floor exemption, so a truncated exact allow cannot approve hidden
argv. Only the last command of the redirected body owns a tail; a tail after a
compound command keeps the destination effect. Literal Git argv roles do not
grant permission or globally relabel unknown commands as reads. The speculative
login-home `cd ~` stability inference is retired. Dynamic `cd` targets leave
relative paths at an unknown base: an ordinary external ask,
which yolo can satisfy. This is deliberately not an arbitrary-shell guarantee.

### Researcher web access

`researcher` is the only profile with web tools, and has no Bash, so its only
effects outside file reads are the web tools themselves.  They keep the global
permission rules: the seeded policy asks for `web_search`, `source_check` and
`fetch_content` and allows `get_search_content`.  Its generated definition adds
no web rule.  Forwarded child asks reach the parent's human approval, or Jev
where the approval mode enables it for subagents; Jev never auto-allows
`fetch_content`.  Local reads keep the normal secret-path denies and
external-directory asks.

pi-web-access itself limits fetches to `http(s)`, blocks loopback, private,
link-local (including cloud metadata), CGNAT and multicast targets after DNS
resolution, revalidates every redirect, restricts `auth` to configured
per-host profiles, and replaces inline `data:` payloads in fetched text.  It
does not inspect what a URL or query carries.

The residual risk is deliberate: a researcher reads both project files and
untrusted pages, and a URL or query can carry data out to any public host.
Keep `fetch_content` approval human, or do not use `researcher` on projects
whose contents must not reach the network.  pi-web-access's
`fetchContent.domainPolicy.allow` in `web-search.json` limits `fetch_content`
to listed hosts for the parent and every researcher alike; the harness does not
set it.  Its prompt treats web content as data, not instructions,
and forbids putting local contents into URLs or queries; that is guidance, not
enforcement.  Treat its results as web-derived and untrusted.

The harness enforces the rest:

- The child loads its own pi-web-access instance (a query-keyed ESM import of
  the launcher-verified entry, checked to differ from the parent's). The
  extension keeps stored results and pending fetches in module scope and clears
  them on session start/shutdown, so a shared instance would cancel the
  parent's fetches and drop its stored results.  Instances are reused only
  after a confirmed child shutdown.
- A native import bypasses the host's extension loader, and production installs
  omit the Pi SDK.  The entry's own imports of the Pi SDK and TypeBox therefore
  resolve, through a process-wide Node module hook, to the modules the host
  supplied to the harness (the same export values, re-exported); any other host
  module fails the import.  The
  hook only acts on imports from an entry the harness tagged (its URL carries
  `alehouse-host=<generation>`); it stays installed for the process.
- `fetch_content` has no `auth` (browser-cookie) parameter and accepts only
  absolute `http(s)` URLs.  Upstream accepts local video paths (by extension,
  default 50 MB) and uploads them for analysis or extracts frames, outside the
  path permission gates; a researcher cannot. Its adapted fetch description and
  URL/timestamp/frame parameter descriptions do not promise local-video access.
  Assembly rejects drift in the required upstream local-video description
  rewrite; URL/schema and execution checks enforce the input boundary separately.
- `web_search`, `source_check` and `fetch_content` have no `proxy` parameter.
  Upstream checks only its scheme, not its host, so a model-chosen proxy could
  reach loopback or private services, or bypass the configured proxy.  A proxy
  configured in `web-search.json` still applies.
- These three schemas are closed (`get_search_content` is left as upstream
  registers it): violations fail validation before any permission prompt, and
  execution checks again.
- The dynamic `web_enable` loader is not registered, so the admitted child tool
  table cannot change; background-fetch notices never start a model turn outside
  a Run.  Renamed or disabled web tools fail researcher assembly.
- Curator review has no UI in a child and resolves to no curator.

One approved call can still do more than fetch a page.  These are upstream
pi-web-access behaviors the harness does not restrict; the approval prompt
shows only the tool input:

- A `github.com` repository URL is cloned (by default when the repository is
  small, always with `forceClone`) with `gh repo clone`, using the user's
  stored `gh` credentials, or `git clone`, into `/tmp/pi-github-repos`; issue
  and pull-request URLs are read with `gh`.  A private repository the user can
  access is therefore readable, and outside the path permission gates.
  `githubClone.enabled: false` in `web-search.json` turns cloning off for the
  parent and every researcher.
- YouTube URLs run `yt-dlp`/`ffmpeg`.  If `allowBrowserCookies` (or
  `PI_ALLOW_BROWSER_COOKIES=1`) is set, the Gemini Web path reads local Chrome
  cookies for Google origins; removing `auth` does not remove this path.
- `mode: "answer"` with `answerModel`, video/YouTube analysis, and summary
  workflows send fetched content to another configured model, outside the
  child's routed model and its accounting.
- Fetched pages are cached for an hour in `<agent dir>/web-search-cache`,
  shared by the parent and every researcher and kept after the session ends.
- SSRF checks resolve the host before connecting and the connection resolves it
  again, so a rebinding DNS record can pass validation and reach a private
  address.
- The launcher checks the pinned pi-web-access version and location, not a
  digest of its code.

The profiles express enforced capabilities, not work roles, model tiers, or
permission grants.  They share policy body; they do not pin a model, thinking,
turn budget, or context inheritance.  Generated profile integrity and static
Bash denies are checked by the external authority.  Existing sensitive paths,
external writes, subprocess restrictions, Git configuration protections, and
permission-search rules continue to apply. Opaque Bash programs can perform
internal IO that the classifier cannot see, so this is not an OS sandbox.
Forwarded asks must retain the requesting child's edge-stamped principal.
Workspace restriction aliases supplement those facts; they never replace the
principal, actual match values or execution/boundary paths. Invalid binding
facts produce a fail-closed `gate_error` response rather than a stalled ask.

## Dispatch preflight and validation observations

[Task dispatch](task-dispatch.md) performs read-only preflight against the target
profile, including path and canonical-alias external-directory surfaces. Known
deny rejects before extra input-classification stat; ask/unknown is not approval
or a grant. Permission lookup may itself canonicalize. Interface failures are
not policy unknown. Claims detect declared lexical/canonical overlap, not opaque
program effects or OS isolation, and remain through pending questions/answer
rollback until final termination and necessary cleanup are confirmed.

Checks-only execution-start source capture observes the actual child cwd, not
an assertion that the source checkout was tested. This bounded runtime metadata
capture is separate from model Git command classification, which has no
provenance probes. Capture uses trusted absolute Git, never
project PATH, with isolated redirection/config/executable/trace environment,
helper/partial configuration guards before status overrides, and disabled lazy
fetch/locks/paging/replacements. Fixed `--ignore-submodules=all` makes this
superproject-only partial metadata, not whole-tree clean or content identity.
Fixed `--untracked-files=normal` includes non-ignored untracked entries despite
configured suppression; ignores/indexes/Git semantics still apply. Global LFS
clean/process keys and configured fsmonitor=false still withhold known state;
this conservative guard is not narrowed.
Unknown capture does not authorize anything. Tree leases coordinate only the
same host/agentDir/canonical tree and are advisory; synchronous flock can still
delay event-loop cancellation. Source Git subprocess probes are asynchronous,
with per-probe 2-second/4 MiB and aggregate 8-second/8 MiB limits, not
hard-realtime bounds or guaranteed cancellation/kill. Receipts are bounded trusted history/offline
observations with valid boundary/end coverage, not grant or gate-skip tokens.
Invalid optional receipts are locally dropped with a bounded end marker/live
cleanup diagnostic and cold-reader warning; mandatory history validation and
append failures remain strict, with no retry.

Runs have no wall-clock execution deadline or timed wrap-up input. The retained
turn-wrap `soft_budget` input invalidates the automatic-approval witness and
emits `pi-harness:approval:invalidated`. This is not merely a harmless reminder
or a guarantee that a model received it. Historical `deadline`/`time_wrapped`
facts remain readable without restoring their retired execution mechanism. Worker
same-class denied-operation escalation remains guidance. [Runtime feedback](runtime-feedback.md)
observes actual managed blocks through session/service-bound leases, not UI
decisions or inferred reasons. It attempts one structurally tagged harness alert
per Run with independent bounded quota, not a child-authored alert. It grants no
permission, automatic action or delivery guarantee.

## Immutable resource floor in writable installations

The private 32.0.3 permission-system patch installs a deny-only, process-local
snapshot before Jev captures and removes its key-file path from the environment.
The snapshot write-protects the executable Pi Alehouse package/source and generated
runtime, dependency and host Pi code roots, and the selected Pi agent directory.
It read- **and** write-protects exact auth and web configuration files and the
configured Jev key file, using lexical and canonical path aliases. Its
`PermissionManager.buildCheckResult` floor applies **after** composed
project/profile/session/yolo rules; neither project overrides, human session
grants nor yolo can widen it. Writes to a protected directory's ancestors are
also conservatively denied because deletion or rename could remove a protected
descendant; siblings remain usable. Audit active/lock files and the dedicated
archive root have their own lexical/canonical entries, so a supported external
logs symlink does not leave current audit artifacts unprotected or make every
unrelated shared log a protected resource. Archive-root symlinks are rejected
rather than silently widening that root to an unrelated tree. Existing files
and user configuration are not overwritten. Internal children require the same snapshot, and attempting
to load a different unprotected runtime generation requires a fresh Pi process.

This addresses detectable path effects in writable source/npm installs, where
code and policy are not inherently OS read-only. It is **not** an OS sandbox,
inode or hardlink tracker, opaque-program write detector, atomic cancellation
barrier, or protection from arbitrary trusted in-process extensions. A shell
ask for an opaque program can still be approved and perform effects the path
classifier cannot see. To edit Alehouse's own source with model tools, run a
**separately installed** CLI; launching from the same checkout protects that
checkout and will deny its own source writes, including under `editor`.

## Permission readiness and provenance

Startup requires the generated definitions. Child assembly checks the admitted
profile digest and tool table against that startup snapshot, then binds them to
the child session. Parent-tool and assembly boundaries resolve the public parent
permission service; child Run/input boundaries require the child's public service
and synchronous static-guard acknowledgement for its session/profile/digest.
Missing readiness or mismatched bound identity blocks that boundary, rather than
merely requesting manual permission.

These readiness checks do not reread managed definition files or freeze the
whole live permission configuration. Removing/changing a definition after
startup is not a harness fail-stop condition. Trusted project overrides and
human session grants retain the normal permission chain, but cannot widen the
separate immutable resource floor or a profile's whole-surface write ceiling;
otherwise they need not monotonically restrict the global definition.
Jev can disqualify changed definitions/overrides from automatic
approval and defer, but defer does not turn an existing configured allow into ask.
See [limitations](limitations.md) for what the permission chain does not cover.

Separately, the harness records an optional Run approval witness at admission
and at the child SDK's real prompt boundary.  The child loads only that small
observer; it never loads a second reviewer.  The witness is invalidated by
cancellation, steering, budget input, extra child input, Run exit, or a later
direct user message.  Resume needs a fresh binding.  It is in memory and audit
records avoid prompt text.  Asynchronous review is revalidated after the
verdict.  Missing/stale provenance, invalid tool observation, or a leftover
witness disables automatic approval for that Run while preserving normal human
forwarding through the existing authority.

Eligible forwarded worktree asks currently defer as `delegation_unbound` to
ordinary human handling. Jev's script evidence still uses the parent's source
cwd; accepting a different runtime cwd by relaxing that comparison alone would
review the wrong working copy. Existing configured allows and yolo can satisfy
ordinary asks before this review path, unchanged.

Jev is the only model judge. Its static checkpoints
(`extensions/lib/hard-checkpoint.ts`) run before any model call. The launch
default for Jev is `enforce-subagents` (or explicit
`PI_JEV_APPROVAL_MODE=shadow`). This is not a claim that automated review is
available, calibrated, or authorized for every request. Without a protected
`PI_JEV_API_KEY_FILE` **path** (not a key in an environment variable), review
defers to ordinary human permission handling; stale/incomplete provenance,
project-rule omissions, and over-limit material also defer. When configured
and invoked, Jev sends bounded action and relevant review context (including
potentially sensitive instructions/prompt material) to
`https://api.typesafe.ai/v1/systemone` using fixed `jev-1.13.0`. Transport uses
a private TypeSafe provider from the host Pi 1.0 classifier API, not the shared
model/auth registry. The protected key-file is read lazily; environment keys
and provider fallbacks are not used. Automatic allows still require a successful
synchronous private audit append. The active audit file rotates at 1 MiB without
deleting historical archives; total disk use remains unbounded. The Linux writer
requires `/proc/self/fd` and a launcher-verified absolute util-linux flock. It
holds the same open-file-description kernel lock after the short helper exits;
normal cleanup never removes that regular lock inode. A short bounded kernel
contention wait is followed by fresh policy/action/authorization/restriction/Run/
mode/script validation before an allow line is written. IO, unsafe identities,
failed validation or uncertain cleanup still defer. Rotation renames into an
exclusive private archive container, not a link/unlink pair or an existing slot.

Audit ownership checks require the canonical log directory to appear owned by
the current UID and all ancestors by the current UID or root, in addition to
permission/sticky-directory checks. In user namespaces with incomplete UID/GID
mappings, host-root ancestors may appear as an overflow UID such as 65534
(`nobody`). Their actual ownership cannot be established from that value, so
Jev audit and recovery reject them as `untrusted_directory_owner` even if the
leaf log directory is healthy. Do not whitelist an overflow UID as a substitute
for verified root/current-user ownership. This fail-closed environment limit
can disable Jev automatic allows without disabling ordinary human handling or
existing policy allows; it is not evidence of a bad audit lock. See the
[namespace limit](jev-audit-recovery.md#user-namespace-ownership-limit).

Process death releases this audit kernel lock, not an Owner reservation or an
incomplete audit record. Legacy directory locks, extra hard links and incomplete
active tails require [explicit offline recovery](jev-audit-recovery.md), with
all writers stopped and evidence preserved. No TTL/PID-only stealing, silent
truncation, automatic archive deletion or live migration is supported. The
original unlocked writer cannot safely coexist with the kernel-lock writer;
all old Pi processes sharing the audit sink must stop before upgrade/rollback.
Safe owned shared-directory permissions are preserved rather than chmodded on
each append. Supported symlink layouts pin/protect the exact canonical audit
artifacts before the immutable floor freezes and reject later retargeting.
These are not OS-sandbox, fsync or power-loss durability guarantees. TypeSafe
transport requests retain a two-second cancellation budget, no retries and
exact-endpoint/no-redirect checks. Independent judge
backpressure allows four root and eight distinct subagent reviews in flight;
excess requests defer as `review_overloaded` to normal human handling, while
identical in-flight packets coalesce. This is not tied to resident worker count:
a worker may issue parallel tool calls. Raising worker capacity does not widen
this automated-review budget. Native boolean answers
are validated and converted to the existing policy verdict inputs; native
transport does not confer approval authority.
Opt in only after evaluating that data handling.  Never reinterpret the harness profile or
Run identity as the retired subagents authorization protocol to obtain a grant.

`PI_JEV_APPROVAL_MODE` is only each session's launch mode. The footer's
approval indicator (`approval-mode.ts`) changes the current session at runtime:
manual (shadow), Jev for the root, Jev for the root and forwarded subagent
asks, or session yolo. Any change that widens what is approved without a human
takes a second, deliberate choice or Pi's confirm dialog; narrowing takes one.
Yolo always requires confirmation when enabled. A change retires every
in-flight review (a monotonic mode revision, so a round trip back to the same
mode still invalidates it) but keeps human denials, retry pauses and the denial
fuse, which only new direct input reopens. Jev announces each change.

The current choice is recorded in the session under its own session id. An
explicit choice records evidence even when equal to the launch mode. On
resume, that same-session branch record wins over a saved preference. The judge
mode is restored no wider than the session's launch mode; yolo is offered again
behind confirmation, never silently resumed. A fork or clone does not inherit
a record for the former session id. If there is no valid same-session record,
an optional saved approval preference may seed startup: a judge preference at
or below the launch cap may apply, one wider than the cap requires confirmation,
and yolo always requires explicit confirmation in a UI. Without UI, a judge
preference above the launch cap cannot widen the mode and yolo cannot be enabled.
If no judge is loaded, a saved judge preference is not applied and is reported.
A saved preference is a request, not permission authority. Startup narrowing
is applied synchronously when the judge binds. Ambiguous cached same-session
state is provisionally clamped to manual before startup returns; this does not
replace a later fresh launch cap, and consent dialogs wait until startup completes.

Only an explicit approval choice or explicit remember operation stages an
approval preference; startup restoration, `/tree`, and judge-observer updates
do not write preferences. With a persistent save scope, choosing an approval
mode stages that live choice. The approval menu's **Save as global/project
default** and `/approval save [global|workspace]` instead show the target and
current value for explicit confirmation, then stage the preference without
changing the live mode or save scope. Saving a default never enables an armed
popover choice; only the actual live mode is saved. Workspace saving requires
project trust. A pending save dialog owns its entry: the approval popover cannot
reopen over it, and obsolete callbacks cannot save for a later session. This storage never grants a permission rule; the
approval extension enforces the launch cap, and the managed authority still
enforces explicit denies, the static guard and fail-closed floor.

Session yolo lives in the managed permission authority, not in a judge: for
the session and its ancestors in the in-process permission subagent registry,
asks become allows without reaching Jev or a human.  Explicit denies, the static
safety guard and the fail-closed floor (allows clamped to ask by an invalid
config scope, which this build keeps as asks under any yolo) still hold.  A
child not in that registry is not covered and keeps asking.

## Scoped settings and trust

Optional version-2 user preferences are read from `<agentDir>/extensions/pi-alehouse/config.json`
and, only for a trusted project, `<current-cwd>/.pi/extensions/pi-alehouse/config.json`.
The workspace lookup is the current working directory only, not a Git-root
search. It contains user-selected routing, delegation, effort, approval,
appearance, and custom model definitions; it is not a credential store and does not change the
required, read-only-to-the-UI base `harness-presets.json` catalogue. Valid
read-only settings can load. Invalid settings fail visibly and are not
replaced. Startup/restoration makes no configuration writes; persistent
changes are queued only by explicit user actions. The settings writer uses a
cooperative lock, leaf-conflict rejection per scope, and atomic rename, refuses
symlink/read-only replacement, and reports failures. These safeguards do not
provide a hard filesystem timeout or crash-durability guarantee. The preset
editor's native `/model` selector uses the already-acquired parent model runtime,
not another runtime or copied credentials. Its model queries and scoped list
exclude virtual models. The scoped list comes directly from the session's
read-only `ctx.scopedModels` snapshot; no separate settings/trust lookup or
scope mutation occurs. Its callbacks neither switch the main model nor set Pi's
model defaults. Appearance saves report when a workspace leaf shadows a global
default, including a no-op global save. Discarding queued writes or removing a
saved override does not silently roll back the live appearance or delete the
higher-priority workspace choice. Native catalogue refresh is preserved: opening the selector can use
provider network access, rotate OAuth credentials, and update the host's model
cache, independently of the preference writer. See
[routing](routing.md#scoped-user-preferences) for the schema and paths.

## Communication observation and admission

The [tool contract](tool-contract.md) has nine parent tools, including
explicit `agent_answer`; child delegation remains excluded/denied for all nine
and all retired names. Initial Off hides all nine. After accepted work, only
wait/read/interrupt/kill/list remain visible. Off gates new tasks, steering and
answers, not accepted child alert/ask callbacks or inspection. Observations carry
`workers_disabled: true` separately from Owner faults; asking the user to enable
delegation is required before answering, not calling a hidden cached answer tool.

Questions are immutable first-write-wins per original Run. Only a truly settled,
current pending, unreserved needs-input question on a healthy reusable Agent
with no current Run receives a token. Off does not erase its identity but still
forbids answer admission. `question_id` is q_ plus the first 128 bits of a SHA256
digest over the version tag, Owner ID, generation and original Run ID (34-character
lowercase form). It rejects stale/cross-generation references, not a permission
credential or collision-free proof. Answer reserves/admit atomically through
normal context/revision/approval checks. Before real `inputEntered`, failed or
cancelled continuations can release reservation if the Agent stays reusable;
after it, they cannot reopen the old question. Kill/quarantine/Owner loss never
restore authority. A new answer checks sticky Owner availability before token
eligibility and after preparation; the non-latching read-only lease probe is not
an admission gate. Send never creates an answer continuation; run cannot bypass
a pending question. Child messages are data, not permission grants.

Alerts are accepted only at an open Run/generation gate, after parameter, quota
and SDK-free retained-envelope byte checks. A single FIFO preserves order across
child and harness sources, including historical/killed sources. Child allowances
remain Owner 64 / Agent 16; harness feedback has separate Owner 16 / Agent one
pending allowances, for at most 80 entries total. Child tools cannot supply the
structural harness-source tag, which commit validates against the original queued
entry. Full allowances reject new messages without evicting accepted ones; only
successful scoped publication releases quota. No deny, Git/path/web boundary, immutable resource floor or lease
rule is relaxed. Task-condition targets bind once; alert scopes are separately
typed Owner/Agents/Run. Result read spans one Agent's pending alerts independently
of its task/page selector.
Inline command observations see only their bound Run.

Entry/default-admission validation, return validation and publication are
synchronous read-only phases. Supported Owner effecting entries reject reentrancy
before any mutation or async enqueue, even if a guarded getter catches the
nested error. Invalid/throwing/asynchronous admission readers reject observations
without publication; only a valid enabled=false state represents Off. Command
admission remains fail-closed and accepted-request replay is preserved.
Real abort/timer signals only latch and defer the shared drain.
Plain snapshots are projected and byte-checked before all reference validation
and a callback-free all-or-none commit. Task ordinals, labels and original object
membership are checked against retained Run authority, not snapshot/body agreement.
Compact result cursors bind Owner/generation/Run/version using a domain-separated
128-bit digest and exact offset; they are locators, not permission credentials.
Lookup derives from retained Runs, rejects ambiguous/foreign matches, and grants
no restart hydration or additional access. Read-only task ordinals select only
that named Agent's retained Runs, never command targets. Task and cursor are
mutually exclusive. There is no metadata-only view or metadata cursor. Whole
optional summary fields/finished labels
never weaken thin controls or original-Run provenance checks; omitted labels do
not defer/reset finished consumption. One failed observer rejects and cleans
itself without consuming alerts/finished/fault facts, rejecting accepted child
callbacks, stalling lifecycle settlement or latching an Owner fault. Lifecycle
observations share the drain, not model validation/publication; shutdown still
needs actual execution/cleanup evidence.

This phase gate protects supported Harness entrypoints, not trusted code that
mutates internals directly, bypasses wrappers or never returns. It is not an OS
sandbox or forced interruption. Successful publication proves only local final
content construction before consumption: not SDK persistence, later hook fidelity,
model receipt, user ACK or crash recovery. Usage may be appended in tool_result
without body changes; it is accounting, not a message acknowledgement.

Matched migration must reconcile existing managed definitions/permission sources
manually and start a new Pi process; absent-only init does not replace files or
resolve digest mismatch. Historical notify/progress/send-answered journals are
read-only display, never pending-state hydration. See
[matched resource migration](development.md#matched-resource-migration).

## Context, identity, and data handling

The parent tool captures the real `ExtensionContext`; all relevant identity is
rechecked after preparation/awaits and before publication commit, never by a
success wrapper after consumption. A parent-tool caller may choose `profile`
and `reasoning_difficulty`,
but cannot choose the concrete provider/model/thinking resolution, arbitrary
parent/child cwd, owner, generation, session ID, history path, or profile tool
table. The workspace enum asks the host to create a retained working copy; it
cannot select an arbitrary directory or widen the profile.
Optional inherited context is a bounded 64 KiB text snapshot with an aggregate
digest, not a history fork or tool/settings transfer. It uses the SDK's
model-visible projection, respecting context omissions/replacements and compaction
rather than restoring raw failed attempts. Oversized snapshots fail before child
creation. Approval provenance separately binds the loaded project
instructions; a copied conversation is not authority.

History readers accept only SDK-derived parent/child paths under the trusted
session root, use no-follow read-only access, and enforce explicit file caps.
They cannot browse arbitrary files, repair records, or turn historical data into
execution. Results and live state are Owner-local. Cold history is scoped to
the current parent's recorded links, including older generations; it grants no
live-Owner authority.  Parent and child journals can contain sensitive model
content, including thinking, and private transcripts must not be published as
evidence.  Controlled fixtures intentionally save synthetic logs/reports with
their scope and provenance instead.

The harness reuses the host model runtime and existing authentication.  It does
not copy credentials into child configuration, prompt snapshots, event payloads,
or logs.  A real host SDK call can refresh the selected Pi auth file; real-provider
trials therefore require separate authorization. The footer's ordinary quota
header display/accounting does not require a network publishing opt-in.
Quota-dashboard HTTP POST requires explicit `AGENT_DASHBOARD_URL` (no implicit
localhost endpoint). Grok billing network/auth reads require
`PI_ALEHOUSE_GROK_BILLING=1`; the optional `GROK_CLI_CHAT_PROXY_BASE_URL`
selects its external billing proxy, otherwise the built-in endpoint is used
*only when billing is enabled*. The billing integration reads `auth.json` under
Pi's actual `getAgentDir()` location, not an assumed HOME path. Neither opt-in
changes ordinary quota-header display/accounting. Only enable these integrations
deliberately.

## Leases, cleanup, and cancellation

Public Owner admission and child-input faults share recovery guidance:
closed/closing Owners cannot reopen through routing or a new Agent; tell the
user and use a fresh session only after confirmed closure. Cleanup uncertainty
has no retry or force release. Internal faults and unavailable parent history
writers likewise require telling the user, not retrying or diagnosing a model.

A private local `FileOwnerLease` plus absolute util-linux `flock` serializes an
Owner for its parent session.  It is not an OS sandbox, distributed lock, or
proof that child/provider activity stopped.  Lock files are intentionally kept
for inode identity; manual removal while a process may hold one is unsafe.

Rendering is read-only with respect to Owner lifecycle. Explicit human input may
submit a confirmed intent bound to the originally displayed Run; the host invokes
the same core cancel path, including approval-witness invalidation. This narrowing
action remains available while delegation is Off; it grants no tool/path authority.
A retired host/pane or a target that changed while confirmation was visible cannot
redirect the intent. First-accepted human provenance is an observation, not an
approval credential or a durable notification guarantee.

Cancellation, turn-limit stop, and explicit shutdown seal the harness gate and
request the existing SDK stop path.  They do not roll back file or provider
effects. Switch/fork guards require confirmed closure: an unused Owner starts
shutdown before its first await, while a used Owner requires literal `true` from a
live UI confirmation before shutdown starts. Refusal, unavailable/throwing UI,
concurrent target while confirmation/drain is pending, or shutdown uncertainty
cancels without granting replacement; the pending decision cannot be reused.
After closure, the host SDK does not serialize downstream hooks, teardown, target
loading, or replacement construction, so this is not an atomic close-and-replace
transaction; wait for each replacement operation to finish. `/tree` changes the
session in place, so it never auto-closes and retains the explicit
`/harness-close` gate. A child that crosses a guard boundary is quarantined and
not reused. The execution slot is freed after actual execution exit, while the Agent reservation and Owner lease remain through finalization
and confirmed cleanup; uncertain cleanup blocks closure/reuse rather than being
force-unlocked.  The host SDK has known input-admission/reload gaps, so do not
claim atomic cancellation or reload safety; see [limitations](limitations.md)
and the controlled observations in [validation evidence](validation-evidence.md).

## Event compatibility

These literal event names are integration surface and remain unchanged:

- child lifecycle: `subagents:child:session-created`, `subagents:child:bound`,
  `subagents:child:disposed`;
- harness approval witness: `pi-harness:approval:admitted`,
  `pi-harness:approval:invalidated`, `pi-harness:approval:started`,
  `pi-harness:approval:finished`;
- managed guard readiness/probe: `pi-agent-harness:static-guard:ready`,
  `pi-agent-harness:static-guard:probe`;
- permission UI bridge: `permissions:ui_prompt`, `permissions:decision`;
- overlay coordination: `pi-harness:hide-transient-overlays`.

Compatibility with event vocabulary does not mean the retired backend is loaded
or that its old privilege model applies.
