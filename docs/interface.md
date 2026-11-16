# Interface

The interface is a projection of Owner state. Rendering never issues lifecycle
commands, owns child sessions, creates a second result store, or treats a
paint/notification as lifecycle confirmation. Explicit human input may submit a
Run-bound intent to the host, which invokes the existing Owner command; only the
core changes lifecycle state. Panels coordinate through one request/overlay
protocol so that a closing `ui.custom` cannot pop a newer overlay.

Border and row-count descriptions below assume the default **Border labels: on**.
The global [Border labels](#border-labels) switch relocates all Alehouse chrome
inward when off; a label band then costs three rows instead of one. Bare edges
without a label band and existing interior controls do not gain blank bands.
Agent details reserve the footer band even when its labels yield completely at
narrow widths, keeping its height and control coordinates stable as labels return.

## Close-button feedback

Every Alehouse panel with a top-right `✕` highlights that glyph in bold accent
when the pointer is over the glyph's single terminal cell. The glyph sits on
row 0 by default and on the interior title row (row 1) with border labels off. Hover is visual
only: it does not close a panel, take keyboard focus, select a model or mode,
or arm an Agent stop. Moving away, hiding the panel, invalidating its geometry
or disposing it clears the highlight; tiny layouts without `✕` have no hover
target. A left press in that 1×1 cell claims the gesture; release in the same
cell closes. The whole character cell counts, not just the glyph's painted
strokes; adjacent spaces, rules, the corner and other rows do not. Press alone
never closes. Leaving the cell, hiding the panel or changing its painted
geometry cancels the gesture; a later synthetic left click cannot revive it or
activate a body control. Any new press, including a different button, ends the
old close gesture; only a left press can arm a new one. Unpainted controls are
not clickable. Narrow Approval chrome fits the title around the close control;
zero-row Stats and the model selector's “Too small” fallback have no invisible
close hot spot.

On the supported native viewport adapter, gesture observation stays attached
independently of hover while a claimed gesture or its trailing events are
pending. A native dispatch that does not reach that panel interrupts the old
close intent, including terminal focus-out and a new press in the transcript.
A later selection release over `✕` cannot close the panel or discard an Agent
message draft. Interruption does not consume an unrelated selection release;
a delayed click from the old claimed press remains suppressed. This observer
forwards input unchanged and does not acquire mouse capture or alter the SDK's
selection state.

Hover cleanup, pointer-target validity and keyboard navigation are separate.
Moving or hiding a panel retires its old pointer targets until a fresh paint,
without dropping otherwise-valid keyboard navigation. The picker retains its
layout-based keyboard navigation across theme invalidation; Context retains its
snapshot/epoch checks for semantic activation. Cleanup performed during layout
does not request an extra frame.

This requires fullscreen mouse-motion reporting and the supported host input
adapter. Terminals/multiplexers that do not report motion keep ordinary click
and keyboard behavior. Keyboard input conservatively clears the highlight until
the pointer next moves; hover never needs a polling timer.

## Agent widget

The widget shows child work while active and lingers briefly after settlement.
In fullscreen mode, idle residents keep a compact heading even after their
outcome rows age out. Click anywhere on the heading to expand the whole inspectable
roster or return to the automatic compact view. Its leading marker is `▸` when
collapsed and `▾` when expanded; there is no separate trailing disclosure arrow. Expansion shows the whole roster
when it fits, otherwise pages through idle residents and individually listed
queued Agents using **[Prev]** / **[Next]**; Agent rows still open their details.
The widget uses at most thirteen lines (a heading plus twelve settled Agents) and at
most one third of the terminal height (six lines if host height is unknown),
and additionally reserves normal SDK input chrome and transcript space rather
than growing the input dock without limit. Owner-blocked diagnostics sit above
the paginated body, or take the sole widget line at minimum height. Very small
viewports suppress the widget or expansion controls; use `Alt+A` for inspection
instead. Compact view retains
its activity/attention priority within the same height budget.
In regular/unknown renderer modes there is no mouse-only disclosure arrow, and
ordinary idle headings disappear once outcome rows age out. Full capacity,
owner-blocked diagnostics and attention rows remain visible within the budget;
`Alt+A` remains the inspection entry. Expansion is presentation-only and does
not restart work or reset retention.

Detached display snapshots refresh on wake/turn/active ticks and explicit heading
inspection, not unrelated editor repaints. There is no idle animation interval;
out-of-band state changes while idle appear at the next explicit refresh, not
through a background monitor. Fresh detail reads and command-time target checks
do not use this display cache.
Failed Runs remain inspectable for three parent turns
after their Agent is released; this diagnostic retention neither holds a
resident slot nor restores reusability. Once it expires, released failures
leave the widget/detail roster and their child render state is dropped. Child
session shutdown clears live activity but does not sever the retained transcript
reference during this diagnostic window; the observation registry retires it.

A row keeps identity, configuration and compact metrics together, with the
variable-length task label last: latest Run state and nickname, permission
profile/difficulty, original model ID without provider and its creation-time
effective effort, turn count/budget, available context occupancy, per-Agent
cost, total submission duration, then the current task with any parenthetical
attention suffixes. Pending alerts, recorded warnings and lifecycle wording do
not occupy a separate column: for example, `Review gate (1 pending)`,
`Review choice (needs answer)` or `Review failure (failed: SDK broke)`.
Aligned rows share roster-local column widths, with text left-aligned and
numeric values right-aligned. The turn marker and `ctx` label stay at their
metric cells' left edges, with extra padding before the values. Quiet rows reserve
no attention padding for another Agent's suffix. Groups use spaces, not additional
vertical dividers; metrics follow configuration instead of being pushed to the
terminal's right edge.
The nickname is who; the final description is what that Agent is doing on its
latest Run. For example:

```text
⠋ orca  worker/d3  example-model/high  ↻3/80  ctx 17%  $0.08  45.6s  Review GTK direct-entry safety
```

Tool-call counts are not shown in compact rows, and the heading has no cost
rollup. Actual tool activity remains visible below the row, and the detail
pane retains its tool counts and accounting fields.

The identity tag joins permission profile and creation-time reasoning difficulty:
`worker/d3` or `scout/d5` for new Agents (parenthesized in compact fallback rows). Worker maps to the stable
internal `editor` ID; scout maps to the stable internal `researcher` ID.
The slash separates two
independent properties; `d1` is easiest and `d5` hardest. The rating is not
thinking effort or permission strength, and reuse keeps it unchanged. A long
nickname is shortened before this tag. Crowded rows shorten warning/status
wording before losing a recognizable nickname and the tag; full diagnostics
remain in Agent details.

Permission dialogs also display `worker` or `scout`, while authorization, forwarded
principals and Jev provenance retain the internal `editor` or `researcher` identity. This is a
label projection, not a profile alias or a change to approval scope.

The combined task field uses all remaining columns rather than a fixed
40-column cap. Attention suffixes reserve their space before task text is
clipped; optional model and ordinary metrics yield before essential facts,
bounded failure explanations and the preferred title allocation. The grid's
24-cell title preference is separate from its facts, not a 24-cell combined
budget. Failure details have their own per-row allowance up to 60 cells; one
row's longer title does not impose a shared minimum detail allowance on its
siblings. Fitting and painting use the same row plan, including the short
`(limit)` alternative before degrading facts or discarding a cause.

An optional title cannot steal the preferred nickname's cells. A short title
must fit whole; an ellipsized title needs at least four literal terminal cells,
not counting the ellipsis, or it is omitted. Narrow rows shorten warning/status
wording first (including the existing `cancel`/`finish` forms), without moving
facts back into a separate column. At impossible widths the header clock/tag
may yield whole, then an unfitting limit or entire attention group is omitted;
structured counts and markers are not handed to the outer clip as misleading
partial digits, words or parentheses. Row clicks still route by Agent ID, never by
nickname or task text. `run warning` means recorded `cleanup_errors` (including input/output
issues), not proof that resources remain held; exact diagnostics stay in the
detail pane. Owner-level cleanup uncertainty has its own blocking state.

A reached turn limit is appended to that Agent's task label as
`Review lifecycle (turn limit reached)`, with only the parenthetical suffix in
warning color. It remains the final suffix, after any other attention group:
`Review gate (1 pending) (turn limit reached)`. Neither group reserves an empty
attention column on other Agents' rows. Long task text yields before these
suffixes; narrow layouts may shorten the limit to `(limit)` and other facts to
their compact forms. Each fact retains its semantic color independently of
the title. The limit is an independent observation, not proof that execution
stopped or that the Run failed.

The activity line (`⎿`) keeps its existing tree indentation and distinguishes
tools, public thinking, and ordinary assistant prose without adding rows or
bracket tags. When available, the current-turn elapsed time precedes the
activity as `7.2s reading …`, separated by one space and without a `turn` prefix.
This clock still measures
the current turn, not the displayed tool or thought; changing tools does not
reset it. It is not combined with the total submission time above. If the
activity line is omitted for space, its clock moves to the first row instead;
at extremely narrow widths that header clock may yield whole to identity and
complete facts. Exited or finishing execution has no current-turn clock. Tools keep their action
words (`running`, `reading`, `editing`, `searching`): the action is dim and its
argument muted, with no fixed-width padding. The complete activity text uses
the host theme's italic styling, including action words and preview content;
the separate clock and tree indentation stay upright. Structural
themes without an italic helper retain the same colors and spacing. These are
semantic theme roles, not a promise of fixed contrast or italic font support in
every terminal. Tool previews select only
identifying argument fields such as a path, command, or pattern; they do not
separately project read/write file bodies, edit payloads or tool output. A shell
command can itself embed file content (for example a heredoc); this is a clipped
command preview, not a shell-body redactor. Two concurrent calls share the line, donating unused short-call
width to the longer call; three or more collapse to counts. Identifying arguments
have a separate bounded storage limit, not a fixed 72-column capture limit;
actual width fitting happens at paint time, with consistently styled `…`.
Actual tool observations take priority over generated prose, including while
cancelling, draining or finishing. Streamed tool arguments instead display
`preparing write…` (or `preparing tool…` before its name is known), never execution
or thinking. Neither that label nor a paint proves tool admission.

Public generation previews use `thinking: …` and `replying: …`, with the same
dim-prefix/muted-content treatment and italic styling across both prefix and
content, including the empty `thinking…` and `replying…` placeholders. They show the last nonempty logical line,
including an unfinished line, anchored at the left and ellipsized on the right
to the available terminal width. Only leading Markdown headings/list markers
(with one-to-three-digit list numbers) and leading bold markers immediately
followed by a Unicode letter or number are simplified. This includes unfinished
leading `**` so heading closure does not shift the left edge. Leading globs such
as `**/*.ts` and `**/foo/**`, inline globs, arithmetic and code are left literal; this compact heuristic is
not a Markdown parser and does not rewrite the native transcript. Tool arguments
never undergo this simplification. Each channel retains a bounded line prefix,
not a scrolling suffix. The active output channel is named `channel`, independent
of Owner generation identity. Empty text uses `replying…`; otherwise an empty
preview retains the quiet `thinking…` placeholder. This is not proof
that the provider has exposed thinking text. Providers may return a delayed
reasoning summary or no visible thinking at all, not their full internal reasoning.
These ephemeral UI observations never enter parent model results, Stats, or an
additional journal. New messages/turns, message completion, retries, compaction,
settlement and Run reuse retire previews so old text cannot reappear after tools.
Retry/compaction, cancellation and finishing suppress generated previews using
one shared presentation rule; with no actual tools they show plain status wording,
not an additional `[state]` label. A retry's assistant response start restores
live generation previews rather than waiting for that response to finish.

During exit confirmation, when no tool is still observed, the activity line shows
`draining Ns` and whether tracked inputs/abort or SDK idle is still awaited.
The detail pane and `/alehouse-status` always expose that wait and elapsed time,
including while the compact line retains a real tool. This is an observation,
not a new lifecycle phase or permission to release ownership.
`?` marks a child waiting for an answer. The heading gives a compact
resident-only status summary without a redundant total, for example
`▸ Subagents · ▹2 ✓1` or `▸ Subagents · ?1 ▹1 ◦1 ✓1`;
expanding the first shows `▾ Subagents · ▹2 ✓1`. An idle full roster can show
`▸ Subagents (full) · ✓12`.
Nonzero counts appear in order: needs input `?`, dim static active `▹`, queued `◦`,
dim completed `✓`, failed `✗`, cancelled `■`. In both compact and expanded headings,
the active rollup uses a static, dim `▹N` (small hollow triangle, text presentation); animation stays
confined to active Agent/detail rows. Released failures can linger in the body
but never inflate resident summary counts. `(full)` stays beside `Subagents`.
A dim `·` separates this prefix from a nonempty summary, including in
regular mode; no summary means no separator. Narrow headings drop both together.
The leading marker stays at column zero as counts and capacity change. The title retains the existing active,
idle or Owner-error theme color; the explicit warning row carries the fault.
Without usable heading inspection (regular/unknown renderer, no projected rows,
insufficient height/control budget, or a title/capacity prefix too wide to fit),
the marker stays a static `●`/`○` status dot.
Heading clicks are disabled there; `Alt+A` remains the inspection entry.

### Beer-mug Easter egg

Arrows are the default. In `/alehouse-settings`, select **Beer mugs: off** or
**Beer mugs: on** to toggle `🍺 Subagents` (collapsed) and `🍻 Subagents`
(expanded) immediately. The initial **session** save scope keeps the change
session-only and creates no file. To remember it, use **Change save scope** to
confirm **global** or trusted **workspace** before toggling, then **Save pending
now** or normal exit writes just `ui.beerMugs`. Other preferences are preserved.
**Remember current worker settings** does not include this appearance choice.

Alternatively, add `ui.beerMugs: true` to the version-2
[scoped preferences](routing.md#scoped-user-preferences), preserving other settings:

```json
{
  "version": 2,
  "ui": { "beerMugs": true }
}
```

The global path is `<agentDir>/extensions/pi-alehouse/config.json`; a trusted
project can override it at `<current-cwd>/.pi/extensions/pi-alehouse/config.json`.
Missing or `false` uses arrows. Saved preferences are read at session startup;
manual file edits need a fresh Pi process, not a live-Owner `/reload`. The menu
toggle needs no restart and changes no worker behavior. Discarding pending writes
or removing a saved override leaves the current appearance unchanged. When
inspection is unavailable, the opt-in marker stays `🍺`, never `🍻`, and clicks
remain disabled.

### Border labels

**Border labels: on/off (all Alehouse panels)** in `/alehouse-settings` is one
shared appearance switch. It defaults to **on**, preserving titles, tabs,
close controls and action hints on panel borders. **Off** keeps the frame but
moves that chrome into interior rows, separated from content by plain rules.
This applies to Agents, Delegation, model selection, Context, Stats, Approval
and Usage panels; it does not restyle native Pi or third-party components.
There are no per-panel overrides. Existing interior controls stay interior.

The toggle takes effect immediately, invalidating old pointer targets and armed
pane actions without submitting them. Extra chrome rows reduce the available
body viewport; tiny panels can suppress controls rather than expose unseen
hit targets. Keyboard navigation remains available where the panel fits.

Saving follows the same scope rules as Beer mugs: session-only initially,
or queue just `ui.borderLabels` after explicitly selecting global/trusted
workspace scope. For example, `{"version":2,"ui":{"borderLabels":false}}`
sets an interior-chrome default. Workspace leaves override global leaves;
discarding pending writes or removing an override does not undo the live
choice. Startup does not write settings, and manual file edits require a fresh
process rather than live-Owner `/reload`.

## Agent detail and transcript

`Alt+A` opens the Agent detail pane. A row click opens it, selects a different
Agent, or closes it when clicking the selected Agent. `←`/`→` choose an Agent,
`↑`/`↓` scroll, and `✕` closes it, restoring typed editor text. `Esc` unwinds one
layer at a time: an armed Stop, then a message draft, then the Info page, and
only then closes the pane. The pane keeps focus: unbound printable input does
not dismiss it.
The dim **[S Stop]** is the rightmost action at the footer's bottom-right. **S** or a
click arms confirmation in place (while a message draft is open, **S** is draft
text and the control reads **[Stop]**, click only): the footer shows
`best-effort · Ctrl+S · Esc cancel · [Confirm stop]`, with warning-colored,
bold **[Confirm stop]** rightmost.
Arming changes only the footer row: it does not replace the title, body or
transcript, change the scroll position, or resize the pane, and the footer's
actions menu is not offered while confirmation is armed. Only **Ctrl+S** or a separate single click on **[Confirm stop]**
then requests cooperative cancellation; rapid double/triple clicks do not confirm.
**Esc** cancels confirmation; subsequent presses leave any draft and Info page
before closing details. Ordinary typing, plain `Enter` and repeated **S** never
confirm Stop. Both steps require their controls to be painted. Initial Stop is
offered only when the full inline confirmation hint fits the footer (beside a
minimal selected tab when several Agents exist; the bottom info row keeps the
live status)
and the normal pane height fits a known finite viewport. Full task/name
text need not fit a separate confirmation body; long or CJK text alone does not
suppress Stop. Neither Stop step accepts an unpainted control; a visible Stop
button is always usable.
Confirmation expires after ten seconds of monotonic elapsed time, checked before
rendering or acting even without a repaint. User scrolling (scroll keys or wheel),
stale geometry, Agent selection changes, replacement work, permission hiding and
closing retire it. Background transcript growth alone does not. The intent stays bound to the originally painted
Owner, generation, Agent and Run. The host rechecks that original target before
invoking the Owner: a stale control never stops another Agent or a replacement task. This is not steering, Agent kill,
or Owner shutdown, and it also works for queued tasks and while delegation is Off.
Once stopping starts or execution exits the control disappears. Status and drain
diagnostics, not the command's acceptance notice, confirm progress toward exit.
A display-refresh failure is reported separately from an accepted stop request.
Outside confirmation, `✕` only closes the pane, and `Esc` leaves a draft or the
Info page before it closes the pane.

The first accepted explicit human stop carries `cancellation_source: "human"` in
live state and the recorded outcome. Parent tool projections attempt this bounded
optional metadata; byte pressure may omit it. The host also attempts a visible
`alehouse:human-cancellation:v1` parent message without triggering a new model turn,
asking the model not to repeat the task automatically. Neither queuing a message
nor displaying a notice proves model receipt. An earlier model/budget stop or an
already-exited task is not relabelled as a new human cancellation.
**M** opens message mode for a running task: a two-row composer tray borrows
transcript height while the pane's outer height stays unchanged, and the footer
keeps the Agent tabs and the Stop control. When terminal space permits the tray, its
minimum body space is reserved before composing, even with an empty transcript;
message growth and compaction never switch the input between tray and footer. The tray's input is a full-width single line
(`› …`); printable keys, including **S**, enter text there, and `←`/`→` edit the
caret rather than switching Agents. Tiny panes that cannot fit the tray fall
back to the previous one-line composer in the footer row
(`› … Enter send · Esc cancel`), which then replaces the tabs. While typing, the
tray's heading names only sending and discarding the draft, and a stale target
is not offered Enter send. The footer drops every key the draft would swallow
(the `‹ ›` arrows, `[M message]` and the docked `Esc` hint) and the body controls
drop their key accents. Tabs, **[Stop]**, page/tool labels and the tail cue stay
clickable when painted. While Stop confirmation is armed, Enter only
cancels that intent; it does not send the draft. If compaction leaves no room
for the tray, confirmation temporarily occupies the footer without discarding
the draft. `↑`/`↓`/PageUp/PageDown and the wheel still scroll. **Enter** submits one human message as steering input to
the Run the draft was started for; **Esc** discards the draft, then leaves an
open Info page before closing details. **M** acts only while the selected task
is running with no stop requested and its painted geometry fits a known
viewport. The optional `[M message]` hint may yield under width pressure without
disabling that shortcut; it still requires a visibly painted original Run and
fresh target validation. Queued, stopping and settled tasks have no message
mode, and it never starts a continuation. Starting a draft
binds the last visibly painted Owner, generation, Agent and Run, then checks that
identity against fresh state; a changed or hidden frame requires a repaint before
**M** can act. The host rechecks the original identity before invoking the Owner. If that
Run ends or is replaced, the draft reports `task ended` (or `task no longer
running` in the compact fallback) and Enter sends nothing. Selecting another Agent, `✕` or a row click discards the
draft; a permission dialog that hides or closes the pane does not, and the draft
returns only for the same Run, with the caret at its end after a closed pane is
rebuilt. Explicitly opening another Agent supersedes a pending permission restore
and discards the old draft. Empty messages and messages exceeding 16236 UTF-16
units after normalization and trimming are refused; the fixed human-origin lead
uses the rest of the unchanged 16384-unit input bound. A refused message
(delegation Off, input not ready, input limit or invalid text) keeps its text and
explains why. An accepted one reports inline that the message was admitted to
the child-input path and that delivery is unconfirmed; a child blocked in a tool
reads it only when that tool returns. This transient feedback lasts at most five
seconds and clears on a new draft, refusal, task replacement or exit. It takes
over the Run's single human-steer admission row for that time, after the first
or any later accepted message, rather than adding a second row; the row then
returns to the admission fact. Neither is a delivery state inferred from
the transcript: the pane never relabels a steering message as
queued or delivered based on what later appears there. Undelivered text appears
under the task's discarded inputs.

The child receives the text behind a fixed lead naming the human, not the parent,
as its author. Nothing is published to the parent session and no model turn is
triggered: the Run only carries `human_steered: true` in live state and parent
tool projections, as bounded optional metadata that byte pressure may omit. The
message text is never projected to the parent. Pasted newlines are normalized to
spaces for this single-line editor; terminal protocols are stripped and remaining
control or bidirectional-control characters are escaped before draft storage,
display or sending. Printable Unicode, including combining marks and emoji
joiners, stays intact. This sanitization does not change the child's permission
boundary. Live transcript labels use the exact message object's in-memory
origin: parent dispatches show `From parent`, direct human steering shows
`From user`, and internal budget inputs show `Alehouse input`. The parent label
describes the dispatched envelope, which can include orchestration context and
other Agents' reference material; it does not attribute every byte to the parent.
Unknown-origin messages retain `Input`. An unknown message with the exact human
lead keeps the qualified `Steering input (human lead)` fallback; text recognition
alone is not source-authenticated authorship. Compaction and branching never
infer origin from message position.

The title carries the task and reserves a Run reuse cue: `#N` for a valid task
ordinal, otherwise an abbreviated Run ID. Task and identity share the bounded
cell budgets described below.
Ordinary metadata normalizes tabs/newlines readably, strips recognized terminal
protocols and explicitly escapes remaining control and bidirectional-control
characters; ZWJ, ZWNJ and variation selectors remain intact. This does not
blanket-strip styled SDK transcripts or their hyperlinks. Wrapping respects
grapheme clusters and display width.
The title leads with the bold nickname, its dim `worker|scout/dN` identity tag
and the task; a framed pane's upper right carries only the close control. The
tag is painted only while the nickname keeps a recognizable cell budget: either
the whole name fits, or it retains at least three terminal cells including the
ellipsis (three cells total, not three literal characters before one). A
narrower title drops the tag whole before the name falls below that budget. The
task-bearing title holds that same budget with or without the tag; where the
task and a recognizable name cannot fit together, the title keeps the nickname
and its `#N`/Run cue and drops the task, rather than an ellipsis-fragment name
beside task text. Live
status no longer rides the title: the lifecycle state and its spinner or outcome
glyph moved to the single bottom info row, so a status change or an Agent switch
never shifts the name.

The footer, or the bottom edge of a floating pane, is the pane's navigation and
action bar. Agent tabs sit at its left when more than one Agent exists, each
showing its status glyph and `?`/`!` attention markers. Framed tabs use muted
ASCII `|` separators; docked tabs retain spacing-only separation. Outer frame
rules and the `‹ ›` navigation joins are unchanged. The selected nickname
uses accent, bold and the host theme's optional underline, without a background
fill; structural themes without underline retain accent and bold. Status glyphs
and attention markers keep their own semantic colors, and neither the padding
nor the markers inherits the nickname's underline. With only a glyph fitting,
that glyph carries the selection styling without changing its lifecycle color.
Peers that do not fit fold into
clickable `+N` summaries with their attention counts, and `‹ ›` step to the
previous/next Agent. At its right, `↓ N more` counts rows below the viewport on
the current page, Transcript or Info. It is accented while a live transcript
keeps growing; a click or **End** goes to the current page's end, resuming live
tail following on Transcript. Next come `[M message]` and `[S Stop]`, Stop always
outermost. Docked panes, which have no `✕`, keep an `Esc` hint before the
actions. The footer also carries a `[⋯]` actions control (keyboard `.`) that
opens the pane's actions menu; it is not offered while a draft is composed or a
stop confirmation is armed. The footer does not repeat counters, status, context
or a key legend; the title, the bottom info row and the body carry the current
Agent's information. Framed panes additionally show a scrollbar.
Under width pressure peer tabs fold first, then the arrows, then `↓ N more`
(framed, where the scrollbar also shows position) or `[M message]` (docked, where
the cue is the only position left). The `[⋯]` control is reserved: those
optional peers, message and tail forms yield before it ever does. It is absent
when no Agent is selected or the caller's minimum width, current geometry or
two-option menu viewport cannot fit it, never as an arbitrary optional yield. An armed Stop
folds every peer so the confirmation names a single target.

The actions menu overlays the bottom of the viewport without changing the pane's
height, scroll position or transcript anchor. It offers the page that is not
shown — `Info`, carrying ` +N` when pinned diagnostics overflow, or
`Transcript` while Info is open — and `Expand tools`/`Collapse tools`. The active
item paints accent and bold; `↑`/`↓`/`Tab` move its selection (they never scroll
the body while it is open), `Enter` activates the painted item, and `Esc` closes
the menu before it unwinds any other layer. **I**, **T** and the host's
configured tools key keep working while it is open. Body scroll aliases and the
wheel close it and apply the body-scroll request in the same event, subject to
normal scroll bounds; there is no extra dismiss-only first press. The
conversation behind the pane never scrolls along. The menu closes on
an Agent selection, a resize or geometry change, permission hiding, an armed
Stop, a started draft, a stale target or pane invalidation. A press outside the
menu dismisses it and is claimed: it cannot also click through to **[Confirm
stop]**, a tab or any newly exposed control. `Esc` unwinds one layer at a time:
the menu, then an armed Stop, then a message draft, then the Info page, and only
then the pane.

Fixed observation rows sit below the reading area, pinned directly above the
footer: up to two diagnostic note rows, then a plain separator, then one info
row. Pinned observations never share the transcript's scroll coordinates. The
transcript and Info page stay the only routine activity surfaces; the pane adds
no activity preview row beside them. Normal `agent_busy` is a
reuse-availability observation, not a session fault: it creates no red session
diagnostic, attention row or warning marker. This does not change resumability
or command admission; real session, history, cleanup and other attention facts
remain visible.

At most two highest-priority attention rows are pinned just above the separator
when height permits; when height permits only one, its overflow count still
includes every omitted note. When at least one note row is painted, notes beyond
the shown rows are counted as `· +N · I info` on the last painted note row and
as ` +N` on the footer menu's Info item. The footer's `!N` cue is only the
no-note-row fallback -- when no note row could be painted at all -- so a partial
overflow is never duplicated there. When no note row fits, the selected tab's
own `?`/`!` marker retains an attention cue, or the required `!N` cue leads the
footer; a tab marker is not a numeric overflow count. Clipping a nickname never
suppresses the last warning/question cue. **I**
exposes all diagnostics, including the human-steer admission fact.

The single bottom info row sits directly above the Agent-tab footer and carries
the selected Run's lifecycle status plus its adaptive metrics. The status keeps
its spinner or outcome glyph; while a turn is running, the current-turn elapsed
follows in parentheses as `(18s)`, with no `turn` word, and exited or finishing
execution shows no turn clock. The live clock is uniformly floored to whole
seconds (`1.1s` reads `(1s)`), while its 60-second warning tint still reads the
raw unrounded observation, so flooring never moves the tint boundary. The
figures have a fixed display order -- status, `model/effort`, `↻turns/max`,
context, usage, cost, total -- separate from the order in which they yield.
Under width pressure the model text shortens first, never below a readable
fragment; then the total, the cache percentage, the whole usage group, cost and
routine turns drop. The shortened model then yields; elevated turn pressure
keeps its turns until after that model has gone. The status compacts through its short label and
glyph forms before context ever yields; once context must yield, the most
readable status that fits is restored. A model that survives the yield ladder
reclaims any leftover cells up to its full text; this never reintroduces dropped
fields or consumes the live clock's reserved width. Numeric fields are never
clipped mid-figure; only the model text may be shortened. The figures themselves are
model and creation-time effort as `model/effort`; `↻turns/max` in the widget's
own compact form; context occupancy as `ctx ≈59k/500k` without a percent,
unknown occupancy staying unknown rather than zero; the current Run's cumulative
usage as `↑input (cache%) ↓output` with the footer's compact counts; observed
cost in the widget's rounded-cents form, a partial observation keeping its `≥`
floor; and the Run total as `total 2m48s`. No completeness ratio is invented: an
unknown share is omitted, never rendered as zero.

Height pressure prioritizes the info row: diagnostic rows yield first, then the
separator. At known small supported heights the pane keeps its minimal bottom
status by reducing the body below its usual three rows. A known budget too small
for the title, the info row and the footer (three rows) paints no pane at all.
Non-finite geometry stays observation-only, with no Stop or compose admission.
Command admission keeps the previous five-row budget floor, so reducing the body
adds no authority at tiny sizes; read-only keyboard navigation and Esc still
work. When no body row fits, relative scrolling and wheel events preserve the
held position and tail-following intent; Home/End remain explicit choices.
With no room for a pinned row, hidden diagnostics retain the footer
attention cue. Narrow rows omit whole numeric fields rather than clipping them;
model text may shorten, while context, elevated turn pressure and lifecycle
status outlast routine figures.

A plain dim horizontal separator, inset to the transcript body's width, sits
immediately above the info row. It carries no text, controls or hit targets and
replaces the former labeled section rule and the merged metrics/controls
toolbar; page and tool controls live only in the footer menu (above) and their
keys. The default compact view keeps running and
error tool entries expanded; **T**, or the host's configured tools-expand key,
expands and collapses all settled successful tool cards. A held reading position
tracks the same message block through expansion; collapsing a held tool clamps
within that block rather than jumping into another message. **I** replaces the
transcript viewport with an info page holding the low-frequency fields: identity, profile/name/task, internally
resolved difficulty slot `d1`–`d5`, model, actual effort and its recorded source
(fixed preset, parent identity, or automatic mapping; user override when
present), with historical manual maps keeping the distinct `preset map` label and
effort labelled fixed at creation, not editable on a resident Agent. Wide panes
arrange those low-frequency fields in two columns. When the pane's height
permits, the Info page opens with a page-local `← Transcript` link above its
content, clickable like the menu item; short panes keep **I** and **Esc**
working without allocating that row. The info page also shows
tool facts, phase, full cumulative usage split, one-row active-tool argument
summaries (one per tool, with paths shortened to retain their filename), separate
`thinking` and ordinary-prose `draft` previews for the current assistant message,
a separate `preparing` tool field, and every dispatch note (the parent model sees
only `tree_shared`). Context occupancy is separate from cumulative billed usage
(`≈231k/272k tokens · 84.9%`); unknown occupancy remains unknown. Commands and
all previews are clipped to the actual remaining width before styling and never
wrap into extra rows; full streamed content remains in the native transcript.
Returning from Info restores the held transcript position and follow intent.
Formatting shares rounded-unit carry rules with the footer: compact counts use
whole k above 10k, detailed billed usage retains tenths, 999500 is `1.0M` compact
or `999.5k` detailed, and 999950 never prints `1000k`/`1000.0k`.

The transcript uses Pi's own message components so markdown, syntax highlighting,
thinking, skills, compaction, and branch summaries match the parent. Within the
compaction-aware branch it displays raw messages, including failed attempts
omitted from model context by SDK retry; context edits do not rewrite this
transcript. It scrolls independently of the surrounding pane and follows the
live tail until the reader scrolls away; **End** returns to the tail and resumes
following. Tool cards resolve the child's renderers through the public SDK
registry and resolver chain. Built-in definitions such as `read`, `bash` and
`edit` already carry native renderers; extension overrides keep their resolver
order. Only `renderCall`, `renderResult` and `renderShell` reach the UI, not an
executable tool definition or the child session. Unknown or unavailable
renderers use the bounded generic arguments/output card. Retired/blocked tool
names and malformed communication calls stay literal, even if a resolver would
recognize them.

The lookup is live and does not cache unknown names. Shutdown, disposal and
observation eviction detach it; a separate binding token rebuilds existing
cards without dropping retained history, so a closed child's transcript can
fall back to generic cards instead of querying its disposed registry. Normal
streaming updates do not change that token. A token reader must return
synchronously with the same identity until a real binding change; allocating
one on every read violates that contract. If reading throws, custom display
callbacks are suspended and the call/result use bounded raw cards instead.
Read failure is distinct from a legitimate `undefined` token: a later successful
read starts a new display epoch and replays retained records, even if the
successful value is `undefined`. Old callbacks and invalidation handles remain
retired throughout; this does not recover Owner/session state.
Historical cards are not marked as arguments-complete or execution-started: the native edit renderer must not
read today's worktree to manufacture a preview of an old edit. Its displayed
result comes from the recorded result data. Argument and result data use the
isolated display projections described below.
Final transcript rows retain theme SGR and complete OSC 8 hyperlinks, but strip
other terminal protocols, including OSC 52 clipboard controls and OSC 133
markers. Repeated viewport emission must not manufacture terminal prompt
boundaries or execute control sequences embedded in a recorded native diff.
Outside preserved display protocols, remaining control and bidirectional-control
characters are displayed explicitly. Tabs in custom component rows remain visible
`\x09` spellings, not terminal tab stops. This is row-display filtering, not a
content redactor, a guarantee of visible glyphs or an OS sandbox.
Recorded tool output remains available
in the detail transcript; tool arguments in the compact widget remain restricted
to identifying fields. Preview simplification does not rewrite the native transcript.

Tool-argument projections visibly escape backslashes, C0/C1/DEL and bidi controls
instead of stripping terminal-protocol payloads. LF stays a paragraph break;
other Unicode whitespace, code indentation and graphemes stay literal. Escaping
backslashes distinguishes original escape spellings from encoded controls, and
ambiguous transformed keys become an explicit marker rather than overwriting an
earlier field. Compact argument previews use the same encoding with visible
`\n` for LF before ordinary width clipping. Activity and Info consumers preserve
already-encoded argument details and their whitespace without escaping paths a
second time. Metadata and generated prose previews retain their separate
normalization/omission policy; this is not a shell parser
or an execution-parameter rewrite.

Result content selects only visual text/image fields before copying: `type/text`
or `type/data/mimeType`. Extra block properties, including valid SDK
`textSignature` metadata, are not forwarded and cannot consume the body budget.
Details remain a separate literal display copy. Argument/details structures use
24 levels and 20,000 inspection/value visits; content uses its own 20,000 selected
field inspections. Hidden property checks count, non-JSON repeated aliases get
an explicit marker, and string length is not a character budget. These limits do
not bound one property enumeration, arbitrary Proxy code, total CPU or heap/RSS.

Each card keeps a private pristine snapshot of its projected inputs. Callbacks
and raw fallbacks receive separate mutable copies, including `context.args`, so
callback failure or a retained work-copy reference cannot corrupt the fallback.
A fallback does not reread the original history. Renderer state and the original
`lastComponent` identities still persist across successful callback updates.

Preserving SGR also preserves effects such as conceal. OSC 8 parameters/URIs can
retain Unicode bidi characters; links are not validated destinations. Neither
styling preservation nor final row filtering guarantees visual truthfulness of
arbitrary trusted renderer output or grants permission to follow a link.

Each tool card scopes renderer invalidation to its live binding and its own
presentation lifetime. Binding changes, history rewrites, theme replacement and
pane disposal revoke the old card's supplied invalidation handles, including
before the next paint. Active invalidation also clears the card's transcript
row cache. Callback/component failures and Promise-returning display code
select a stable bounded raw fallback instead of failing neighboring history;
asynchronous rendering is not supported. This protects bridge-supplied entry
points, not arbitrary retained component references or extension-owned timers.

Well-formed `alert_parent` and `ask_parent` calls use an Input-style message
background (`userMessageBg`/`userMessageText`) rather than the ordinary tool-card
shell. Their titles, `Alert to parent` and `Question to parent`, align to the
right above the background block; the recorded body stays left-aligned, keeps
paragraphs,
and wraps as literal text using the same tool-argument encoding described above.
Tabs appear as `\x09`; protocol payloads, indentation, Unicode whitespace and
original escape spellings remain distinguishable. No extra frame or Markdown
interpretation is added.

The recorded result appears below, outside that background: dim for an ordinary
receipt and error-colored for a failure. Receipts retain the native-result-style
`plainText` prose projection: recognized terminal protocols and their payloads
are removed, line endings/Unicode spaces are normalized, and literal escape
spellings can coincide with encoded controls. Receipt text is not a faithful
argument encoding. A failed receipt with zero SDK-measured non-whitespace cells
gets an explicit `Error` line; any nonblank normalized text is retained below it,
including combining-only text. This is a cell-width policy, not detection of
every visually blank glyph or a terminal-pixel visibility guarantee.

Without a recorded result the block instead has a separate dim
`No recorded result` line, cleared by any final result (including empty content)
or the transcript's synthetic failure. This describes only the available record,
not execution, failure, delivery or parent acknowledgement. Neither the message
block nor its receipt means the parent read or received it. Tool expansion does
not hide these communication messages or their record-state line. Only the
current exact names with exactly one own enumerable data-property string
(`message` or `question`), nonblank and at most 8192 UTF-16 units, get this layout.
Accessors, extra own keys (including symbols/non-enumerable keys), malformed
calls and retired names retain literal generic rendering. Classification reads
descriptors, not recorded getters; arbitrary Proxy traps remain trusted in-process
code, not an effect-free or hard-resource-bound operation.
Incoming messages show `From parent`, `From user`, or `Alehouse input` only
when their exact live message object has a bound origin. Otherwise they retain
`Input` or the existing exact human-lead qualified label. Confirmed origins
outrank text: a parent message quoting the human lead is neither relabeled nor
stripped. No attribution is inferred from a user role, matching body text or
position in history; reloaded messages without the live sidecar stay unknown.

On Pi's alternate/fullscreen renderer the pane floats as a centered overlay; on
the regular renderer it docks where the editor is. This is a safety choice, not
a preference: regular overlays are composited into the scrollback backing array
and a later append can bake chrome into terminal history. Unknown renderer mode
docks. Fullscreen mouse reporting enables row clicks; in regular mode `Alt+A`
is the reliable entry. Floating panes use shared rounded popover chrome,
centered sizing computed from the mounted pane's own terminal: 88% of its
width capped at 164 columns, 84% of its height, and at least 40 columns; when
the terminal width is unknown the plain 88% width applies. Wheel handling and
no outside-click dismissal are unchanged. Like every
floating popover, the pane closes from the `✕` at the right end of its top edge
(` ✕ ─╮`, five layout columns, but only the `✕` cell is the 1×1 target); below
9 columns the control is omitted rather than painted unhittable.

## Delegation panel

`Alt+S`, bare `/alehouse-preset`, or a click on the footer's delegation indicator
(`co-worker/NAME`, left of approval and health in the bottom-right group)
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

The **Model preset** list below it is the picker described next. It uses the same fullscreen
floating / regular docked rule, is serialized to one picker per host, and cannot
open beside a detail pane or active approval. A zero-row host widget captures the
renderer independently of Agent activity, so the first open in an empty or Off
session still floats and joins the shared column in fullscreen. `↑`/`↓` and `PgUp`/`PgDn`
navigate; `Enter` applies; `Esc` cancels. Floating, it joins the bottom-right
popover column (below) and takes the pointer too: `✕` cancels, a left click on
a preset applies it as a menu would, and the wheel moves the highlight so a
preset's slots can be read before choosing. It displays the active
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
  footer toggle, `✕` or a permission dialog closes the picker, also without undo.
- `G` / `W` offers the same confirmed global/project snapshot saving on either page.

There is no effort draft or Apply step. Successful changes update the footer;
`preset*` means an applied session override. Each preset remembers its own
overrides in the current session branch. Restoring that session restores them;
a fresh session uses scoped preferences if present, then the catalogue
`defaultPreset` and its effort defaults. This editor never writes the base
`alehouse-presets.json`; explicit persistent-scope changes queue preferences in
`config.json`, otherwise changes remain session-only. A stale picker cannot
overwrite a newer selection. Repeated edits continue the already-presented
catalogue without rereading configuration, and validation failures do not mark
parent history as uncertain.

Narrow layouts retain effort controls and trim model text first. Fullscreen uses
the existing bottom-right popover column; regular mode stays docked and every
action remains keyboard-accessible. Agent details separately display the actual
creation-time route, which may differ from the current picker defaults.

## Settings and preset editor

Open **P Settings** in the Delegation panel or run `/alehouse-settings`. Every
new Pi session starts with save scope **session**. The menu offers **Change save
scope**, **Agent skills: on/off**, **Beer mugs: on/off**, **Border labels: on/off
(all Alehouse panels)**, **Remember current worker settings**, **Save pending now**, **Discard pending writes**, **Remove a saved override**, and
**Show paths and pending changes**. The beer-mug switch changes the live widget;
only a persistent save scope queues its preference. Choosing global or
workspace as the future scope requires a
confirmation; changing scope alone copies and writes nothing. Workspace scope
is available only for a trusted project and targets the current working
directory, not a discovered Git root.

**Agent skills** defaults to **on**. New worker and scout sessions discover skills
through Pi's normal trusted resource configuration and read matching `SKILL.md`
files on demand; the parent need not paste them. Turning it off suppresses the
catalogue for new sessions, not file-read permission. Already-created child
sessions keep their loaded catalogue when reused. Queued Agents without a session
use the choice at first session creation. With `--no-skills` / `-ns`, the menu
shows **Agent skills: off (--no-skills)**: this launch cannot enable child
discovery, and selecting the row explains why without staging a preference.
Like Beer mugs, the toggle is initially
session-only; choose and confirm a persistent scope before toggling to queue
`childSkills`, then save now or on normal exit. Discarding pending writes or
removing an override leaves the live choice unchanged. The routing-only
**Remember current worker settings** snapshot does not include this toggle.

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

Use **N New** or `/alehouse-preset-edit` to create a user model preset; use **C
Edit** on a highlighted preset or `/alehouse-preset-edit NAME` to edit it. The
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
this changes only the user model catalogue: public profiles `worker` (internal
`editor`) and `scout` (internal `researcher`) remain fixed and are not editable. Changing a preset
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

In Alehouse, `/clear` is an alias for `/new`: it starts a new session, not just
an empty screen. The previous session remains available through `/resume`.
After a successful switch it reports `✓ New session started` through the new
session's notification UI. This is the same success text as `/new`, not its
built-in transcript banner; cancellation reports no success. This alias is
included only in Alehouse; ordinary Pi is unchanged.

`/new` (or `/clear`), `/resume`, `/fork`, clone, and import replace the parent runtime only
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

This automatic/confirmed path is distinct from `/alehouse-close`, which remains
the explicit user command to cancel/drain and permanently close the Owner. `/tree`
changes the current session in place rather than creating a fresh Owner, so it
never uses automatic closure: the UI explains the block and requires explicit
`/alehouse-close`. UI paint or a notification is not closure evidence; only the
closed Owner state permits replacement. `/reload` remains unsupported while an
Owner is open.

## Footer and usage popover

The status footer remains an independently bundled sibling extension and works
without the orchestration layer. Its one clipped, never-wrapped row includes main-session
usage plus worker totals delivered through normal Pi `usage`. It groups model
rows by `provider/model` that actually answered. For a Pi virtual parent
selection the model label shows `selection → physical` after a successful
response on the active branch; before that it shows only the selection.
Subscription marks use the provider's OAuth subscription metadata and actual
OAuth state, plus the existing Kimi exception. Native OpenAI ChatGPT login does
not imply Codex quota headers: `x-codex-*` handling remains limited to the Codex
responses API. Quota is kept per provider, so a provider alias for a second
Codex account shows its own; a shorter window such as `5h` shows before `W` only
when that account reports one. Purchased balances render as whole credits,
rounded half-up from the exact reported text (`Cr 124` from `123.5`; `Cr ∞`
for unlimited credits), only when at least one non-expired reported `5h`
or `W` quota is truly exhausted (`used_percent >= 100`, before display rounding).
Positive or unknown quota does not trigger `Cr`; it hides again after reset or
quota recovery. A valid balance or unlimited-credit report is still required.
This is the account's last reported credit balance, not dollars or an estimate
from session spend. The cache keeps the exact reported text; only the footer
rounds it. Balances remain cached while hidden and can appear when a
later current window reports exhaustion. Both HTTP headers and raw
`codex.rate_limits` stream events (including WebSocket primary/secondary windows)
can update local quota and credits. Stream updates use the event's outer
provider/API identity; missing or invalid values are not invented as zero, and
stream updates never publish
to the dashboard. Credit snapshots stay local and require no billing request or
credential reads. The quota-only dashboard POST,
which names no account, stays limited to `openai-codex` and excludes credits.
Alehouse-provided `usage.alehouseModels` permits per-worker model rows; unattributed totals stay in
the `tools` lump. Main compaction/branch summary uses `main · compact/summaries`;
model-attributed child compaction displays `worker compact · model`, avoiding
duplicate-looking rows. The widget and detail pane use `≥` where they render a
partial observed-cost floor. Pi's footer/native totals ignore completeness
metadata and show reported amounts; they must not be read as a completeness
claim or as free usage.

In fullscreen, clicking the usage figures or an otherwise unclaimed part of
the bottom status row toggles a pinned per-model usage breakdown. Clicking the
context control instead toggles the separate Context popover below. Hover does
nothing; typing, pasting, and table clicks do not dismiss the usage panel. Click
its footer entry again or its `✕` to close it. The footer's reserved row is
separate from popover chrome.

A click on a status segment is first offered to the extension that owns it over
`pi-footer:indicator-click` (`{ key, handled }`, shared in `src/shared/overlay-protocol`);
the orchestration layer claims its `alehouse-preset` indicator synchronously. Unclaimed
clicks, and clicks elsewhere on the row, toggle the usage breakdown. The corner
keeps a fixed left-to-right order: usage, delegation, approval, then health
at the right edge (`↑1.2M (95.2%) ↓61k $4.810 · co-worker/my-team · YOLO · ●`).
Usage figures are told apart by their own `↑` / `↓` / `$` and sit a space apart;
`·` separates the controls, which carry no extra click marker. Delegation and
approval show only their values, without the `delegation:` / `approval:` labels. The footer banner
omits preset versions; the picker and Agent details retain their versions. Status keys and
click routing stay unchanged; YOLO retains its red/bold warning styling.

Narrow rows first omit cache detail and shorten the delegation value with an
ellipsis, then omit whole usage/other-status items and, if necessary, the
delegation control.
Quota windows also retain atomic label/value boundaries: a complete `W 12%`
or `5h 80%` is displayed, or that whole window is omitted, never `W 1…`.
Path/model chrome yields before a fitted quota value. Approval and health have
priority. At extreme widths health keeps a single cell; if both still cannot
fit, approval is omitted whole rather than displaying a misleading partial mode. Click spans
follow exactly the fitted ANSI/CJK-aware layout on every paint and resize.
Full values return when space permits. Popover opening order is independent of
this fixed footer order.

## Context popover

Click the footer's context token/bar region to pin Context in the existing
bottom-right column. `/context` opens the same panel for keyboard inspection;
it does not create a second copy. Pointer opening leaves the editor focused,
and only a keyboard-focused panel advertises navigation, Enter or Esc. A
space-constrained `/context` request shows a summary/notice; its one-shot reveal
focus is cancelled by later key presses/repeats or paste, another focus owner,
yield, close or teardown. Kitty key-release events alone do not cancel it.
The close control or another click on the context control closes it; typing,
pasting and outside clicks do not. Context, usage and the Delegation picker can
stay open together, stacked upward in opening order with matching column edges.
Regular mode offers a non-modal summary through `/context` instead of drawing
floating chrome into scrollback.

The panel is wide and short: category tabs share the top edge, totals and a
width-fitted context bar share one row, and source rows page inside a bounded
body. Clicking Context returns to the overview. Nonzero categories appear in
fixed System, Summary, Messages, Tools order; System is first when present.
Other/unattributed rows remain in the overview rather than becoming a permanent
tab. Tabs support clicks, and keyboard inspection supports navigation, paging
and same-height source details. Closing or resizing clears obsolete hit targets.
The shared stack determines the actual width; long paths do not widen the column
without bound. Floating Delegation uses the same direct overlay path rather
than a blocking SDK custom prompt, so it does not hide Context or usage. If the
column has too little room, a later Context or usage member waits off screen
(Context needs six free rows) until closing a lower member or enlarging the
terminal reveals it. Delegation needs seven free rows: opened without them, it
waits off screen the same way and says so in a notice, since nothing is visible
and only Alt+S (or the footer indicator) cancels it until room appears and it
takes the keyboard. Context and usage still yield during blocking prompts;
the Delegation picker closes and cannot reopen until that prompt span ends.
Hidden pinned members measure zero rows but retain order, width preference and
view state. Settlement timers cannot resurrect a held panel, and passive
restoration never takes the keyboard back.

The long bar uses one theme hue with category-specific simulated alpha: System
is strongest, followed by Summary, Messages and Tools. A selected category is
emphasized without changing segment positions or the full-window denominator.
Used cells remain visibly distinct from the neutral `░` free-space cells. The
footer itself keeps the short occupancy overview, with context prioritized over
path/model chrome when the left side is narrow; approval/health priorities on
the right are unchanged.

Footer and panel totals use the same per-paint SDK context observation. Detail
weights use Pi's native token estimator, the observed effective run prompt, and
the compaction/context-edit-aware main-session projection. Assistant prose and
tool calls are split; tool declarations are counted once; summaries keep their
origin even though providers may render them as user messages. Applicable signed
reasoning may use reported output reasoning as a heuristic weight rather than
counting encrypted bytes. Physical selection and observed foreground dispatch
identity are separate: virtual requests use the same turn's assistant metadata,
not historical last-message guesses, `responseModel`, uncorrelated provider hooks
or a second routing call. This observes a request, never predicts the next route.
Without a replay identity, reasoning remains explicitly unknown; after a new
turn, selection/tree change, failure or compaction, stale route facts are not
reused. Sources are safe labels and identifying metadata, not
message bodies, full shell commands, arbitrary arguments, or provider secrets.
No child journals, credentials, tokenizers or extra provider calls are used.

Normal detail token values are approximate proportional allocations: integer
rounding keeps item and category sums equal to that snapshot's SDK total. This
is not a provider-measured content breakdown. Raw estimates remain available to
explain adjustments. Calibration and incomplete attribution are separate visible
states, including in narrow layouts; the full estimate note is inspectable in
the same bounded body. Missing SDK totals use raw-only wording and remain unknown,
not zero. If reasoning replay identity is unknown, known source weights are not
silently inflated: the known SDK total stays explicitly unattributed in the
overview and source allocations remain unknown. This does not hide available
raw estimates: non-proportional tables use an explicit `≈raw` column, with a
separate SDK-allocation column when applicable, never `%used` for raw weights.
Successful raw estimates (including heuristic zero), unknown estimates, and
non-applicable raw values are distinct per source; an unknown reasoning or a
failed estimate is not displayed as raw zero. Other has no source raw estimate
and retains the SDK total only in its SDK column. Narrow layouts may omit that
column, never move its number under `≈raw`. Details keep the same distinction;
non-proportional raw/SDK comparisons are explicitly unscaled available subtotals,
not a completed normalization. There is no permanent Other tab.
No post-compaction count is invented before the SDK has one. Footer and panel
share the same compact number format and `?` unknown marker.

During native manual/automatic compaction, the context control uses a braille
spinner and elapsed time, without a `compact` label. The panel and footer share
the pre-compaction snapshot until a terminal event. A percentage is an estimate
only: the previous summary's output tokens, with an assumed 15% growth, size the
next summary, and an observed output rate for the same requested model,
provider, API and thinking level times it. Native compactions are the preferred
rate source; ordinary successful main-model responses supply the rate only until
that identity has a successful native compaction. The two sources are kept apart
because the same model is slower end to end on ordinary turns: they carry the
whole conversation as context, and per-request waiting dominates their short
outputs. Main response samples reuse the Stats collector's existing timings and
positive reported output usage; no second request timer is started. Within a
source the rate is total output tokens divided by the corresponding total
observed duration, not an average of individual rates, and no correction factor
converts one source into the other. Each compaction freezes its estimate at
start; later observations affect only the next estimate.

These are end-to-end rates, not measured decoding TPS. Main timing includes SDK
preflight and reported reasoning tokens, but not tool execution or user idle
time. The SDK exposes no portable compaction first-token boundary, and waiting
or retry overhead cannot be separated as decoding time. Input size and waiting
can differ between requests, so an observed rate does not make the percentage
exact. Failed, aborted, unfinished, invalid-clock and identity-mismatched main
responses do not train the rate, even if Stats retains their partial accounting.
Requested identity, not a provider's response-model display alias, matches the
compaction model. Failed, cancelled and extension-provided compactions likewise
do not train the rate. Only positive reported output usage and valid bounded
timing are retained; unreported previous summaries may use text-length estimates
for sizing only, never TPS training.

A first compaction (no previous summary), missing throughput history, virtual
routing or an estimate that reaches 95% falls back to spinner plus elapsed time.
Each source retains at most eight observations per key and 64 in total, so
frequent ordinary turns never evict compaction samples. The history lives in
process memory only, across session replacement and extension-factory
recreation, and is separate from Stats' current-session observation window.
Session teardown retires active observations, timers, snapshots and panels
without retaining session references. These UI observations never alter
compaction or request a model call.

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
It is a single `●` whose color is the observed main/managed-worker activity and
attention: dim when idle or before any activity, accent when busy, warning while
an approval waits, error after a failure. It is not a synthesized
performance grade. A worker can keep it busy while the parent is idle. Click it or use `/stats` to
open a separate, centered view with Overview / Models / Tools tabs. Each tab is
a table: Overview sets Main beside Workers for time, current activity and the
last main request, and Models and Tools give one aligned row per entry. The box
is sized to its widest tab rather than a fixed share of the terminal, and its
key hints sit in the bottom edge. Use `Tab` / `Shift+Tab` or `1` / `2` / `3` to
switch views; arrows, paging and the wheel scroll; `Esc` or `✕` closes. The
small usage popover remains unchanged. Stats is not part of the bottom-right
column and does not widen those popovers.

Measurements cover the current parent observation window, including managed
child LLMs and tools, but not historical sessions. Main wall/busy/idle time stays
separate from summed worker busy durations. Models and Tools group rows under
Main and Workers separately; same-provider/model worker rows merge using TTFT sample
counts and timed output/token totals, never averages of rates. Model names carry
their provider where there is room; when two rows in one group share a model ID,
they always do, and optional columns give way first. Resume continues
its worker's counters; release preserves bounded totals without retaining the
child session. Release is permanent, so observed workers are Agent lifetimes,
not Run counts. Red health is limited to provider failures, runs that fail between
turns, or failed worker Runs (including port admission failure); aborts and tool
errors remain counters only. Red clears when a later response succeeds (such as
the SDK's auto-retry of the failed request), when the next main run or that
worker's next Run starts, when a worker's Run succeeds, or on retirement. A parent
run that ends on an answer also clears idle workers' failures, so a worker that
is never resumed cannot hold the indicator red; an aborted parent run clears
nothing, even after a successful tool-use response. Historical error counters
remain visible, and Overview lists the five most recent failures with where
(main or the worker's Agent ID), when, the model and the error text; `!` marks
one still holding red, `·` one already cleared.
Models use the actual response model
when reported. TTFT is first nonempty effective output, which can be thinking or tool arguments;
first-text time is separate. Latencies start at the foreground SDK `turn_start`
and include preflight; they are not transport-only timings. Uncorrelated
provider hooks also fire during cache warming and are deliberately ignored.
TPS uses reported output tokens over this SDK-turn time, not stream-chunk counts
or decoder speed. Cumulative LLM/tool time can overlap
and is not an additive breakdown of session wall time. Tool time is the
execution time Pi measures for each call, so it leaves out the permission gate
and its approval wait; a call Pi never ran, such as a denied one, counts with no
time. Running calls stay out of the totals: Now shows the oldest one's age,
which includes the permission gate. A call cut short at settlement has no known
execution time, so it counts with none and marks its row partial. Missing and partial
measurements are labeled; no timing is invented from older transcripts.
Parent-side approval wait, including forwarded asks, is counted once. Worker
usage forwarded in tool results is never re-counted as another model response.
Compaction, cache warming and queue/initialization breakdowns remain outside
this view. The optional worker hook sends metadata only, not prompts, deltas,
arguments or tool output. Its one piece of text is a failed response's provider
error, the same text the failed Run already reports as `error`, cut to one line of
at most 240 characters without control sequences. Teardown makes old sinks inert
across parent windows.
Health changes notify immediately using lightweight state reads. Streaming
updates the collectors without rebuilding detail snapshots; table aggregation
happens when the view paints, with a one-second numeric refresh.

A raw overlay handle closes exactly Stats, even when a newer overlay is above
it. Stats yields by closing on permission/UI prompts or orchestration custom-panel
settlement; decisions never resurrect it over another dialog. A session switch
clears observations, overlays, observers and timers. Regular mode shows a
non-modal summary instead, avoiding scrollback pollution and prompt-queue holds.
See [limitations](limitations.md#ui-scope) for UI/Stats scope limitations.

## Bottom-right popover column

The usage breakdown, Context inspector, approval selector and floating routing picker share one
bottom-right column above the footer, through `src/shared/popover-stack`. The first
opened rests on the footer and later ones stack directly on top; closing one
drops everything above it into its place. Every open popover uses the widest
member's preferred/minimum width, clamped to the terminal, so both left and
right edges align. Content changes, opening/closing the widest member and
terminal resizes update the entire column without reopening panels. Temporarily
stepping aside preserves both place and width. Each popover is capped to the
rows left above those below it and waits off screen until its smallest usable
layout fits (three rows by default, six for Context, seven for the picker, every choice plus the
yolo warning for the approval popover), so controls and the bottom edge are
never clipped. Pi focuses a capturing overlay only when it is shown on screen,
so a picker or approval popover that appears later takes the keyboard itself --
unless focus has moved since it opened, in which case that dialog keeps it. The footer and orchestration layer are separate bundles, so the column lives in a
process-wide registry keyed by the TUI both draw into. Floating Delegation does
not acquire a `pi-alehouse:pinned-popover-yield` hold or hide sibling panels on
settlement; its raw handle removes only itself, preserving sibling focus.
The UI-only token protocol remains available for explicit display holds and
grants no permission or Owner authority. At SDK-backed custom-panel settlement
boundaries, footer panels briefly step off the overlay stack and return on the
next tick while retaining their members. This is
presentation coordination, not a claim that current Pi closes the wrong overlay. In regular TUI mode the
footer totals remain but the popover does not open; multiplexers commonly require
click rather than hover motion.

The footer, usage width preference and usage panel share grouped spend until
session leaf or lifecycle/UI invalidation changes it. Independent SDK usage
appends advance that leaf too. Animation and repeated width queries do not walk
the transcript again; hosts without a leaf getter keep the per-frame fallback.
Context caches stable snapshot/category layout metrics and formats visible rows
only; resize, source changes and navigation still update the viewport. Same-frame
navigation can accumulate, but Enter and row-click activation wait for a matching
paint; wheel events over the pending panel do not scroll the transcript below.

## Approval-dialog yield

The process-wide `ui-prompt-queue` serializes non-overlay `ui.custom` dialogs.
A docked detail pane would otherwise occupy the queue head and delay a parent or
forwarded child permission dialog until the queue's ten-minute stall handling,
which can surface to a child as denial. The orchestration layer observes synchronous
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
shortcut context. Payload parsing is defensive and observers swallow errors:
they run inside an emit that protects the permission dialog. Timeout/failure
handling closes the actual custom UI before the queue advances; late callbacks
cannot close a later dialog. Pane construction/disposal is idempotent, including
an asynchronously handed-off component and its redraw timer. Restart Pi after
queue changes; `/reload` does not replace the already wrapped serializer and is
unsupported with an open Owner.
