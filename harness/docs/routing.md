# Delegation mode and model presets

The Delegation panel (`Alt+S`) sets two independent things: how the main model
divides work with Agents ([delegation mode](#delegation-mode)), and which models
new Agents run on (model presets, the rest of this page).

## Delegation mode

The mode is a slider of four positions, ordered by how much the main model
hands off:

| Mode | Main model |
| --- | --- |
| Manual | starts Agent work only when the user asks; may suggest it |
| Co-worker (default) | works alongside Agents; each takes parts of the task |
| Lead | keeps the critical path and key decisions; Agents take the rest |
| Supervisor | plans, answers Agents, reviews and integrates; Agents do the tasks |

Eagerness sets how small a piece is still worth handing off: reserved hands off
only substantial, clearly separable work; balanced (the default) hands off
independent pieces that would take longer to do than to explain; eager hands
off even small independent pieces and keeps several Agents running at once. It does not apply to
Manual. The mode and eagerness compose the one guideline line `agent_spawn`
carries into the parent system prompt; the panel shows that line (clipped when
the panel is narrow). This is
prompt guidance, not enforcement: Manual does not block `agent_spawn` (use
`off`, or a permission `ask` rule, for that).

A change takes effect at once: `agent_spawn` is re-registered with the new line
(one prompt-cache miss), and the parent's next run uses it. A run already in
progress keeps the prompt it started with. Running Agents are unchanged. If the
re-registration itself fails, the harness warns and retries before each run. `/harness-mode lead eager` sets it without the panel (a mode, an
eagerness, or one of each); bare `/harness-mode` reports it. Each change
appends `harness:delegation-mode:v1` (`mode`, `eagerness`, `selected_at`) to
the active branch; restoring the session restores it, and an invalid saved entry
fails startup with its own error naming that record. For a fresh session, scoped
user preferences override the catalogue's optional `defaultMode` and
`defaultEagerness`; absent those, the catalogue values apply, then Co-worker ×
balanced. A saved branch choice wins over both. With `off` selected the mode
is kept but unused.

The footer status value is `delegation: co-worker/gpt-medium`: the mode, eagerness only when it is
not balanced and the mode is not Manual (`delegation: lead·eager/gpt-medium`), the preset
name without its version, and `*` for session effort overrides. Off's status value is
`delegation: off`, displayed as `off` in the footer. The banner deliberately omits the preset
version; the picker, selection notices, and Agent detail retain it.

## Model presets

Routing is deterministic, trusted configuration for **new** Agents. It is not
model benchmarking, authentication, a provider fallback, or permission policy.
The user selects the parent Pi model and thinking normally. The parent tool
selects only a profile, required integer `difficulty` (1–5), and task. The fixed
mapping is difficulty 1–2 → the preset's `light` slot, 3 → `standard`, and 4–5
→ `strong`. Pi virtual selections (`api: "pi-virtual"`) are not supported in
worker slots: admission rejects them with `PRESET_MODEL_UNAVAILABLE` before
child creation, rather than allowing a later per-request physical route change.
Configure an exact physical model; the parent may still use Pi virtual routing.
The harness resolves one exact worker model from that slot and its
effort policy: a fixed level or `inherit` from parent thinking. Only inherited
thinking may use the preset's explicit compatibility map. The fixed difficulty
mapping, effort defaults, and session overrides participate in `selection_digest`.

A resumed Agent keeps its admitted difficulty, preset/version/digest, internally
resolved slot, exact provider/model, resolved thinking, profile digest, tools,
cwd, and context snapshot. Configuration reloads and later model metadata
changes cannot reconfigure accepted work or an idempotent retry.

## Difficulty

Assess the reasoning difficulty of the prompt's concrete task and requested
quality, independently of permission profile:

1. Clear method, mostly execution.
2. Routine local analysis.
3. Independent investigation and a plan.
4. Competing hypotheses or complex constraints needing indirect reasoning.
5. Exceptional problem with no established approach.

Do not adjust difficulty for workload, importance, cost, or reassurance; cost
belongs to the delegation decision, not the rating. These scoring
anchors live in the model-visible `difficulty` parameter description. The fixed
mapping above is operator documentation, not part of that scoring guidance; it
is shared by all presets, with no per-preset thresholds. The existing
`light`/`standard`/`strong` names remain internal routing slots, and slots may
share a model.

Difficulty is immutable Agent configuration. Resume does not accept or rescore
it; creating a new Agent is required to allocate a different difficulty/route.
A preset/model/thinking resolution failure is a configuration issue: report it
and have the user adjust the worker preset, effort policy, or inherited parent
thinking. Do not change difficulty to bypass the error or silently upgrade the route.

## Effort

Each slot has an optional `effort` policy: `inherit` or a Pi thinking level
(`off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`). Missing configuration
means `inherit`, preserving older custom preset files.

- Fixed levels must be supported exactly by the registered model. They never
  consult compatibility maps, clamp, or fall back. They do not need a parent
  thinking level; a parent using `off` can explicitly allocate a `high` worker.
- `inherit` captures parent thinking at the creation request. Exact model support
  wins; otherwise only the selected slot's explicit `thinking` map may resolve
  it. An inherited `off` cannot map to enabled thinking.
- The UI's **preset default** removes the session override; it is not a synonym
  for `inherit`. For example, a preset default can be fixed `high`.

`Alt+S` → `E` edits slot effort immediately, with no draft or Apply step.
An inactive preset first requires confirmation to select/enable it. Each changed
arrow/reset validates all effective **fixed** slots against the current host
registry before synchronous audit/publication; missing models or unsupported
fixed levels leave the live selection unchanged. `inherit` is a
spawn-time policy: its current preview or warning never blocks saving, even if
its model is currently unavailable. It is resolved afresh at Agent admission,
not pinned at edit time. A model's effort labels are not cross-model compute or quality units.
The main model and thinking remain unchanged. Accepted Agents—including queued
or idle ones—retain their resolved thinking and source on resume. No model-facing
tool accepts an effort argument.

Overrides belong to the current session branch, separately for each preset.
Switching away/back and restoring that session preserve them. A fresh session
uses scoped effort preferences, then the preset defaults. Reset removes
session overrides immediately after validation/audit. Enter/Esc returns without
undo; closing the picker or yielding to permissions also retains committed changes. The UI never writes the base
`harness-presets.json`; an explicit persistent scope may remember effort
preferences in the separate `config.json` layer. A `*` on a preset label means
an applied session override, not an unsaved draft. Reopened sessions with
active saved overrides revalidate fixed slots against current model metadata
and warn if they need attention; inherited parent compatibility does not
trigger a startup warning. Invalid values are not silently erased or clamped.
See [the editor](interface.md#effort-editor) and
[scoped preferences](#scoped-user-preferences).

## Neutral catalogue and model resolution

Explicit initialization creates the required version-2 routing file only when
absent. The neutral generated catalogue is
`{ "version": 2, "defaultPreset": "off", "presets": {} }`. This base
`harness-presets.json` is the read-only catalogue for the UI and is never
rewritten by preferences or preset editing; users may edit it directly. No
worker model or provider credentials are selected by the project; the user must
configure exact host-registered models before enabling new Agents.
There are no hidden model presets or fallback defaults in TypeScript.
`off` is a special built-in selection (`off-v1`), not a model route or permission
profile; it has no model slots or thinking maps.

For `inherit`, exact SDK support wins even when a map also names that source
level; a map is used only if identity is unsupported. Missing/unsupported maps
fail with `THINKING_INCOMPATIBLE`; there is no clamp, alias, automatic route
upgrade, inventory dump, or hidden fallback. `off` cannot map to enabled
thinking. Model-facing settings contain only `profile` and `difficulty`.
Resolution errors add a bounded reason, `error.difficulty` and, for inherited
thinking, `parent_thinking`; never the preset, slot, model or resolved effort.
Direct callers may not pass `model`, `thinking`, or `effort`.

## Off

Choose `off` in the picker or use `/harness-preset off`. Selecting any real
preset enables new work again. The selected name is the single source of truth;
there is no separate persisted enable switch or last-preset setting. This is
independent of Pi's **thinking** level named `off`.

Off rejects new `agent_spawn`, `agent_run`, `agent_send` and `agent_answer`
with `WORKERS_DISABLED` before model resolution, new Run/session allocation,
steering or question continuation, in the Controller. Unknown Agent names retain
normal errors through cached handles. Accepted queued/running work, child
alert_parent/ask_parent and internal finish-budget instructions continue; Off
does not cancel, pause, release or close the Owner. Same-ID retries replay their
original acceptance/delivery fact, not cached observations or consumed alerts.
A submission crossing an Off/On admission revision is rejected, not revived;
ordinary enabled-preset switches retain existing routing semantics.

All nine tools remain registered, but Off hides them from the model if this
Owner has never accepted work. Once it has, only `agent_wait`, `agent_read`,
`agent_interrupt`, `agent_kill`, and `agent_list` remain active while Off, including
after execution/release so retained results stay accessible. Other active tools
and the main model/permissions are unchanged. Hidden/cached calls still meet
the execution gate; hiding a schema alone is not authorization.

The preset owns the active selection of these nine tools. At startup, preset
changes, acceptance callbacks, `before_agent_start` and `turn_start`, reconciliation
restores any missing allowed harness tools: all nine when enabled, or the five
result/cleanup tools when Off with accepted work. Individually deactivating one
of these tools is not a persistent override. Use Off to disable new worker work;
the current selection and order of non-harness tools are preserved.

Under the [tool contract](tool-contract.md), default wait selects current
nonterminal tasks while Off; when initially On it also binds healthy settled
pending questions. This choice is made once: switching during a wait neither
adds nor removes targets. Explicit wait/read still show pending question identity
with workers_disabled=true; Off does not consume it or make it answerable through
send. Enable delegation before explicit agent_answer. On questions remain
level-triggered independent of finished presentation: unanswered questions return
again. To defer one, pass `agents` naming other Agents; this also limits alerts
to those Agents. A selected running task that later asks can return its question
even after switching Off. A fresh On wait can recover a question excluded by an
earlier Off binding. No selected tasks and no relevant alerts returns nothing_pending
immediately without a timer.

The harness adds no orchestration system-prompt paragraph or disabled-mode
message in either mode. Essential API facts live in the relevant tool metadata.
An initially Off fresh conversation has no harness tool declarations; switching
off later cannot erase prior instructions, tool calls/results, or SDK tool-set
change records from history. No token refund or zero historical context cost is
claimed. Off remains an open Owner. Replacement still requires confirmed closure: a
fresh Owner that never accepted work may close automatically, but any Owner that
accepted work requires literal confirmation or explicit `/harness-close` before
switch/fork replacement. `/tree` still requires explicit close because it changes
that session in place, and open-Owner `/reload` remains unsupported.

## Preset configuration

The harness requires a complete, trusted routing configuration at:

```text
${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}/harness-presets.json
```

The path defines no keys, credentials, or provider setup. It is a required
regular file (or a trusted symlink to one) up to 256 KiB. Missing or
invalid configuration blocks harness initialization; there is no code-level
preset fallback. The root is closed and must be version 2:

```json
{
  "version": 2,
  "defaultPreset": "my-team",
  "presets": {
    "my-team": {
      "version": "2026-10-01",
      "models": {
        "light": "registered-provider/exact-light-id",
        "standard": "registered-provider/exact-standard-id",
        "strong": "registered-provider/exact-strong-id"
      },
      "effort": {
        "light": "high",
        "standard": "inherit",
        "strong": "high"
      },
      "thinking": {
        "light": { "minimal": "medium", "low": "medium" },
        "standard": { "xhigh": "max" }
      }
    }
  }
}
```

Preset names are 1--64 characters of `[A-Za-z0-9._-]`, beginning alphanumeric;
`reload` and `off` are reserved. All other valid names are user-configured presets: they may be changed,
renamed, or removed. `defaultPreset` must name one of these presets or be `off`;
`{ "version": 2, "defaultPreset": "off", "presets": {} }` is valid. The
catalogue default applies only when starting a session with no branch selection
or scoped `preset` preference. Optional top-level `defaultMode` (`manual`,
`co-worker`, `lead`, `supervisor`) and
`defaultEagerness` (`reserved`, `balanced`, `eager`) set the fresh-session
[delegation mode](#delegation-mode) the same way. A preset body
has only `version`, `models`, optional `effort`, and optional `thinking`; model
slots must contain all three routing slots and exact `provider/model` strings.
Effort accepts a partial slot map; missing slots default to `inherit`. Thinking slots/source/
target keys use Pi vocabulary `off`, `minimal`, `low`, `medium`, `high`,
`xhigh`, `max`. `thinking` and individual maps are optional; inherited levels
then require exact SDK support. `off` may map only to `off`. Fixed effort never
uses these maps. Unknown keys, malformed files, unregistered exact IDs, and
unavailable levels fail before child creation.

### Scoped user preferences

The required base catalogue above is separate from optional version-1 user
preferences. The preferences store reads these two locations:

```text
<agentDir>/extensions/pi-alehouse/config.json
<current-cwd>/.pi/extensions/pi-alehouse/config.json
```

`<agentDir>` is Pi's `getAgentDir()` location (normally
`${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}`). The workspace path is based only on
the current working directory, not a Git-root search, and is loaded or written
only when Pi trusts that project. The global layer loads regardless of project
trust. A fresh session starts with save scope `session`; choosing global or
workspace requires confirmation. Merely changing scope copies or writes
nothing.

The closed version-1 document has optional `preset`, partial `delegation`
(`mode`, `eagerness`), per-preset/per-slot `effort`, `approval`, and custom
model `presets`. Delegation uses the modes and eagerness values above; effort
uses `inherit` or a Pi thinking level. `approval` is one of `manual`, `judge`,
`judge+sub`, or `yolo`. Each custom `presets` entry has the same body shape as a
base preset: required `version` and three-slot `models`, with optional `effort`
and `thinking`. Definitions add to the base catalogue and do not replace its
file. In an effort preference, `null` means use that preset's catalogue default
and masks a lower layer; an absent slot follows the lower layer. Workspace
leaves override global leaves. Saved preset names resolve against the current
base catalogue directory; only definitions explicitly present in `presets` are
carried by the preference file. These preferences seed fresh sessions; a valid
selection/effort record on the restored session branch takes precedence,
including legacy name-only selection records.

This small example is synthetic only; it contains no model recommendation or
credentials. The model IDs are placeholders and must exist in the host registry
to route work:

```json
{
  "version": 1,
  "preset": "demo",
  "delegation": { "mode": "co-worker" },
  "effort": { "demo": { "light": "high", "standard": null } },
  "approval": "manual",
  "presets": {
    "demo": {
      "version": "example",
      "models": {
        "light": "synthetic-provider/example-light",
        "standard": "synthetic-provider/example-standard",
        "strong": "synthetic-provider/example-strong"
      },
      "effort": { "light": "inherit", "standard": "inherit", "strong": "inherit" },
      "thinking": { "standard": { "low": "medium" } }
    }
  }
}
```

A preference document may be valid and load even when its file is read-only or
is reached through a symlink; writes refuse symlink or read-only replacement.
Each preference file is capped at 256 KiB; the trusted two-layer in-memory
merge may use up to 512 KiB without widening either file's write limit.
Routing may also include one separately bounded session-definition layer.
Invalid loaded configuration fails visibly with its path and is never
overwritten. Startup
and restoration do not create or update either file. Only explicit persistent
user actions queue changes; normal `session_shutdown` flushes pending changes,
and **Save pending now** can flush them earlier. Save errors are reported and
failed patches remain pending while the session is live. Ordinary pre-publication
failures can be retried after repair; conflicting edits require discarding the
pending change and restarting to reload disk. An uncertain rename/fsync outcome
retains the lock for manual inspection; do not remove it while a writer may
still be active. Inspect the file and restart before attempting another save.
Writes use an exclusive cooperative lock and merge only dirty leaves into the
latest file; a changed dirty leaf rejects that whole scope. Publication uses
atomic rename and refuses symlink or read-only replacement. This is not a hard
filesystem timeout or a crash-durability guarantee.

The Delegation panel's **Save as global default** (`G`) and **Save as project
default** (`W`) remember the live worker preset/delegation/effort snapshot after
confirmation, without changing the live choices or future save scope. Highlighted
presets, slider previews and unconfirmed custom-preset drafts are not saved.
G/W work from either the list or effort page; successful effort edits are already live. Project saving
requires trust. The full target and every intermediate patch are validated before
any snapshot fields are staged; a changed worker snapshot or retired session
cannot reuse pending consent.

`/harness-settings` or **P Settings** opens the scope and save menu. **Remember
current worker settings** uses the same exact-patch/destination confirmation;
it remembers worker preset/delegation/effort settings, not approval (use the
approval menu's **Save as global/project default** or `/approval save`). **Save pending now**, **Discard pending writes**,
**Remove a saved override**, and **Show paths and pending changes** are explicit
menu actions. Workspace writes require project trust. See the
[interface guide](interface.md#settings-and-preset-editor) for the controls.

### Editing the base catalogue

Edit your own trusted `${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}/harness-presets.json`
file directly; initialization never overwrites one, and the UI never edits it.
`/harness-preset reload` rereads the base catalogue and retains the current
name; changing `defaultPreset` does not switch live or restored selections.
New Agents use the updated route; accepted Agents keep their admitted
configuration. A new extension revision requires a fresh process, not
`/reload` with an open Owner.

Version 1 routing catalogues (formerly backed by hidden built-ins) are rejected
rather than silently reinterpreted. Back up and explicitly convert them to a
complete version-2 catalogue and `defaultPreset`; preserve any saved preset
names needed for session restoration. Initialization must not overwrite the
old file. Model preset labels include their configured version; no name has
built-in privileges.

## Selecting and persisting

Use `/harness-preset NAME` for a named selection, `/harness-preset reload` to
reread the file while retaining the active name, or bare `/harness-preset` /
`Alt+S` (or a click on the footer's delegation indicator) for the panel. Model
routes affect new Agents only; Off disables new tasks, answers and steering but
leaves accepted work unchanged. Neither selection changes the main model. `Alt+S` leaves Pi's `Ctrl+S` save actions
alone.  If a terminal, multiplexer, or reserved global binding intercepts it,
the command remains the fallback.

Disk reading produces an uncommitted candidate.  Parse errors, typos, picker
cancellation, a removed active preset, or stale overlapping pickers leave the
live catalogue and selection unchanged.  A valid candidate calls the synchronous
parent SDK audit once and only then publishes catalogue, selected snapshot, and
revision in memory.  This ordering is not a filesystem transaction, fsync
receipt, rollback, or guarantee that the parent branch did not change before an
SDK throw.  An ambiguous audit failure latches parent unavailability, retains
the old live router, blocks future execution and preset selection, and requires
a Pi restart; read, cancellation, release, drain, and shutdown remain usable.
A footer-paint or active-tool update failure after successful audit does not
undo the selection. It reports a warning; core admission already follows the
committed choice, and the next request retries tool reconciliation.

Successful selections append `harness:preset-selection:v1` to the active parent
branch and publish `delegation: <mode>/<preset>` (or `delegation: off`) under
the `harness-preset` footer key.
Off uses the same name/version/digest envelope without model/thinking fields;
selection entries are non-context metadata. They follow Pi's session storage
lifecycle: an ephemeral session cannot survive exit, and a fresh persistent
session is not written until its first user or assistant message. They are not
persistent preferences. Enabled entries also record the selected preset's complete session
`effort_overrides` (including `{}` after reset). Restoration replays these only
from the active branch, not abandoned branches. Scoped preferences seed a fresh
session only; they do not replace this branch-record precedence. User-defined
session catalogue entries are carried additively as `custom_presets` in
`harness:preset-selection:v1`; they do not rewrite the base file. Startup
restores Off from the active branch before the first model request. Existing
saved enabled selections remain compatible; a fresh session without a branch
choice or scoped `preset` preference starts at the file's `defaultPreset`.
Notices and the picker show every model preset's version (`<preset>@<version>`),
so a reload visibly picks up an edited revision; the footer shows the preset
name without it. The branch later restores the selected **name** and per-preset effort
overrides, not historical model pins. On process start the name is resolved
from the current configuration; a same-name preset
may therefore have a new version/digest/slots/maps. A missing saved name is a
startup error, never a fallback. Selection records are historical evidence,
not permanent catalogue pins. Each new child history boundary records difficulty
alongside its immutable resolved route and effort provenance (`preset` or
`user_override`, with `preset_fixed`, `identity`, or `preset_mapping` resolution).
Older boundaries without difficulty or effort source remain readable; neither
score nor source is inferred for them.

The preset picker shows exact slot IDs and current effective thinking levels,
not compatibility-map tables. The maps remain part of routing configuration
and inherited resolution. Clicking a model (or **1 / 2 / 3**) edits that slot
through the native model selector; other models and effort policies are kept.
Internal UI and journal views retain preset, slot, model and effort details; model-facing
parent-tool replies expose only `profile` and `difficulty`, so the caller rates
tasks without tuning scores against routing. See [interface](interface.md)
for picker behavior and [tool contract](tool-contract.md) for the caller API.
