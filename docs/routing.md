# Delegation mode and model presets

Choose **a mode** for how the main model divides work, and **a preset** for
which models new Agents use. Neither changes the main model or grants a
permission. Open [Delegation](interface.md#delegation-panel) with `Alt+S` or
`/alehouse-preset`. A new installation starts [Off](#off) until you choose a
model preset; there are no built-in worker models.

[Documentation home](README.md) · [Agents, tasks and sessions](orchestration.md)

## Delegation mode

| Mode                | Guidance for the main model                                                                                    |
| ------------------- | -------------------------------------------------------------------------------------------------------------- |
| Manual              | Assign work only when you ask; suggest delegation when useful and collect existing work.                       |
| Co-worker (default) | Take a disjoint share of the task in parallel while Agents do theirs.                                          |
| Lead                | Own key decisions and core hands-on work; delegate separable diagnosis, implementation and verification.       |
| Supervisor          | Delegate diagnosis, design, implementation and review; focus on framing, decisions, questions and integration. |

**Eagerness** sets the handoff threshold: `reserved` for substantial, separable
work; `balanced` (default) for independent work that takes longer to do than to
explain; `eager` for even small independent pieces, with more work in parallel.
It has no effect in Manual. For example, use `/alehouse-mode lead eager` to set
both, `/alehouse-mode reserved` to change just the threshold, or bare
`/alehouse-mode` to see the current values and guideline.

The main model's next run gets the new guideline; an in-progress run keeps the
prompt it started with. This is guidance, not a permission gate: Manual does
not block `agent_spawn`. Use [Off](#off) to prevent new Agent work. A custom
system prompt can replace the guideline, but not the web-tool restriction.

With a preset enabled in Co-worker, Lead or Supervisor, the parent's direct
web tools are hidden and calls refused. Scouts handle even small web lookups,
regardless of eagerness. If you need direct web access (for example, no scout
is available), choose Manual or Off to restore Pi's upstream web-tool
selection. See [parent web access](security.md#parent-web-access) for what
this does and does not protect.

## Off

Select `off` in Delegation or run `/alehouse-preset off`. This blocks new
spawns, continuations of existing Agents, steering (including from the pane)
and answers. It does **not** pause or stop accepted queued or running tasks.
They can still finish, send alerts or ask questions; you can inspect or stop
them. Choose a model preset to allow new work again. Off has no model slots;
it is not Manual mode or Pi's `off` thinking level.

- If the current Owner has never accepted work, Off exposes no management
  tools to the model. Otherwise `agent_wait`, `agent_read`, `agent_list`,
  `agent_interrupt` and `agent_kill` remain available, including for retained
  work. Switching Off does not erase tool use from earlier conversation history.
- Off does not discard questions. Default waits started while Off omit
  already-settled questions; explicit observations can still show them.
  Switching presets does not change which tasks an existing wait watches.
  Re-enable delegation before answering. See the [tool contract](tool-contract.md#acceptance-selection-and-reasons).
- Off leaves the Owner open. Follow [session replacement and close](interface.md#session-replacement-confirmation)
  before exiting, switching sessions or using `/tree`.

## Model presets

A preset assigns one exact, host-registered **physical** `provider/model` and
one [effort policy](#effort) per difficulty slot. A model can serve several
slots. Virtual models (`pi-virtual`) can still be used by the parent, but not
for Agent slots. There is no fallback model. If new work reports
`PRESET_MODEL_UNAVAILABLE`, check the exact ID against your Pi registry; for
`THINKING_INCOMPATIBLE`, check the slot's [effort policy](#effort). A valid
preset selection doesn't verify credentials or remote availability.

The route is set when a new Agent is accepted. Existing Agents, including
queued and idle ones, keep their model, resolved effort and difficulty when
reused. Use a new Agent to change the route. Routing and permission profiles
are independent: the main model can choose `worker` or `scout` and a difficulty,
not a model or effort. See [profile capabilities](security.md#explicit-process-and-tool-boundary).

## Fast requests

`/fast` sets a **session ceiling**, not a guaranteed speed. For an eligible
parent or Agent request, Alehouse takes the lower of the ceiling and the
selected physical Codex model's configured limit: **Normal < Fast < Ultrafast**.
The choice is made before sending; there is no entitlement probe, timing
heuristic or retry at another tier.

| Command           | Session ceiling / behavior                                             |
| ----------------- | ---------------------------------------------------------------------- |
| `/fast off`       | Normal: do not add `service_tier`.                                     |
| `/fast on`        | At most Fast (`priority`), even on Ultrafast-capable models.           |
| `/fast ultrafast` | Up to Ultrafast (`ultrafast`); Fast-only models request Fast.          |
| `/fast status`    | Show the ceiling and the match for the parent without changing either. |

Bare `/fast` toggles between off and ordinary Fast; from Ultrafast it turns
off. New, resumed and forked sessions start off. Existing and new Agents
follow on their next eligible request; in-flight work, model, preset and
effort are unchanged. An explicit payload tier (including `null`) is never
replaced. If a tier change affects a reused WebSocket, Pi resends full context.

With a virtual parent model (`pi-virtual`), `/fast` still sets the ceiling for
eligible Agent requests but never adds a tier to the parent's requests, even
when Pi routes them to Codex. The request hook exposes the selected model and
payload, not the routed provider slot. Alehouse does not guess the slot from
the payload's model ID. Select a physical Codex model directly to use `/fast`
for the parent.

### Set model limits

Create `${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}/alehouse-codex-speeds.json`.
It is a **complete** manual table; unlisted models get Normal.
Values are `normal`, `fast` or `ultrafast`. A bare model ID covers every
registered physical Codex slot. An exact `provider/model` entry wins, including
when it lowers the limit. For example:

```json
{
  "gpt-6.2-sol": "fast",
  "gpt-6.2-astra": "fast",
  "openai-codex/gpt-6.2-sol": "ultrafast"
}
```

With `/fast ultrafast` this requests Ultrafast for primary-slot Sol, Fast for
numbered-slot Sol or any listed Astra, and no tier for any other model. If
a slot's account changes, review its entry. The file is read only at session
start; no project file is consulted and the command never writes the table.
An invalid or unreadable file disables all added tiers rather than restoring
more permissive defaults. `{}` explicitly disables all added tiers.

With **no file**, the compatibility default allows at most Fast for ten
physical Codex IDs from [OpenAI's pinned model catalog](https://github.com/openai/codex/blob/6c0cee502d215e5df2dd9a303cf2e252229c9e12/codex-rs/models-manager/models.json):
GPT-5.6 Sol/Terra/Luna, GPT-6 Astra/Sol/Luna, GPT-6.1 Sol/Terra and GPT-6.2
Sol/Astra. Ultrafast is never granted by default.

The table states what you allow Alehouse to **request**, not what the account
is entitled to or what the server actually used. Consult [Codex speed controls](https://learn.chatgpt.com/docs/agent-configuration/speed#codex-cli-controls)
and [pricing](https://learn.chatgpt.com/docs/pricing#speed-multipliers) before
granting Ultrafast: on GPT-6.2 it can use **6×** Standard included allowance
(Fast: **2×**). Pi's local cost estimate may not reflect the tier.

The footer and live Agent Details show the **matched** speed, not the session
ceiling: **⚡** for Fast, **⚡⚡** for Ultrafast, nothing for Normal or when
the label doesn't fit. These icons are not billing or historical indicators.

## Difficulty

Rate the reasoning, not the task kind, workload, cost, strictness, blockers or
queueing. The slot number matches the main model's `reasoning_difficulty`.

| Slot | Reasoning needed                                                                                                                                 |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `d1` | Mechanical or already specified.                                                                                                                 |
| `d2` | Clear path in a narrow scope.                                                                                                                    |
| `d3` | Multiple reasoning steps within clear boundaries.                                                                                                |
| `d4` | Cross-component constraints or competing hypotheses within known patterns.                                                                       |
| `d5` | First-principles design or proof (coupled invariants or interleavings, elusive causes, unstated cross-system semantics), or a reasoning impasse. |

An Agent's difficulty is fixed at spawn. Use a new Agent if follow-up work
needs a different difficulty.

## Effort

Set `effort` to `inherit` (the default when omitted), or to a fixed Pi level:
`off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`. A fixed level must be
supported exactly by that model; it does not require or follow parent thinking.
For example, Pi 1.6's GPT-6.2 Sol and Astra do not support `off`. A parent
using `off` can still allocate either model with a fixed level such as `high`.

In [Edit effort](interface.md#effort-editor), **preset default** removes an
override; it does not mean `inherit` if the slot has a fixed default.
Edits validate **all effective fixed slots**. If one is unavailable or
unsupported, the change leaves the live settings intact. Reset can clear bad
overrides; if the defaults are invalid, fix the model or preset. An `inherit`
preview or warning is advisory: the live parent level and model capability are
checked at new-Agent admission, not fixed by the preview.

### Automatic inherited thinking

1. Use the parent's exact thinking level if the slot's model supports it.
2. If the parent is `off` and the model does not support `off`, fail rather
   than turn thinking on.
3. For an unsupported enabled level, use the next higher supported enabled
   level in `minimal < low < medium < high < xhigh < max`. If none is higher,
   use the highest supported enabled level. If none is enabled, fail rather
   than turn thinking off.

For a model supporting `low`, `high` and `max`, an inherited `medium` becomes
`high`. If a model supports only `off`, it cannot inherit an enabled level:
choose fixed `effort: "off"` if that's intentional. Empty or unrecognized
capability metadata is not evidence of `off` support. Inheriting also requires
a valid parent level. These are label-matching rules, not equivalents in
compute or cost; pick a fixed supported level if rounding is undesirable.

## Preset configuration

### Neutral catalogue and model resolution

`pi-alehouse init` creates the required version-3 catalogue **only if absent**,
at `${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}/alehouse-presets.json`. The initial
file is `{ "version": 3, "defaultPreset": "off", "presets": {} }`. If the file is
missing or invalid, orchestration does not initialize. The UI never rewrites it.

To define a preset, replace the placeholder IDs below with exact models from
your Pi registry, choosing levels those models support. Keep `defaultPreset`
as `off` to opt in per session, or set it to your preset name to start enabled.

```json
{
  "version": 3,
  "defaultPreset": "off",
  "presets": {
    "my-crew": {
      "version": "1",
      "slots": {
        "d1": { "model": "example-provider/example-small", "effort": "off" },
        "d2": { "model": "example-provider/example-small" },
        "d3": { "model": "example-provider/example-medium", "effort": "inherit" },
        "d4": { "model": "example-provider/example-large", "effort": "high" },
        "d5": { "model": "example-provider/example-large", "effort": "high" }
      }
    }
  }
}
```

The file must be a regular file (or resolve to one), at most 256 KiB.
The catalogue accepts only the fields above and optional `defaultMode` and
`defaultEagerness` (use the lowercase [mode and eagerness values](#delegation-mode),
for example `"defaultMode": "co-worker"`). Preset names start with a letter
or digit and contain up to 64 letters, digits, dots, underscores or hyphens
(ASCII); `off` and `reload` are reserved. Each preset has a nonempty version
string of at most 64 characters and all five `slots`. Each slot accepts only
`model` and optional `effort`, not a `thinking` field or a separate mapping.

### Editing the base catalogue

Edit the file directly and run `/alehouse-preset reload` to reread it **without
switching the current name**. Changing `defaultPreset` or the catalogue mode
defaults does not change the current session. To switch, use
`/alehouse-preset my-crew` or the picker. If reload fails (for example, the
active name was removed or the file is invalid), the live selection is left
unchanged. Fix the file or explicitly select a name still defined in it.

The UI can also [create or edit presets](interface.md#settings-and-preset-editor).
Editing an existing preset there makes a custom definition of the **same name**;
that definition shadows base-file edits, even on reload. Remove the saved
override if present, then start a fresh session to use the base definition
without a branch override. Use a fresh process for manual edits to scoped
preferences; do not use Pi's `/reload` under an open Owner.

### Scoped user preferences

Optional **version-2** settings files are separate from the base catalogue:

| Scope                          | Path / effect                                                                           |
| ------------------------------ | --------------------------------------------------------------------------------------- |
| `session` (initial save scope) | No settings file is written. Live routing choices are still recorded in the Pi session. |
| `global`                       | `<agentDir>/extensions/pi-alehouse/config.json`                                         |
| `workspace`                    | `<current-cwd>/.pi/extensions/pi-alehouse/config.json`, only if the project is trusted. |

`<agentDir>` is Pi's agent directory, normally `${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}`.
The workspace path uses the current directory, not a Git-root search. A workspace
file can be committed and shared; writing it does not grant project trust.

Only `version` is required. The other accepted keys are:

| Key           | Value                                                                                                                                                                |
| ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `preset`      | Preset name or `off`.                                                                                                                                                |
| `delegation`  | `mode` and/or `eagerness`, using the values [above](#delegation-mode).                                                                                               |
| `effort`      | `{"PRESET":{"d1":"high","d3":null}}`, for example. An absent slot inherits the lower layer; `null` masks it and uses the preset default.                             |
| `presets`     | Custom definitions by name, each with the same `version` and five-slot body as a base preset. A same-name definition replaces the entire body, not individual slots. |
| `approval`    | `manual`, `judge`, `judge+sub`, or `yolo`; subject to [approval consent](interface.md#approval-menu).                                                                |
| `childSkills` | Boolean; see [Agent skills](interface.md#settings-and-preset-editor).                                                                                                |
| `ui`          | Optional booleans `beerMugs` and `borderLabels`; see [appearance](interface.md#beer-mug-easter-egg).                                                                 |

For example, keep a trusted project's default in Manual without changing its
selected models: `{"version":2,"delegation":{"mode":"manual"}}`. In that directory,
workspace values override global values, including explicit `false`; missing
leaves fall through. A globally saved preset or toggle can therefore still be
shadowed locally.

## Selecting and persisting

**To set future defaults**, open `/alehouse-settings` or **P Settings**. Use
**Change save scope** to confirm `global` or trusted `workspace` _before_ making
changes you want remembered. Changing scope copies and writes nothing on its
own. Subsequent applied choices can queue preference changes in that scope.

To save a snapshot instead, use **Remember current worker settings** or `G` / `W`
(**Save as global/workspace default**) from the picker or effort page. Confirm
the destination and exact patch. This saves the live preset, any selected
custom definition, mode/eagerness and the selected preset's effort choices,
not a highlighted preset, slider preview, live parent thinking or unconfirmed
draft. A changed snapshot or session requires fresh consent. This does not
change future save scope, approval, appearance or skill preferences.

- **Show paths and pending changes** lists trust, destinations, pending edits
  and effective defaults. Use **Save pending now** to write now, or let normal
  session shutdown flush the queue. Startup and restoration write nothing.
- **Discard pending writes** drops the queue without undoing live or recorded
  choices. **Remove a saved override** queues removal of one value so a later
  startup can use the remaining layers. It does not undo the live choice, and
  deleting a custom definition may leave its saved name unresolved.
- If saving fails, check the reported path. Failed patches stay pending while
  the session is live. A conflicting edit rejects the whole affected scope:
  discard the pending patches and restart to read the current file. The writer
  refuses symlink or read-only replacement. If publication is uncertain, inspect
  the file and lock before retrying; never remove a lock while a writer may still
  be active. See [settings trust and write safeguards](security.md#scoped-settings-and-trust).

**To know what will load**, start with the catalogue defaults, then global and
trusted workspace preferences. A restored branch's recorded preset name,
per-preset effort overrides, custom definitions and mode/eagerness take
precedence where recorded. Appearance and skills are read from preferences at
every startup, even on resume. The branch restores a preset **name**, not a
permanent pin to old models: a same-name definition may now route differently.
A missing saved name or an invalid settings file fails visibly rather than
falling back. Fix the named configuration or, for an invalid branch record,
start fresh or fork from before that record; do not rewrite the journal.

A cancelled/stale picker or a validation error does not publish its candidate.
If the parent-session record write itself failed with an uncertain outcome,
inspect the reported error and restart Pi before delegating or changing routing.
A settings save and a session record are separate; neither is a guarantee of
crash recovery. See [host and runtime limits](limitations.md#host-sdk-and-runtime-scope).
