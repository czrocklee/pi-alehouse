# Third-party notices

Pi Alehouse is © 2026 Yang Li and MIT licensed; see [LICENSE](LICENSE). It is
one package: this root notice records every direct integration notice and all
reproduced third-party MIT texts, so copyright retention never depends on the
detailed integration rationale in
[docs/third-party-integrations.md](docs/third-party-integrations.md).
Dependencies remain subject to their own licenses; inspect the lockfile and
redistributed package licenses before distribution.

The patched permission-system runtime includes an Alehouse-authored immutable
resource/credential floor (`src/authority/managed-resource-protection.ts`)
applied after composed permission rules. Retain the upstream `LICENSE` in its
generated vendor artifact; this notice does not replace that file or change
upstream attribution.

## pi-web-access 0.48.0

Parent and isolated researcher integration use pinned `pi-web-access` 0.48.0
(https://github.com/nicobailon/pi-web-access). Its installed `package.json`
declares MIT; the text below is from its installed `LICENSE`. Local workers
(public `worker`, internal `editor`) do not receive web tools.

MIT License

Copyright (c) 2025 Nico Bailon

## Pi 1.6.1 (`@earendil-works/*`)

The lockfile pins eight `@earendil-works` packages at **1.6.1**:
`pi-agent-core`, `pi-ai`, `pi-codemode`, `pi-coding-agent`, `pi-mcp`,
`pi-schema`, `pi-telemetry`, and `pi-tui`. Their installed `package.json`
files declare `"license": "MIT"` but ship no top-level `LICENSE` file. The
text below was reproduced and verified against
https://github.com/earendil-works/pi/blob/v1.6.1/LICENSE.

`pi-schema` additionally ships `THIRD_PARTY_NOTICES/typebox-LICENSE` for its
bundled TypeBox-derived code; retain that file when distributing the package.
Its copyright notice is also reproduced below under the shared MIT terms.
`pi-mcp` ships `THIRD_PARTY_NOTICES/modelcontextprotocol-typescript-sdk.txt`;
retain that file when distributing the package. Its copyright notice is also
reproduced below under the shared MIT terms.

MIT License

Copyright (c) 2025 Mario Zechner

### TypeBox (bundled in pi-schema)

MIT License

Copyright (c) 2017-2026 Haydn Paterson

### Model Context Protocol TypeScript SDK (bundled in pi-mcp)

MIT License

Copyright (c) 2024 Anthropic, PBC

## pi-permission-system 32.0.3

Consumed via its public `getPermissionsService(sessionId)` export; its
copyright line is taken verbatim from the installed `LICENSE`. Source:
https://github.com/gotgenes/pi-packages/blob/pi-permission-system-v32.0.3/packages/pi-permission-system/LICENSE

MIT License

Copyright (c) 2026 MasuRii and Christopher D. Lasher

## pi-subagents 21.7.0

Reference for lifecycle ordering and compatibility event names; no manager,
runner or tool implementation was copied. The main-screen widget deliberately
reproduces pi-subagents' display vocabulary, so its notice is reproduced
whether or not that counts as a substantial portion. Its copyright line is
taken verbatim from the installed `LICENSE`. Source:
https://github.com/gotgenes/pi-packages/blob/b3b6159399f541fd0623f65818557dd3e707a34f/packages/pi-subagents/LICENSE

MIT License

Copyright (c) 2026 tintinweb

## Shared MIT terms

All licenses reproduced above carry the same terms:

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
