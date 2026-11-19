# Interface

Use the Agent pane to follow work, the Delegation panel to change routing, and
the footer to check context, usage and activity. In Pi's fullscreen renderer
these panels float and support mouse input. In regular mode, Agents and
Delegation dock in the editor area; use keyboard shortcuts if mouse input
isn't available. Short or narrow terminals can hide actions: enlarge the
terminal if an action or its confirmation doesn't fit.

[Documentation home](README.md) · [Agents, tasks and sessions](orchestration.md)

| To…                                           | Open…                                                                   |
| --------------------------------------------- | ----------------------------------------------------------------------- |
| Inspect an Agent or send it a message         | `Alt+A` or click its row                                                |
| Choose how to delegate or route new Agents    | `Alt+S`, bare `/alehouse-preset`, or the delegation value in the footer |
| Save defaults or change appearance and skills | `/alehouse-settings` or **P Settings** in Delegation                    |
| Change how permission asks are handled        | `/approval` or the approval value in the footer                         |
| Inspect context or performance                | `/context` or `/stats` (also available from the footer)                 |

## Agent widget

The **Subagents** roster shows active work and recent outcomes. Click its
heading in fullscreen to expand or collapse the roster, and use **Prev** /
**Next** if it spans pages. The overview puts Agents with newly accepted tasks
first. When space is tight, the compact view reserves a row for one unanswered
question (`?`) and, if space permits, one row with live activity. It fills any
remaining rows with the most recently accepted tasks. The widget uses at most
a third of the terminal height, up to 16 lines. When an activity line doesn't
fit, its turn clock moves to the Agent's main row. Use `Alt+A` if the row or
heading control you need isn't visible.

Read a row as **who** (nickname and `worker/dN` or `scout/dN`), **with what**
(model and admitted effort, turns used/allowed, observed context, cost and Run
time), then **what** (the current task and any attention notes). In permission
settings and records, `worker` corresponds to `editor` and `scout` to
`researcher`. A pending alert or question is shown, not acknowledged by opening
the pane. A turn-limit note alone doesn't mean work stopped. Use **Info** for
details when a row says `run warning`, `failed` or `draining`.

An activity line can show a running tool, tool preparation, or a short public
thinking or reply preview. `preparing` does not mean a tool ran, and `thinking…`
does not imply the provider exposed reasoning text. The activity clock is time
in the current **turn**, not the displayed tool's runtime. Failed Runs can stay
inspectable for three parent turns after their Agent is released; this does
not keep a resident slot occupied or make the Agent reusable.

### Beer-mug Easter egg

