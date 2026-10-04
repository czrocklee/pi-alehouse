# Interface

The interface is a projection of Owner state.  It never owns child sessions,
creates a second result store, or treats a paint/notification as lifecycle
confirmation.  Panels coordinate through one request/overlay protocol so that a
closing `ui.custom` cannot pop a newer overlay.

## Agent widget

The widget normally appears while child work is active and lingers briefly
after settlement.  An idle resident Agent alone does not necessarily keep it
visible; full capacity, an unanswered question, or retained diagnostics can
also keep it present.  Failed Runs remain inspectable for three parent turns
after their Agent is released; this diagnostic retention neither holds a
resident slot nor restores reusability.  Once it expires, released failures
leave the widget/detail roster and their child render state is dropped.

A row prioritizes warning/drops/pending/exceptional state, then identity and
statistics: latest Run state, original model ID without provider and its
creation-time effective effort (`[example-model/high]`), turn count/budget,
tool-call count, available context occupancy, cost, current turn duration in
parentheses, total submission duration, and the current task label. The nickname
is who; the description after `→` is what that Agent is doing on its latest Run.
For example:

```text
orca (editor/d3) [example-model/high] → Review GTK direct-entry safety · …
```

The identity tag joins permission profile and creation-time reasoning difficulty:
`(reader/d1)`, `(editor/d3)`, or `(researcher/d5)`. The slash separates two
independent properties; `d1` is easiest and `d5` hardest. The rating is not
thinking effort or permission strength, and reuse keeps it unchanged. A long
nickname is shortened before this tag. Crowded rows shorten warning/status
wording before losing a recognizable nickname and the tag; full diagnostics
remain in Agent details.

The task uses all remaining columns rather than a fixed 40-column cap. Warnings,
identity and compact metrics retain priority; when no readable task fits, both
its text and arrow are omitted. Row clicks still route by Agent ID, never by
nickname or task text. `run warning` means recorded `cleanup_errors` (including input/output
issues), not proof that resources remain held; exact diagnostics stay in the
detail pane.  Owner-level cleanup uncertainty has its own blocking state.

The activity line (`⎿`) exposes only the identifying argument of current work:
a path, command, or pattern such as `reading src/core/owner-controller.ts` or
`searching "createOwnerTools" in src`.  It never includes file contents, edit
text, or other payload.  Three or more concurrent calls collapse to counts.
During exit confirmation the activity line instead shows `draining Ns` and
whether tracked inputs/abort or SDK idle is still awaited. The detail pane and
`/harness-status` expose the same wait and elapsed time; this is an observation,
not a new lifecycle phase or permission to release ownership.
`?` marks a child waiting for an answer.  The heading says, for example,
`3 resident` or `8 resident (full)` rather than implying all slots exist.

## Agent detail and transcript

`Alt+A` opens the Agent detail pane.  A row click opens it, selects a different
Agent, or closes it when clicking the selected Agent.  `←`/`→` choose an Agent,
`↑`/`↓` scroll, and **only** `Esc` closes it, restoring typed editor text.  The
pane keeps focus: printable input is for the editor, not an accidental dismiss.
The title carries identity/task; live status and its spinner or outcome glyph
sit at the lower left, before the Agent/line counts, in both docked and floating layouts.

The pane shows the fields a row cannot: identity, profile/name/task, internally
resolved difficulty slot `d1`–`d5`, model, actual effort and its recorded source (fixed preset,
parent identity, or automatic mapping; user override when present). Historical
manual maps retain the distinct `preset map` label. Effort is
labelled fixed at creation, not editable on a resident Agent. The pane also shows
tool facts, phase, full cumulative usage split, active-tool arguments, streaming
draft, each stalling condition, and a child transcript.  Context occupancy is
separate from cumulative billed usage (`≈231k/272k tokens · 84.9%`); unknown
occupancy remains unknown.  Formatting shares rounded-unit carry rules with the
footer: compact counts use whole k above 10k, detailed billed usage retains
tenths, 999500 is `1.0M` compact or `999.5k` detailed, and 999950 never prints
`1000k`/`1000.0k`.

