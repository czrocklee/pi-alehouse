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
0.31.0; children have no web tools. The CLI does not make a temporary npm install,
copy authentication, overwrite existing user resources, or enable arbitrary
extension discovery. Explicit initialization creates only absent resources;
neutral worker routing defaults to `off`. Install a **built tarball** with
`--omit=dev --legacy-peer-deps --ignore-scripts` to avoid pulling a second Pi
SDK/runtime through dependency peer auto-installation; the host Pi is separate.

The parent's four web tools stay subject to the global permission policy.
Children receive only their profile's local `read`/Bash/search/edit tools as
filtered by the harness, plus fixed `notify_parent`/`ask_parent`.  They receive
no parent management tools, no nested delegation, no arbitrary extensions, and
no web tool table.  This intentionally differs from the **declared** generated
worker definitions: those definitions can include web capability under the
broader shared worker policy, while the effective harness child allowlist
excludes it.  Tool availability is never network authorization.  Plain `pi`
has no delegation tools at all.

Supported profiles are `reader` and `editor`; Git mutations stay with the
parent in both, since Agents share one checkout:

| Profile | Direct edit/write | Ordinary Git mutation | Meaning |
| --- | --- | --- | --- |
| `reader` | denied; detectable Bash path writes denied | denied | no writes a judge or session yolo could approve; not an OS read-only sandbox |
| `editor` | parent-configured workspace/scratch scope | denied | bounded writer capability, subject to existing guards |

The profiles express enforced capabilities, not work roles, model tiers, or
permission grants.  They share policy body; they do not pin a model, thinking,
turn budget, or context inheritance.  Generated profile integrity and static
Bash denies are checked by the external authority.  Existing sensitive paths,
external writes, subprocess restrictions, Git configuration protections, and
permission-search rules continue to apply.  A reader's `path_write` is a
deny, not an ask, so neither Jev nor session yolo can turn a write it can be
seen to make into an allow.  The managed authority applies that whole-surface
profile ceiling after global/project rules, session grants and yolo; inherited
certificate/key-file asks cannot override it.  It still retains inspected shell `ask` paths: an
opaque program (a script that writes files itself) is an ordinary Bash ask,
which a judge or yolo can approve, so `reader` must not be represented as a
container/sandbox.

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
descendant; siblings remain usable. Existing files and user configuration are
not overwritten. Internal children require the same snapshot, and attempting
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
See the [integration overview](../../README.md#worker-and-permissions).

Separately, the harness records an optional Run approval witness at admission
and at the child SDK's real prompt boundary.  The child loads only that small
observer; it never loads a second reviewer.  The witness is invalidated by
cancellation, steering, budget input, extra child input, Run exit, or a later
direct user message.  Resume needs a fresh binding.  It is in memory and audit
records avoid prompt text.  Asynchronous review is revalidated after the
verdict.  Missing/stale provenance, invalid tool observation, or a leftover
witness disables automatic approval for that Run while preserving normal human
forwarding through the existing authority.

The explicit Pi Alehouse launcher does not load Luna. Jev imports only Luna's
shared static checkpoint helper; this does not register Luna as an authorizer.
The launch default for Jev is `enforce-subagents` (or explicit
`PI_JEV_APPROVAL_MODE=shadow`). This is not a claim that automated review is
available, calibrated, or authorized for every request. Without a protected
`PI_JEV_API_KEY_FILE` **path** (not a key in an environment variable), review
defers to ordinary human permission handling; stale/incomplete provenance,
project-rule omissions, and over-limit material also defer. When configured
and invoked, Jev sends bounded action and relevant review context (including
potentially sensitive instructions/prompt material) to its external endpoint.
Opt in only after evaluating that data handling.  Never reinterpret the harness profile or
Run identity as the retired subagents authorization protocol to obtain a grant.

`PI_JEV_APPROVAL_MODE` is only each session's launch mode.  The footer's
approval indicator (`approval-mode.ts`) changes the current session at runtime: manual (shadow), Jev for the root, Jev
for the root and forwarded subagent asks, or session yolo.  Any change that
widens what is approved without a human takes a second, deliberate choice or
Pi's confirm dialog; narrowing takes one.  A change retires every in-flight
review (a monotonic mode revision, so a round trip back to the same mode
still invalidates it) but keeps human denials, retry pauses and the denial
fuse, which only new direct input reopens.  Jev announces each change.

The choice is recorded in the session under its own session id.  Resuming
restores the judge mode no wider than the launch mode, and offers yolo back
behind a confirmation instead of resuming it; a fork or clone inherits
nothing.  The record is therefore a request, not authority: anything that can
append to the session file can at most cause a prompt or a narrower mode.

Session yolo lives in the managed permission authority, not in a judge: for
the session and its ancestors in the in-process permission subagent registry,
asks become allows without reaching Jev or a human.  Explicit denies, the static
safety guard and the fail-closed floor (allows clamped to ask by an invalid
config scope, which this build keeps as asks under any yolo) still hold.  A
child not in that registry is not covered and keeps asking.

## Context, identity, and data handling

The parent tool captures the real `ExtensionContext`; all relevant identity is
rechecked after awaits. A parent-tool caller may choose profile and difficulty,
but cannot choose the concrete provider/model/thinking resolution, parent/child
cwd, owner, generation, session ID, history path, or profile tool table.
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

A private local `FileOwnerLease` plus absolute util-linux `flock` serializes an
Owner for its parent session.  It is not an OS sandbox, distributed lock, or
proof that child/provider activity stopped.  Lock files are intentionally kept
for inode identity; manual removal while a process may hold one is unsafe.

Cancellation, deadline expiry, and explicit shutdown seal the harness gate and
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
