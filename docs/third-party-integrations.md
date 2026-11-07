# Third-party sources

This is Pi Alehouse's internal opt-in local-worker orchestration layer, not a vendored/forked subagents backend. Dependencies retain their own licenses; the root lockfile pins development inputs, not the user's host runtime. The reproduced MIT texts, holders and attribution live in the root [third-party notices](../THIRD_PARTY_NOTICES.md).

- **Pi**, `@earendil-works/pi-coding-agent` / SDK / TUI / AI **1.5.0**:
  https://github.com/earendil-works/pi/tree/v1.5.0
  The controlled-provider fixture follows the stream pattern and message/event
  shapes in `docs/custom-provider.md`; session loading follows `docs/sdk.md` and
  `examples/sdk/06-extensions.ts`. The installed loader, SDK and UI are used
  unchanged. The adapter consumes public prompt/input/queue and event APIs;
  its controller and history adapter are new code, not copied upstream managers.
  The replacement fixture uses the public runtime-factory pattern also shown in
  `packages/coding-agent/test/agent-session-runtime-events.test.ts`.
  Pi's MIT notice is reproduced in the root notices. The published
  `@earendil-works/*` packages declare `"license": "MIT"` in `package.json`
  but ship no `LICENSE` file, so unlike the pi-packages entries that text
  cannot be taken from the installed tree; it is reproduced and verified
  against the tagged repository at `v1.5.0`.
- **pi-permission-system 32.0.3**:
  https://github.com/gotgenes/pi-packages/tree/pi-permission-system-v32.0.3/packages/pi-permission-system
  Consumed via its public `getPermissionsService(sessionId)` export and the
  published child lifecycle event contract. Pi Alehouse generates and distributes
  a **patched private runtime copy** of the authority, not an unmodified
  no-code-bundled dependency. Alehouse's
  `src/authority/managed-resource-protection.ts`
  is copied into the generated vendor tree; a patch to upstream
  `PermissionManager.buildCheckResult` enforces its immutable, deny-only
  resource/credential floor after composed project, profile, session and yolo
  rules. This protects detectable path effects in writable npm/source installs,
  not an OS sandbox or a change to upstream copyright. Its upstream LICENSE
  must be retained in the generated artifact; see the root notices for
  distribution scope.
- **pi-subagents 21.7.0**, source commit
  `b3b6159399f541fd0623f65818557dd3e707a34f`:
  https://github.com/gotgenes/pi-packages/tree/b3b6159399f541fd0623f65818557dd3e707a34f/packages/pi-subagents
  Reference for create/register/bind/dispose ordering and compatibility event
  names. No manager, runner or tool implementation was copied. The main-screen
  widget in `src/orchestration/ui/agent-widget.ts` and
  `src/orchestration/ui/format.ts` deliberately reproduces its _display vocabulary_
  so both backends read alike: the glyph set and the Braille spinner frames
  (upstream pi-subagents' `src/ui/glyphs.ts`), the heading/tree/activity-line layout,
  the twelve-line overflow collapse and the finished-agent linger, together with
  its split into a pure renderer and a widget manager (upstream pi-subagents'
  `src/ui/widget-renderer.ts` and `src/ui/agent-widget.ts`). The code is new
  and projects orchestration `RunView`s;
  rows, states, capacity, dual timing and the owner-blocked line have no
  upstream counterpart. The detail pane in `src/orchestration/ui/agent-detail.ts` likewise follows
  two of its recorded decisions rather than its code: the transcript viewer is
  mounted through `ui.custom`'s non-overlay path as a docked pane, for the
  scrollback-contamination reason measured in
  upstream pi-subagents' `docs/decisions/0007-transcript-viewer-is-not-an-overlay.md`, and it keeps that
  viewer's chrome budget (a title row and a footer, content-sized height capped at
  a share of the terminal). The pane's content, layout and transcript projection
  are new: upstream mounts these behind a `/subagents:sessions` picker, while this
  pane is opened from a widget row and carries no upstream counterpart for its
  identity, lifecycle, usage and stalling-condition sections.
  `src/orchestration/ui/transcript.ts` follows the same approach as upstream pi-subagents'
  `src/ui/transcript-content.ts`, because both mirror Pi's own interactive-mode
  message-to-component mapping and both must solve the same problems it creates:
  one block of components per settled message, rows cached per width, a tool
  result mutating only its own block, the streaming message held apart from
  settled history, and a rebuild when compaction or branching rewrites the
  consumed prefix. The code is new and reads an orchestration `AgentDetail`
  rather than a subagent record; the OSC 133 stripping and the
  fields-plus-transcript scroll window have no upstream counterpart.
- The static guard and generated worker policy live outside the internal
  orchestration layer, in Pi Alehouse's extension/resource integration.

## Reproduced licenses

The widget deliberately reproduces pi-subagents' display vocabulary, so its
notice is reproduced whether or not that counts as a substantial portion.
Copyright lines are taken verbatim from the installed `LICENSE` files; the two
pi-packages carry different holders. The reproduced MIT texts — pi-web-access,
Pi, pi-permission-system and pi-subagents, with their holders and shared
terms — live in the root
[third-party notices](../THIRD_PARTY_NOTICES.md); this page keeps no separate
license copies.

The pinned Pi 1.5.0 packages ship no top-level `LICENSE` file; their reproduced
and verified MIT text, holder and year live in the root notices referenced
above. `@earendil-works/pi-schema` additionally ships
`LICENSES/typebox-LICENSE` for the TypeBox-derived code it bundles; that file
travels with the package.