Toggle **Beer mugs** in `/alehouse-settings` to use `🍺` and `🍻` instead of
arrows for the collapsed and expanded heading. It is off by default and changes
only the display. Save it as `ui.beerMugs` using [scoped preferences](routing.md#scoped-user-preferences).

### Border labels

**Border labels** is on by default. Turn it off in `/alehouse-settings` to move
panel titles, tabs, close controls and action hints inside the frame. This
applies to all Alehouse panels, not native Pi or third-party panels. The extra
rows leave less room for content. This is the `ui.borderLabels` preference.

### Panel text selection

With supported fullscreen mouse input, drag inside a panel's reading area to
select its body text, not the borders or controls. In Agents, scroll up to
stop following live output before dragging; movement of the viewport can
cancel the selection. Pi's **copy on select** controls automatic copying on
release. Alehouse adds no copy shortcut to focused panels. Regular or
unsupported hosts keep native selection behavior. Close a floating panel by
pressing and releasing on its `✕`; hover alone does nothing.

## Agent detail and transcript

`Alt+A` opens Agent details. In fullscreen, click a roster row to open/select
it; click the selected row again to close. The title identifies the task with
`#N` or a shortened Run ID. Tabs stay in Agent creation order even as the
widget reorders for new work.

| Control                              | Action                                                                          |
| ------------------------------------ | ------------------------------------------------------------------------------- |
| `←` / `→` or an Agent tab            | Select an Agent.                                                                |
| `↑` / `↓`, `PgUp` / `PgDn`, or wheel | Scroll the current page without moving the parent conversation.                 |
| `End` or the `↓ N more` cue          | Go to the end; on Transcript, follow new output again.                          |
| `I`                                  | Toggle Info without losing your place in the transcript.                        |
| `T` or Pi's tool-expand key          | Expand/collapse settled successful tool cards. Running/error cards remain open. |
| `.` / **. more**                     | Open the page and tool actions. Use `↑` / `↓` or `Tab`, then `Enter`.           |
| `Esc`                                | Back out one layer: actions menu, armed Stop, draft, Info, then the pane.       |

The transcript uses Pi's own views, including recorded tools, retries and
compaction summaries. A tool can fall back to a raw card if its renderer is no
longer available. `From user` identifies direct live steering, `From parent`
the dispatched envelope, and `Alehouse input` internal input; an older `Input`
label need not establish authorship. Messages from the parent sit on the left;
alerts and questions to the parent sit on the right, with their receipts on the
same side outside the card. Cards hug short messages. For longer alerts and
questions, 90% of the pane is a ceiling: if the text fits in the same number
of lines at a narrower width, the card gives that space back. The body text
uses the active theme's `accent` and `customMessageLabel` colors respectively;
the layout still distinguishes direction if those colors match. An alert or
question card shows what was recorded, not that the parent read it. See [UI limits](limitations.md#ui-scope).

Use **Info** for the original route and effort source, full diagnostics,
current tool observations and usage. Context occupancy is not cumulative
billed tokens. Use `/alehouse-status` when checking capacity, what a stopping
or draining task is waiting for, or whether cleanup is still pending. For saved
records, use `/alehouse-history` to list recent linked Runs and
`/alehouse-history RUN_ID` to inspect one. History is read-only, not a way to
resume an Agent. See [history](architecture.md#state-retention-and-history).

### Stop a task

1. On the intended Agent, press `S` or click **stop**. Read the inline
   `best-effort · Ctrl+S · Esc cancel · confirm stop` prompt.
2. Press `Ctrl+S` or make a separate single click on **confirm stop**. `Enter`,
   repeated `S`, and a rapid double/triple click do not confirm. `Esc` cancels.

The confirmation lasts up to ten seconds and applies only to the Run you saw.
Scrolling, switching Agents, resizing, a permission prompt or replacement
work can cancel it; new transcript lines alone do not. If composing a message,
`S` is text; use the clickable **stop** if it is shown. Neither step works on a
hidden control.

Stop requests cooperative cancellation of the task, including a queued task
or one running while delegation is Off. It doesn't release the Agent or close
the Owner. Watch status or drain diagnostics for actual exit: an accepted
request isn't proof of exit and won't undo side effects. A newly accepted
human stop can be attributed to you in model tool results; Alehouse also tries
to notify the parent not to restart the task without asking, without starting
another turn. The notice isn't proof the model received it. `Esc` in the main
conversation cancels the parent's wait, not the Agents. See
[cancellation limits](limitations.md#lifecycle-and-cancellation).

### Send a message to a running task

Press `M` or click **message** while the task is running and not stopping.
Type one line and press `Enter`; `Esc` discards the draft. While composing,
`←` / `→` edit the line, and if Stop is armed, `Enter` only cancels that intent.
A draft belongs to the original Run and cannot be sent to a replacement, a
queued task or a settled task. Close or switch Agents to discard it. A
permission dialog can preserve it for the same Run; it is not saved to disk.

Paste is normalized to one line. Blank text is rejected, and the limit after
normalization and trimming is 16,236 UTF-16 units. If input isn't ready,
delegation is Off, or the task's input limit is reached, the pane keeps the
refused draft and explains why. An accepted message is admitted, **not confirmed
delivered**: a child blocked in a tool cannot read it until the tool returns.
Undelivered text can appear under the task's discarded inputs. The child gets
it as a human message; no new parent turn starts and the parent model receives
at most a steering marker, not the text. This isn't an answer to a pending
question or a continuation; have the parent use
[`agent_answer`](tool-contract.md#run-send-and-explicit-answer) for that.

## Delegation panel

Open with `Alt+S`, bare `/alehouse-preset` or the footer's delegation control.
Use `←` / `→` to change mode and `Shift+←` / `Shift+→` for eagerness. In
fullscreen, click a mode or drag the slider and release to apply; eagerness has
clickable arrows. Mode changes apply without selecting a preset. See
[what the modes do](routing.md#delegation-mode).

In **Model preset**, `↑` / `↓` and paging move the highlight. `Enter` or a click
on a preset applies it; `Esc` cancels the list selection, not applied mode or
effort changes. The picker shows the active preset, version and slot details
in `d5` to `d1` order. On short screens use `Tab` / `Shift+Tab` to see the other
slots. An inherited effort is a current preview; `unavailable` is not a
fallback. A `*` marks applied session effort overrides, not an unsaved draft.
The footer shows mode/preset without the version, for example
`lead·eager/my-crew*`, or `off`.

### Effort editor

Highlight a model preset and press `E` (**Edit effort**). If it isn't active,
confirm switching to it first; declining changes nothing. `↑` / `↓`, digits
`1`–`5` or slot clicks select a slot; `←` / `→` or the displayed arrows change
its policy immediately. `R` (**Reset**) removes that preset's overrides. Use
`Enter` or `Esc` to return, not to apply or undo. An edit that fails validation
leaves the previous values in place. See [how effort resolves](routing.md#effort).

## Settings and preset editor

Open `/alehouse-settings` (or **P Settings**) to set the save scope, manage
staged changes, or toggle **Agent skills**, **Beer mugs**, or **Border labels**.
For what is saved, when it is written, and how to remember just the live worker
settings with `G` / `W`, see [save defaults](routing.md#selecting-and-persisting).

**Agent skills** defaults to on for worker and scout. It controls discovery for
new child sessions, not permission to read a known file. A queued Agent without
a session uses the choice when its session is first created; reuse keeps the
loaded catalogue. Launching with `--no-skills` (`-ns`) forces it off for that
launch and cannot be reversed in the menu. See
[skill discovery and permissions](security.md#skill-discovery-and-permissions).

- **Create or edit a full preset:** use **N** (**New**), **C Edit** on a model
  preset, or `/alehouse-preset-edit [NAME]`. Choose a model and default effort
  for each slot, hardest first, then confirm to apply and select the preset.
  Existing session effort overrides can mask edited defaults; use **Edit
  effort** to clear them.
- **Change one model:** click its slot's model or press the digit matching
  the slot ID (`1` for `d1`, even though it's listed last). The active preset
  applies the new model on selection; an inactive preset asks before applying
  and enabling it. The other slots and effort policies stay unchanged; if a
  fixed effort is unsupported, the edit is refused rather than downgraded.

The TUI uses Pi's model selector with fuzzy search and `Tab` for **all** /
**scoped** models (`--models` or Pi's enabled model list). Virtual models are
excluded. `Esc` cancels an uncommitted draft; a permission prompt can cancel an
open model selector too. Choosing a model doesn't change Pi's main model or
its defaults. Like `/model`, opening a selector may refresh provider listings
and update Pi's auth or model cache. See [the catalogue](routing.md#editing-the-base-catalogue)
for where edited definitions live.

## Approval menu

Click the approval value or run `/approval`. Use `↑` / `↓` and `Enter` in the
popover, or choose a mode in the regular-renderer dialog. You can also use a
command such as `/approval manual`. **manual** leaves asks to you; **jev** can
decide eligible main-session asks, and **jev + sub** includes forwarded asks.
**yolo** auto-allows eligible asks in this session and its registered in-process
children, including potentially destructive Bash/Git actions. It bypasses Jev
review, not explicit denies, static guards or fail-closed restrictions. Manual
isn't an offline mode: see [Jev review and data handling](security.md#jev-review-and-audit).

A wider choice requires a deliberate second selection in the popover or
confirmation in a standard dialog. `●` marks the live choice, not a highlighted
or armed option. To remember that live choice, use `G` / `W` in the menu or
`/approval save [global|workspace]`; confirm the value and destination. This
doesn't activate a choice or change the shared save scope. A same-session
record takes priority over saved defaults; a restored judge choice is capped
at the launch mode, a wider saved default requires consent, and yolo always
requires fresh confirmation. A preference alone grants no permission.

### Approval-dialog yield

A parent or forwarded child permission prompt takes priority. The Agent pane
steps aside and can return after the last prompt, with any draft only for the
original Run; an armed Stop is cancelled. Delegation and an open model picker
close without applying pending selections. Pinned usage and Context step aside
and return; Stats closes. Use the permission prompt itself for the decision.

## Session replacement confirmation

Before exit, use `/alehouse-close` and wait for confirmed closure. This
permanently closes the current Owner; picking a preset cannot reopen it. A
session replacement (`/new`, `/clear`, `/resume`, `/fork`, clone or import)
can close an unused Owner automatically. If it ever accepted work, even if
everything is now released, only an explicit **Yes** starts shutdown. The
confirmation covers work accepted while it is open. Declining or lacking a
confirmation leaves the session in place. If opening the destination later
fails, the old Owner can still be permanently closed; wait for one replacement
to finish before starting another.

`/clear` is an alias for `/new`, not a screen wipe; saved sessions remain
available through `/resume`. `/tree` always requires explicit `/alehouse-close`
first. Never use Pi's `/reload` with an open Owner. Off, an empty roster, and
an accepted stop are not confirmed closure. See [limits](limitations.md#lifecycle-and-cancellation).

## Footer and usage popover

In fullscreen, click the usage figures to pin the per-model **Usage** table;
click again or use `✕` to close. Context, Delegation, Approval and the health
dot have their own actions. In regular mode the totals still show, but the
usage popover doesn't open.

Usage groups responses by answering provider/model and separates summaries
and unattributed tool usage. `↑` / `↓` are input/output tokens; the percentage
next to input is cache share. A virtual main selection may show
`selection → physical` after a response, not as a prediction of its next route.

Agent cost with `≥` is a **partial observed floor**. A missing amount isn't zero,
and the footer totals don't indicate completeness. Settled Agent usage
reaches the parent totals only through a later parent tool result; spend after
the last one can remain in `/alehouse-status` as `unreported_usage`. Closure
may record a snapshot of that residue, not an additional charge. See
[accounting](architecture.md#accounting).

Codex quota is separate from session spend. `5h` or `W` reports remaining quota
for that provider account when available. `Cr` is the last reported purchased
credit balance (whole credits or `∞`), not dollars. It is only shown with a
current, actually exhausted quota window, not one that just rounds to `0%`.
Codex headers and stream events can update local display without a billing call.

## Context popover

Click the footer's context area to pin **Context** without moving focus from
the editor. Run `/context` for keyboard inspection. Use `Tab` / `Shift+Tab` or
`←` / `→` to change category, `↑` / `↓` and paging to navigate, `Enter` for a
source's details, and `N` for the estimate note. `Esc` backs out when focused;
click the footer control again or `✕` to close. Regular mode or a cramped
viewport can show a summary instead.

Context shows main-session occupancy, not lifetime usage or child context.
System, Summary, Messages and Tools values are approximate attributions of Pi's
observed total, not provider measurements. A raw estimate or an unattributed
amount isn't a measured source share; `?` is unknown, not zero. During
compaction the view keeps its previous snapshot until compaction ends. Any
progress percentage is an estimate, not a deadline.

### Bottom-right popover column

In fullscreen, Context, Usage, Approval and Delegation share a column in
opening order. If a later panel won't fit, close a lower one or enlarge the
terminal. A waiting Delegation panel can still be cancelled with `Alt+S`.

## Optional footer network integrations

Local Codex quota display needs neither opt-in. Grok billing is separate:

- `AGENT_DASHBOARD_URL` supplies the dashboard base URL. For `openai-codex`,
  Alehouse can POST quota windows from HTTP response headers or WebSocket
  rate-limit events. Other Codex slots and purchased credits stay local. Unset,
  there is no default dashboard POST.
- `PI_ALEHOUSE_GROK_BILLING=1` enables Grok billing on relevant xAI activity.
  This can read Pi's `auth.json` in the actual agent directory or fall back to
  the Grok CLI's auth file. It sends a bearer token to the billing endpoint.
  Only set `GROK_CLI_CHAT_PROXY_BASE_URL` to a proxy you trust; otherwise the
  built-in Grok proxy is used. With the dashboard also configured, successful
  Grok billing can send billing configuration and subscription-tier data there.

These opt-ins don't change Agent permissions. See
[context, identity and data handling](security.md#context-identity-and-data-handling).

## Health and Stats

The footer's health dot reports activity, pending approval or failure, not a
quality grade. Click it or run `/stats` for **Overview**, **Models** and
**Tools**; use `Tab` / `Shift+Tab` or `1` / `2` / `3` to switch, arrows or paging
to scroll, and `Esc` or `✕` to close. Regular mode shows a summary. The view
covers this observation window, not historical sessions. Overview separates
main and worker activity and shows recent failures; clearing a red indicator
doesn't erase error counters.

First output can be thinking or tool arguments; first text is measured
separately. Model rates are end-to-end, not decoder speed. Model and tool times
can overlap, so don't add them to estimate wall time. Tool execution totals
exclude permission waits; a denied call can count without an execution time.
Missing or partial measurements aren't zero. See [UI limits](limitations.md#ui-scope)
and [offline session analysis](session-analysis.md) for journal-based totals.
