# Worker routing

Routing is deterministic, trusted configuration for **new** Agents. It is not
model benchmarking, authentication, a provider fallback, or permission policy.
The user selects the parent Pi model and thinking normally. The parent tool
selects only a profile, required integer `difficulty` (1–5), and task. The fixed
mapping is difficulty 1–2 → the preset's `light` slot, 3 → `standard`, and 4–5
→ `strong`. The harness resolves one exact worker model from that slot and its
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

`Alt+S` → `E` edits slot effort in a draft. Apply validates all effective **fixed**
slots against the current host registry before audit/publication; missing models
or unsupported fixed levels leave the live selection unchanged. `inherit` is a
spawn-time policy: its current preview or warning never blocks saving, even if
its model is currently unavailable. It is resolved afresh at Agent admission,
not pinned at Apply. A model's effort labels are not cross-model compute or quality units.
The main model and thinking remain unchanged. Accepted Agents—including queued
or idle ones—retain their resolved thinking and source on resume. No model-facing
tool accepts an effort argument.

Overrides belong to the current session branch, separately for each preset.
Switching away/back and restoring that session preserve them. A fresh session
uses preset defaults. Reset removes overrides only after Apply. The UI never
writes the global preset file. A `*` on a preset label means an applied
session override, not an unsaved draft. Reopened sessions with active saved
overrides revalidate fixed slots against current model metadata and warn if they
need attention; inherited parent compatibility does not trigger a startup warning.
Invalid values are not silently erased or clamped. See [the editor](interface.md#effort-editor).

## Neutral catalogue and model resolution

Explicit initialization creates the version-2 routing file only when absent.
The neutral generated catalogue is `{ "version": 2, "defaultPreset": "off", "presets": {} }`.
No worker model or provider credentials are selected by the project; the user
must configure exact host-registered models before enabling new Agents.
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

Off blocks new `spawn_agent`/`resume_agent` work before model resolution or new
Run/session allocation, and rejects external `steer_run` input to accepting Runs
in the Controller. Unknown/input-closed Runs retain their normal errors, including
bounded terminal-result replies through cached tool handles while Off. Already
accepted queued/running work and internal finish-budget instructions continue;
Off does not cancel, pause, release, or close the Owner. Accepted same-ID retries
still return their original Run. A submission awaiting admission across an
Off/On transition is rejected rather than revived; ordinary enabled-preset
switches retain their existing routing semantics.

All eight tools remain registered, but Off hides them from the model if this
Owner has never accepted work. Once it has, only `list_agents`, `read_run`,
`wait_runs`, `cancel_run`, and `release_agent` remain active while Off, including
after execution/release so retained results stay accessible. Other active tools
and the main model/permissions are unchanged. Hidden/cached calls still meet
the execution gate; hiding a schema alone is not authorization.

The preset owns the active selection of these eight tools. At startup, preset
changes, acceptance callbacks, `before_agent_start` and `turn_start`, reconciliation
restores any missing allowed harness tools: all eight when enabled, or the five
result/cleanup tools when Off with accepted work. Individually deactivating one
of these tools is not a persistent override. Use Off to disable new worker work;
the current selection and order of non-harness tools are preserved.

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
`{ "version": 2, "defaultPreset": "off", "presets": {} }` is valid. The default
applies only when starting a session with no saved selection. A preset body
has only `version`, `models`, optional `effort`, and optional `thinking`; model
slots must contain all three routing slots and exact `provider/model` strings.
Effort accepts a partial slot map; missing slots default to `inherit`. Thinking slots/source/
target keys use Pi vocabulary `off`, `minimal`, `low`, `medium`, `high`,
`xhigh`, `max`. `thinking` and individual maps are optional; inherited levels
then require exact SDK support. `off` may map only to `off`. Fixed effort never
uses these maps. Unknown keys, malformed files, unregistered exact IDs, and
unavailable levels fail before child creation.

### Editing and migration

Edit your own trusted `${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}/harness-presets.json`
file; initialization never overwrites one. `/harness-preset reload` rereads the
catalogue and retains the current name; changing `defaultPreset` does not switch
live or restored selections. New Agents use the updated route; accepted Agents
keep their admitted configuration. A new extension revision requires a fresh
process, not `/reload` with an open Owner.

Version 1 custom files (formerly backed by hidden built-ins) are rejected rather
than silently reinterpreted. Back up and explicitly convert them to a complete
version-2 catalogue and `defaultPreset`; preserve any saved preset names needed
for session restoration. Initialization must not overwrite the old file. Model
preset labels include their configured version; no name has built-in privileges.

## Selecting and persisting

Use `/harness-preset NAME` for a named selection, `/harness-preset reload` to
reread the file while retaining the active name, or bare `/harness-preset` /
`Alt+S` (or a click on the footer's worker indicator) for the picker. Model
routes affect new Agents only; Off disables new/resumed/steered work but leaves
accepted work unchanged. Neither selection changes the main model. `Alt+S` leaves Pi's `Ctrl+S` save actions
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
branch and publish `workers: <preset>` under the `harness-preset` footer key.
Off uses the same name/version/digest envelope without model/thinking fields;
selection entries are non-context metadata. They follow Pi's session storage
lifecycle: an ephemeral session cannot survive exit, and a fresh persistent
session is not written until its first assistant message. They are not global
preferences; only the trusted version-2 file defines defaults for new sessions.
Enabled entries also record the
selected preset's complete session `effort_overrides` (including `{}` after
reset). Restoration replays these only from the active branch, not abandoned branches. Startup restores Off from the active
branch before the first model request. Existing saved enabled selections remain
compatible; a new session with no selection starts at the file's `defaultPreset`.
Every model preset shows as `<preset>@<version>` in the footer and notices, with
the version also shown in the picker, so a reload visibly picks up an edited
revision. The branch later restores the selected **name** and per-preset effort
overrides, not historical model pins. On process start the name is resolved
from the current configuration; a same-name preset
may therefore have a new version/digest/slots/maps. A missing saved name is a
startup error, never a fallback. Selection records are historical evidence,
not permanent catalogue pins. Each new child history boundary records difficulty
alongside its immutable resolved route and effort provenance (`preset` or
`user_override`, with `preset_fixed`, `identity`, or `preset_mapping` resolution).
Older boundaries without difficulty or effort source remain readable; neither
score nor source is inferred for them.

The preset picker shows exact slot IDs and maps to the user. Internal UI and
journal views retain preset, slot, model and effort details; model-facing
parent-tool replies expose only `profile` and `difficulty`, so the caller rates
tasks without tuning scores against routing. See [interface](interface.md)
for picker behavior and [tool contract](tool-contract.md) for the caller API.