The transcript uses Pi's own message components so markdown, syntax highlighting,
thinking, skills, compaction, and branch summaries match the parent. Within the
compaction-aware branch it displays raw messages, including failed attempts
omitted from model context by SDK retry; context edits do not rewrite this
transcript. It follows
the live tail until the reader scrolls away and resumes when returned to the
end.  Pi does not export its built-in tool renderers and tool definitions do not
supply them, so native `read`, `bash`, and `edit` use a plain arguments/output
fallback.  This is an upstream SDK/UI limitation, not a custom imitation.
Transcript rows strip OSC 133 markers because repeated viewport emission must
not manufacture terminal prompt boundaries.  Full tool output remains visible
in the detail transcript; only the compact widget activity line is redacted.

On Pi's alternate/fullscreen renderer the pane floats as a centered overlay; on
the regular renderer it docks where the editor is.  This is a safety choice, not
a preference: regular overlays are composited into the scrollback backing array
and a later append can bake chrome into terminal history.  Unknown renderer mode
docks.  Fullscreen mouse reporting enables row clicks; in regular mode `Alt+A`
is the reliable entry.  Floating panes use shared rounded popover chrome,
centered sizing, wheel handling, and no outside-click dismissal.  Like every
floating popover, the pane closes from the `×` at the right end of its top edge
(` × ─╮`, five columns, all of them the target); below 9 columns the control is
omitted rather than painted unhittable.

## Delegation panel

`Alt+S`, bare `/harness-preset`, or a click on the footer's delegation indicator
(`co-worker/NAME ▴`, left of approval and health in the bottom-right group)
opens the Delegation panel; the same key or click closes it.

