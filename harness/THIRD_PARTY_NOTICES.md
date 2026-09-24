# Third-party sources

This is Pi Alehouse's internal opt-in local-worker harness, not a vendored/forked subagents backend. Dependencies retain their own licenses; the root lockfile pins development inputs, not the user's host runtime. See the root [third-party notices](../THIRD_PARTY_NOTICES.md) for pi-web-access.

- **Pi**, `@earendil-works/pi-coding-agent` / SDK / TUI / AI **0.87.1**:
  https://github.com/earendil-works/pi/tree/v0.87.1
  The controlled-provider fixture follows the stream pattern and message/event
  shapes in `docs/custom-provider.md`; session loading follows `docs/sdk.md` and
  `examples/sdk/06-extensions.ts`. The installed loader, SDK and UI are used
  unchanged. The adapter consumes public prompt/input/queue and event APIs;
  its controller and history adapter are new code, not copied upstream managers.
  The replacement fixture uses the public runtime-factory pattern also shown in
  `packages/coding-agent/test/agent-session-runtime-events.test.ts`.
  Pi's MIT notice is reproduced below. The published `@earendil-works/*`
  packages declare `"license": "MIT"` in `package.json` but ship no `LICENSE`
  file, so unlike the pi-packages entries below this text cannot be taken from
  the installed tree; it is reproduced and verified against the tagged
  repository at `v0.87.1`.
- **pi-permission-system 32.0.3**:
  https://github.com/gotgenes/pi-packages/tree/pi-permission-system-v32.0.3/packages/pi-permission-system
  Consumed via its public `getPermissionsService(sessionId)` export and the
  published child lifecycle event contract. Pi Alehouse generates and distributes
  a **patched private runtime copy** of the authority, not an unmodified
  no-code-bundled dependency. Alehouse's `permission-system/managed-resource-protection.ts`
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
  widget in `src/ui/agent-widget.ts` and `src/ui/format.ts` deliberately reproduces its *display vocabulary*
  so both backends read alike: the glyph set and the Braille spinner frames
  (upstream pi-subagents' `src/ui/glyphs.ts`), the heading/tree/activity-line layout,
  the twelve-line overflow collapse and the finished-agent linger, together with
  its split into a pure renderer and a widget manager (upstream pi-subagents'
  `src/ui/widget-renderer.ts` and `src/ui/agent-widget.ts`). The code is new and projects harness `RunView`s;
  rows, states, capacity, dual timing and the owner-blocked line have no
  upstream counterpart. The detail pane in `src/ui/agent-detail.ts` likewise follows
  two of its recorded decisions rather than its code: the transcript viewer is
  mounted through `ui.custom`'s non-overlay path as a docked pane, for the
  scrollback-contamination reason measured in
  upstream pi-subagents' `docs/decisions/0007-transcript-viewer-is-not-an-overlay.md`, and it keeps that
  viewer's chrome budget (a title row and a footer, content-sized height capped at
  a share of the terminal). The pane's content, layout and transcript projection
  are new: upstream mounts these behind a `/subagents:sessions` picker, while this
  pane is opened from a widget row and carries no upstream counterpart for its
  identity, lifecycle, usage and stalling-condition sections.
  `src/ui/transcript.ts` follows the same approach as upstream pi-subagents'
  `src/ui/transcript-content.ts`, because both mirror Pi's own interactive-mode
  message-to-component mapping and both must solve the same problems it creates:
  one block of components per settled message, rows cached per width, a tool
  result mutating only its own block, the streaming message held apart from
  settled history, and a rebuild when compaction or branching rewrites the
  consumed prefix. The code is new and reads a harness `AgentDetail` rather than a
  subagent record; the OSC 133 stripping and the fields-plus-transcript scroll
  window have no upstream counterpart.
- The static guard and generated worker policy live outside the internal harness,
  in Pi Alehouse's extension/resource integration.

## pi-packages MIT licenses

The widget deliberately reproduces pi-subagents' display vocabulary, so its
notice is reproduced here whether or not that counts as a substantial portion.
Copyright lines are taken verbatim from the installed `LICENSE` files; the two
packages carry different holders.

Source: https://github.com/gotgenes/pi-packages/blob/pi-permission-system-v32.0.3/packages/pi-permission-system/LICENSE

MIT License

Copyright (c) 2026 MasuRii and Christopher D. Lasher

Source: https://github.com/gotgenes/pi-packages/blob/b3b6159399f541fd0623f65818557dd3e707a34f/packages/pi-subagents/LICENSE

MIT License

Copyright (c) 2026 tintinweb

Both carry the same MIT terms:

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

## Pi MIT license

Applies to the pinned `@earendil-works/pi-coding-agent` / SDK / TUI / AI /
telemetry **0.87.1**. Those packages ship no `LICENSE` file, so the text below
was verified against https://github.com/earendil-works/pi/blob/v0.87.1/LICENSE.
The holder, year and license text remain unchanged from the earlier notice.

MIT License

Copyright (c) 2025 Mario Zechner

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