Its top section is the [delegation mode](routing.md#delegation-mode): a slider
`○ Manual ── ● Co-worker ── ○ Lead ── ○ Supervisor`, an eagerness box
`‹ balanced ›`, and the guideline line the main model receives (clipped when
narrow). `←`/`→`
move the slider and `Shift+←`/`Shift+→` step eagerness; with the pointer, click
a node or an arrow, or press on the slider, drag, and release to apply the node
nearest the pointer's column; while dragging, the guideline rows preview that
node (marked `preview`), and any key cancels the drag. Hover does nothing: Pi
reports no pointer leaving the panel, so a hover preview could outlive the
pointer. A mode or eagerness change applies at once and keeps the panel open. Eagerness is dimmed in
Manual; with `off` active the section is dimmed and says the mode applies when a
model preset is active. Narrow or short panels show `Mode ‹ Co-worker ›` with
clickable arrows instead of the slider, and short ones drop the guideline.

The **Model preset** list below it is the picker described next.  It uses the same fullscreen
floating / regular docked rule, is serialized to one picker per host, and cannot
open beside a detail pane or active approval. A zero-row host widget captures the
renderer independently of Agent activity, so the first open in an empty or Off
session still floats and joins the shared column in fullscreen.  `↑`/`↓` and `PgUp`/`PgDn`
navigate; `Enter` applies; `Esc` cancels.  Floating, it joins the bottom-right
popover column (below) and takes the pointer too: `×` cancels, a left click on
a preset applies it as a menu would, and the wheel moves the highlight so a
preset's slots can be read before choosing.  It displays the active
marker, each configured preset's version, exact
slot IDs in hardest-first order (`d5`, `d4`, `d3`, `d2`, `d1`), one per
reasoning difficulty, and current effective thinking levels, plus new-Agent
routing scope, clipping long names
to the terminal width. Inherited levels show the current preview after the
automatic supported-level rule; an unresolved preview says `unavailable`.
A `*` marks applied session effort overrides. Difficulty maps to
these slots one-to-one; the picker remains the operator view of resolved routing.
Model-facing roster replies report only `profile` and
`reasoning_difficulty` as their allocation fields. The first option is `off`: its detail explains that it disables new,
resumed, and steered work while accepted work continues, instead of showing
model slots. It appears as `off` in the footer; activity remains visible in
the existing widget rather than a duplicate roster. Choosing a model preset
enables new work again. **Save as global default** (`G`) and **Save as project
default** (`W`) remember the current applied worker settings, just like the
approval menu's save controls. They save the live preset, mode/eagerness and
active effort overrides—not the highlighted preset or slider preview. Project saving requires trust. Save labels shorten on narrow panels;
at minimum height they replace verbose navigation hints rather than adding rows.
**P Settings** routes to preferences; **N New** and
**C Edit** route to custom model-preset editing (C is unavailable on `off`).
Click a slot's model text, or press **1 / 2 / 3 / 4 / 5** for `d1`–`d5`,
to edit only that model. Digits address slot IDs, not row positions: **1** still
edits `d1` and **5** edits `d5`. These routes close the picker before opening their
next dialog; permission prompts cancel an open model selection without applying.
The picker returns a candidate name or management route. Effort changes use a
synchronous callback; routing code owns validated audited publication.
Short panels show a window of the five slots: `Tab` / `Shift+Tab` moves that
window while `↑` / `↓` still navigates presets. Only painted model text is a
mouse target; **1–5** remains the direct keyboard route to each slot. Compact
rows retain mode/eagerness shortcuts when they fit. Below the minimum usable
viewport, routing, editing, settings and saving do nothing; cancellation and
return from the effort page still work.

### Effort editor

With a model preset highlighted, press `E` or click **Edit effort**. For the
active preset this switches pages inside the same custom component. An inactive
preset first closes the picker and asks to select/enable it; cancelling changes
nothing. Confirming audits the selection and reopens its effort page. `off` has
no effort editor. The editor always states **new Agents only; main unchanged**:
accepted running, queued, idle and resumed Agents keep their original allocation.

- `↑`/`↓` follows the displayed `d5`→`d1` order, starting at `d5`;
  `←`/`→` changes the selected policy
  immediately after validation and synchronous audit. Pointer arrows behave the
  same; scrolling, **1–5**, and slot-label clicks only move the selection. Short
  panels scroll the slot window to keep the selected slot visible. Bounded arrows
  that cannot change the value do not audit.
- **preset default** removes that slot's override. **inherit** explicitly follows
  parent thinking at creation, with a current resolved preview or advisory warning.
  Inheritance warnings (including unavailable models) never block saving; the
  actual check happens at spawn. Other values are fixed levels supported by
  that model in Pi's registry.
- `R` / **Reset** immediately removes all five overrides, restoring preset
  defaults. It does not necessarily select `inherit`.
- Every proposed change validates all effective **fixed** slots against fresh
  model metadata before audit/publication. An unavailable model or unsupported
  fixed level rejects the whole change and retains the last committed values;
  nothing is automatically downgraded. Multiple invalid overrides may require
  Reset; invalid defaults require model/preset or base-catalogue repair.
  `inherit` slots are saved without resolving current parent thinking.
- `Enter` or `Esc` returns to the list without undoing changes. `Alt+S`, the
  footer toggle, `×` or a permission dialog closes the picker, also without undo.
- `G` / `W` offers the same confirmed global/project snapshot saving on either page.

There is no effort draft or Apply step. Successful changes update the footer;
`preset*` means an applied session override. Each preset remembers its own
overrides in the current session branch. Restoring that session restores them;
a fresh session uses scoped preferences if present, then the catalogue
`defaultPreset` and its effort defaults. This editor never writes the base
`harness-presets.json`; explicit persistent-scope changes queue preferences in
`config.json`, otherwise changes remain session-only. A stale picker cannot
overwrite a newer selection. Repeated edits continue the already-presented
catalogue without rereading configuration, and validation failures do not mark
parent history as uncertain.

Narrow layouts retain effort controls and trim model text first. Fullscreen uses
the existing bottom-right popover column; regular mode stays docked and every
action remains keyboard-accessible. Agent details separately display the actual
creation-time route, which may differ from the current picker defaults.

## Settings and preset editor

Open **P Settings** in the Delegation panel or run `/harness-settings`. Every
new Pi session starts with save scope **session**. The menu offers **Change save
scope**, **Remember current worker settings**, **Save pending now**, **Discard
pending writes**, **Remove a saved override**, and **Show paths and pending
changes**. Choosing global or workspace as the future scope requires a
confirmation; changing scope alone copies and writes nothing. Workspace scope
is available only for a trusted project and targets the current working
directory, not a discovered Git root.

The Delegation panel's **Save as global/project default** (`G`/`W`) and
**Remember current worker settings** use the same snapshot confirmation. The
picker closes before the dialog opens; the dialog shows the exact patch and
destination. Saving changes neither the live choices nor the future save scope.
If the worker settings or session change while confirmation is pending, nothing
is staged. G/W work on both the list and effort pages; successful effort edits
are already live before snapshot saving.
The snapshot can remember the selected preset, delegation
mode/eagerness, explicit effort overrides (including `null` to mask a lower
scope and use the preset default), and the custom definition when the selected
preset is user-defined. Approval defaults are saved in the approval menu (or
with `/approval save`). A saved
preset name resolves against the current base catalogue when next loaded; an
explicit custom definition is stored in the preference layer. Branch records
from an existing session still take precedence over fresh-session preferences.

Persistent settings are staged only after an explicit, successful live user
action. Nothing is written during startup or session restoration, and a
highlighted preset, slider preview or unconfirmed custom-preset draft is never saved. **Save pending now** attempts the
queued writes immediately; **Discard pending writes** leaves current live and
session choices alone. **Remove a saved override** removes a selected leaf so
the next startup follows a lower layer; removing a custom preset can leave a
saved selection unresolved. **Show paths and pending changes** displays the
active scope, targets, staged patches, trust state, and effective preferences.
Normal `session_shutdown` flushes pending writes, including ordinary `/new`,
`/resume`, `/fork`, or reload shutdown. This does not make live-Owner `/reload`
supported; see [session replacement](#session-replacement-confirmation) and
[limitations](limitations.md).

Use **N New** or `/harness-preset-edit` to create a user model preset; use **C
Edit** on a highlighted preset or `/harness-preset-edit NAME` to edit it. The
interactive editor reuses Pi's native `/model` selector, including fuzzy search
and the active keybindings, separately for each slot in `d5`→`d1` order.
This is editing order only: the reasoning score still increases from 1 (easiest)
to 5 (hardest), with unchanged one-to-one routing.
The title names the preset and slot; the current slot model is preselected when
available. It uses the session's public `scopedModels` snapshot—the same current
range `/model` uses, including `--models` and `enabledModels`. **Tab** switches
between **all** and **scoped** through the native component; with no configured
scope it shows all available models, just like `/model`. Virtual models are
removed from both lists. Scope is read again for each slot, not copied from
settings at startup. Choosing a model returns it to the preset draft: it does not change the main model or Pi's
model defaults, and the native main-model default-save action is not connected.
Escape cancels the draft. RPC clients retain the standard model-list dialog.
Each slot stores its model and catalogue effort default in one `slots.dN`
object. Inheritance maps unsupported enabled levels automatically; there is no
compatibility-map editor or configuration. Session/scoped effort overrides remain separate from
that definition. After confirmation, it audits and selects the edited/created preset;
this changes only the user model catalogue: permission profiles `reader`,
`editor`, and `researcher` remain fixed and are not editable. Changing a preset
affects future Agent admissions; accepted Agents keep their allocated
configuration, and the main model is unchanged. The selected model's current
SDK-supported levels determine inherited thinking at admission.
Existing session effort overrides are retained and may mask newly edited
catalogue defaults; use **E Edit effort** to change or reset session overrides.
For a single-slot edit, selecting the model applies immediately to an active
preset through the same validated audit. Editing an inactive preset asks before
enabling it and replacing the current selection. Cancel or selecting the same
model changes nothing. Other models, default efforts and session overrides are
kept; unsupported fixed efforts block the change, never downgrade silently.
In fullscreen the native selector uses a closable rounded popover near the
clicked model (centered for keyboard entry), clamped to the terminal. Painted
model items are clickable; search, IME focus and Tab remain native. Short screens
reduce the list around its selected item; a too-small viewport cannot apply an
unseen choice. Enter and a model click recheck the current terminal size and
the submitted model. A previous paint cannot authorize a choice that is no
longer visible. An unseen keyboard choice shows a warning; an unverified model
identity cancels that draft with a warning to reopen/refresh, rather than
silently leaving a disposed native selector waiting. Regular TUI stays docked. The worker panel is not auto-reopened.
Direct settings/editor commands and picker routes share one interaction latch;
Agent detail and Delegation panels cannot open over that dialog sequence.
Permission yield is rechecked before each model selector, including queued factories.

Preset definitions are additive to the required base catalogue and do not
rewrite it. Editing a base preset creates a same-name custom definition that
shadows subsequent base-file changes until removed. As with `/model`, the native selector may refresh provider catalogues
using the host's normal credential and model-cache handling; those operations
are separate from Alehouse's exit-time preference saves.

See [routing](routing.md#scoped-user-preferences) for file paths, schema,
layering, and filesystem safeguards.

## Approval menu

Click the footer's approval indicator or run `/approval`. In fullscreen
Alehouse, choose a mode; the menu stays open and `●` marks the live mode.
Click **Save as global default** (`G`) or **Save as project default** (`W`) to
use that live choice in future sessions. The confirmation shows the value and
full destination path. Normal exit writes it; no separate settings menu or
save-now action is required. Just closing the menu keeps a session-only choice
unless a persistent save scope was explicitly selected in worker settings.
Project saving requires project trust.

Saving a default does not change the current live mode or the shared settings
scope. It saves the live `●` choice, not a highlighted or first-click-armed
mode. Wider judge defaults may need startup confirmation, and YOLO always needs
fresh confirmation for each session. Existing sessions keep their branch
choices; project defaults take precedence over global defaults. In ordinary Pi
without an Alehouse settings store the save controls do not appear and a mode
choice still closes the menu.

The command alternative is `/approval save [global|workspace]`; without a target
it asks **All projects** or **This project**. Regular-renderer Pi uses standard
dialogs rather than a floating menu.

## Session replacement confirmation

`/new`, `/resume`, `/fork`, clone, and import replace the parent runtime only
after confirmed Owner closure. A fresh Owner that has never accepted a Run starts
its shutdown before the replacement guard first awaits and can proceed
automatically once closed. If this Owner ever accepted work—even work now
completed or released—the host presents a confirmation. Only an explicit **Yes**
starts drain; cancel, an unavailable/headless UI, a missing/undefined answer, or
an error obtaining confirmation does not start shutdown or replace the session. The confirmation
names all Owner work and warns that work accepted while it is open is also stopped,
and that closure is permanent even if a later hook vetoes or destination opening
fails. A second replacement target while this dialog/drain is pending is rejected
and must be retried; it never inherits the first target's answer. That pending
latch ends when the guard returns after closure. Pi does not serialize downstream
teardown, other hooks, target loading, or replacement construction, so this is
not an atomic close-and-replace transaction: wait for each replacement operation
to finish before starting another.

This automatic/confirmed path is distinct from `/harness-close`, which remains
the explicit user command to cancel/drain and permanently close the Owner. `/tree`
changes the current session in place rather than creating a fresh Owner, so it
never uses automatic closure: the UI explains the block and requires explicit
`/harness-close`. UI paint or a notification is not closure evidence; only the
closed Owner state permits replacement. `/reload` remains unsupported while an
Owner is open.

## Footer and usage popover

The status footer remains an independently bundled sibling extension and works
without the harness.  Its one clipped, never-wrapped row includes main-session
usage plus worker totals delivered through normal Pi `usage`.  It groups model
rows by `provider/model` that actually answered. For a Pi virtual parent
selection the model label shows `selection → physical` after a successful
response on the active branch; before that it shows only the selection.
Subscription marks use the provider's OAuth subscription metadata and actual
OAuth state, plus the existing Kimi exception. Native OpenAI ChatGPT login does
not imply Codex quota headers: `x-codex-*` handling remains Codex-only.
Harness-provided `usage.harnessModels` permits per-worker model rows; unattributed totals stay in
the `tools` lump.  Main compaction/branch summary uses `main · compact/summaries`;
model-attributed child compaction displays `worker compact · model`, avoiding
duplicate-looking rows.  The widget and detail pane use `≥` where they render a
partial observed-cost floor.  Pi's footer/native totals ignore completeness
metadata and show reported amounts; they must not be read as a completeness
claim or as free usage.

In fullscreen, clicking the bottom status row toggles a pinned per-model usage
breakdown.  Hover does nothing; typing, pasting, and table clicks do not dismiss
it.  Click the footer again or its `×` to close it.  The footer's reserved row
is separate from popover chrome.

A click on a status segment is first offered to the extension that owns it over
`pi-footer:indicator-click` (`{ key, handled }`, shared in `lib/overlay-protocol`);
the harness claims its `harness-preset` indicator synchronously.  Unclaimed
clicks, and clicks elsewhere on the row, toggle the usage breakdown.  The corner
keeps a fixed left-to-right order: usage, delegation, approval, then health
at the right edge (`co-worker/my-team ▴ · YOLO ▴ · ○ idle ▴`). Delegation and
approval show only their values, without the `delegation:` / `approval:` labels. The footer banner
omits preset versions; the picker and Agent details retain their versions. Status keys and
click routing stay unchanged; YOLO retains its red/bold warning styling.

Narrow rows first omit cache detail and shorten the delegation value with an
ellipsis, then omit whole usage/other-status items and, if necessary, the
delegation control.
Approval and health have priority. At extreme widths their carets disappear,
then health collapses to its existing glyph; if both still cannot fit, approval
is omitted whole rather than displaying a misleading partial mode. Click spans
follow exactly the fitted ANSI/CJK-aware layout on every paint and resize.
Full values return when space permits. Popover opening order is independent of
this fixed footer order.

## Optional footer network integrations

Quota headers still contribute to ordinary display/accounting without any opt-in.
`AGENT_DASHBOARD_URL` enables quota-dashboard HTTP POST to that explicitly
configured URL; when absent there is no implicit localhost dashboard POST.
Grok billing network and Pi auth-file access run only when
`PI_ALEHOUSE_GROK_BILLING=1`. `GROK_CLI_CHAT_PROXY_BASE_URL` optionally selects
the Grok billing proxy base URL (otherwise the built-in proxy endpoint is used)
and is relevant only when billing is enabled. The billing path reads the actual
Pi `getAgentDir()` auth file; do not enable it on an untrusted host. These opt-ins
do not authorize child web tools or change the permission boundary.

## Health and Stats

The footer's health indicator stays at the far right, after routing and approval.
It shows observed main/managed-worker activity and attention (`○ —` before
observation, `○ idle`, `● busy`, `? wait`, `! error`), not a synthesized
performance grade. A worker can keep it busy while the parent is idle. Click it or use `/stats` to
open a separate, centered view with Overview / Models / Tools tabs. Use
`Tab` / `Shift+Tab` or `1` / `2` / `3` to switch views; arrows, paging and the
wheel scroll; `Esc` or `×` closes. The small usage popover remains unchanged.
Stats is not part of the bottom-right column and does not widen those popovers.

Measurements cover the current parent observation window, including managed
child LLMs and tools, but not historical sessions. Main wall/busy/idle time stays
separate from summed worker busy durations. Models and Tools label `[main]` and
`[worker]` separately; same-provider/model worker rows merge using TTFT sample
counts and timed output/token totals, never averages of rates. Resume continues
its worker's counters; release preserves bounded totals without retaining the
child session. Release is permanent, so observed workers are Agent lifetimes,
not Run counts. Red health is limited to provider failures or failed worker Runs
(including port admission failure); tool errors remain counters only. Current
worker failures clear on a new Run or retirement, while historical error counters
remain visible. Models use the actual response model
when reported. TTFT is first nonempty effective output, which can be thinking or tool arguments;
first-text time is separate. Latencies start at the foreground SDK `turn_start`
and include preflight; they are not transport-only timings. Uncorrelated
provider hooks also fire during cache warming and are deliberately ignored.
TPS uses reported output tokens over this SDK-turn time, not stream-chunk counts
or decoder speed. Cumulative LLM/tool time can overlap
and is not an additive breakdown of session wall time. Missing and partial
measurements are labeled; no timing is invented from older transcripts.
Parent-side approval wait, including forwarded asks, is counted once. Worker
usage forwarded in tool results is never re-counted as another model response.
Compaction, cache warming and queue/initialization breakdowns remain outside
this view. The optional worker hook sends metadata only, not prompts, deltas,
arguments or tool output; teardown makes old sinks inert across parent windows.
Health changes notify immediately using lightweight state reads. Streaming
updates the collectors without rebuilding detail snapshots; table aggregation
happens when the view paints, with a one-second numeric refresh.

A raw overlay handle closes exactly Stats, even when a newer overlay is above
it. Stats yields by closing on permission/UI prompts or harness custom-panel
settlement; decisions never resurrect it over another dialog. A session switch
clears observations, overlays, observers and timers. Regular mode shows a
non-modal summary instead, avoiding scrollback pollution and prompt-queue holds.
See [limitations](limitations.md#ui-scope) for UI/Stats scope limitations.

## Bottom-right popover column

The usage breakdown, approval selector and floating routing picker share one
bottom-right column above the footer, through `lib/popover-stack`.  The first
opened rests on the footer and later ones stack directly on top; closing one
drops everything above it into its place.  Every open popover uses the widest
member's preferred/minimum width, clamped to the terminal, so both left and
right edges align.  Content changes, opening/closing the widest member and
terminal resizes update the entire column without reopening panels.  Temporarily
stepping aside preserves both place and width.  Each popover is capped to the
rows left above those below it and waits off screen until its smallest usable
layout fits (three rows by default, seven for the picker, every choice plus the
yolo warning for the approval popover), so controls and the bottom edge are
never clipped.  Pi focuses a capturing overlay only when it is shown on screen,
so a picker or approval popover that appears later takes the keyboard itself --
unless focus has moved since it opened, in which case that dialog keeps it.  The footer and harness are separate bundles, so the column lives in a
process-wide registry keyed by the TUI both draw into.  When a harness panel
closes, the usage breakdown steps off the overlay stack (Pi's `ui.custom` close
pops the top overlay, not its own) and returns on the next tick, keeping its
place in the column meanwhile.  In regular TUI mode the
footer totals remain but the popover does not open; multiplexers commonly require
click rather than hover motion.

The footer, usage width preference and usage panel paint share one grouped spend
snapshot per native frame. Repeated width queries from other popovers do not
walk the transcript again. A new footer render or lifecycle/UI invalidation
refreshes the snapshot; viewport-dependent table layout still recalculates for
resize and changing stack budgets.

## Approval-dialog yield

The process-wide `ui-prompt-queue` serializes non-overlay `ui.custom` dialogs.
A docked detail pane would otherwise occupy the queue head and delay a parent or
forwarded child permission dialog until the queue's ten-minute stall handling,
which can surface to a child as denial.  The harness observes synchronous
`permissions:ui_prompt` before dialog construction and yields immediately:

- a floating pane hides through its overlay handle and retains selection,
  transcript, and scroll position;
- a docked pane is closed and rebuilt only after approval completion and old teardown;
- an opening request that is still queued records cancellation and settles
  without mounting when dequeued;
- a pane refuses to mount while an ask is visible or its yield gap is held.

`permissions:decision` or the managed authority's observation-only
`managed-permissions:ui_prompt_end:v1` completes the matching ask. The latter
also covers UI exceptions/timeouts whose fail-closed decision has a different
ID. Only completion of the last ask can reopen the prior pane after the queue
is safe; neither event invents permission or clears unrelated worker asks.
The terminal title and Stats wait use the same per-ID completion signal.
Mounting always uses the wrapped session-start UI context, not the unwrapped
shortcut context.  Payload parsing is defensive and observers swallow errors:
they run inside an emit that protects the permission dialog.  Timeout/failure
handling closes the actual custom UI before the queue advances; late callbacks
cannot close a later dialog.  Pane construction/disposal is idempotent, including
an asynchronously handed-off component and its redraw timer.  Restart Pi after
queue changes; `/reload` does not replace the already wrapped serializer and is
unsupported with an open Owner.
