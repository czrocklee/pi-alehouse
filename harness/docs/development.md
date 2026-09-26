# Development

Pi Alehouse is a single root npm package that builds without Nix; optional Nix
packaging lives in `flake.nix` and `nix/`. The harness is internal under
`harness/`; it is not another publishable package, standalone Pi extension manifest,
SDK fork, or second permission authority. The root manifest sets
`pi.extensions: []`: `composition.ts` is CLI-only, never auto-discovered or
installed as an extension by `pi install`. The CLI explicitly launches a host
Pi process with `--no-extensions -e <absolute composition.ts>`, keeping its
runtime and credentials host-provided. Development Pi/AI/TUI SDK packages are
pinned to 0.87.1. There is no npm publication automation or
public release acceptance. See the [root README](../../README.md).

## Layout and responsibilities

```text
composition.ts                            explicit Pi extension composition
bin/pi-alehouse.mjs                       launcher and absent-only init command
scripts/build.mjs                         offline runtime generation
resources/                                worker policy and neutral configuration seeds
runtime/                                 generated matched agents, policy, lib, authority
harness/src/extension.ts                  harness composition
harness/src/routing.ts                    trusted preset parser/resolution
harness/src/core/                        SDK-free Owner/FIFO/retention/accounting
harness/src/runtime/                     SDK adapter, child assembly, lease, lifecycle
harness/src/tools/                       fixed parent/child schemas and replies
harness/src/permissions/                 readiness and Run-bound provenance
harness/src/history/                     SDK journal links, bounded cold reads, audits
harness/src/ui/                          widget, panels, footer coordination
harness/test/{unit,sdk,host,packaging,tui,support}/
extensions/  lib/  permission-system/       internal integrations and authority patches
```

`OwnerController` retains the only Owner lifecycle authority; `AgentSessionPort`
is the core execution seam, `PiAgentSessionAdapter` the concrete Pi adapter,
`FileOwnerLease` the local lock. UI projects Owner state and owns no SDK session.
`harness/src/routing.ts` holds the trusted routing logic, **not** a hidden model
catalogue. The neutral generated `harness-presets.json` starts at `off` with
empty presets; normal routing/UI tests should use controlled test catalogues,
not a developer's personal model inventory. Shared independent helpers in
root `lib/` are bundled for both harness and footer; never make the footer
import harness runtime. Permission/policy code lives outside `harness/`.

The build generates `runtime/agents/{editor,reader,Explore,Plan,general-purpose}.md`,
`runtime/worker-policy.json`, `runtime/policy/`, `runtime/lib/`, and a **private
patched** `runtime/permission-system/vendor/` copy of pinned 32.0.3. Retain
upstream LICENSE, package imports and WASM assets in that copy. The
`runtime/permission-system/index.ts` wrapper is the single authority entry;
all consumers must use that identity. Root dependencies include the parser
runtime and pinned `pi-web-access` 0.31.0; do not resolve an ambient globally
installed web extension. Generated resources and CLI must match the source
revision. `pi-alehouse init` seeds only absent files into Pi's agent directory
(five agent definitions, a version-2 Off routing catalogue and a permission
config), never changes settings/auth or replaces existing policies/catalogues. Old
`harness:*` records, tool/config names and `Symbol.for` keys remain compatibility
protocol, not reasons to rename public schemas.

The patched permission authority's immutable process-local floor protects its
own executable package, generated resources, dependency/host code and selected
agent directory against detectable model-tool writes, independent of user
permission config. It also protects exact credential/web-config/key paths from
reads. For development tasks that edit this repository with Alehouse's model
tools, use a **separately installed CLI**, not the instance launched from this
checkout: a same-checkout runtime write-protects its own source. Keep source
build and installed runtime separate; a changed protected generation requires a
fresh Pi process. This is a permission floor, not an OS sandbox or protection
against opaque programs; see [security](security.md#immutable-resource-floor-in-writable-installations).

## Tool metadata and Off

The shared policy states only task-fit/total-cost preference. No orchestration
paragraph or disabled-mode reminder is injected into the model prompt. Tool
metadata contains API semantics. All eight management tools are registered
once; the active set follows the chosen preset: initial Off exposes none, Off
after accepted work keeps the five inspection/cleanup tools. Admission and
external steering are guarded separately from accepted work, which continues
through Off. Cached tools are still execution-gated. Controlled entry fixtures
should inspect provider-visible declarations; switching Off cannot erase
historical context. Keep user workflow choices out of standing policy.

## Tests and scope

| Directory | Scope |
| --- | --- |
| `harness/test/unit` | helpers, in-process mocks, isolated local lease tests |
| `harness/test/sdk` | real pinned development SDK with controlled IO |
| `harness/test/host` | controlled installed-host SDK runs; **not** default package tests |
| `harness/test/packaging`, `test/runtime` | package/resource/CLI and legacy wrapper contracts |
| `harness/test/tui` | explicitly invoked PTY/terminal interaction |
| `harness/test/support` | synthetic providers and fixtures |

Node package tests should keep per-file process isolation and sequential cases
for fixtures that mutate environment/timers/listeners. `harness/test/host/jev-approval.mjs`
replaces native network entrypoints for a dedicated process lifetime: do not
import it into a shared runner or restore real network functions before exit.
Host/PTY fixtures require explicit collectors and report controlled scope;
no fixture run authorizes real provider calls or human approvals. In local
lease tests, `HARNESS_FLOCK` takes precedence with `P0_FLOCK` compatibility
fallback; on Linux supply an absolute trusted util-linux path, e.g.
`HARNESS_FLOCK=/usr/bin/flock npm test`. The launcher uses
`PI_HARNESS_FLOCK` or checks trusted absolute util-linux candidates
(`/usr/bin/flock`, `/bin/flock`, `/run/current-system/sw/bin/flock`); it does
not use an arbitrary `flock` from PATH. This is not a sandbox/distributed lock.

## Static quality gate

Root `npm run check` runs lint, typecheck, package tests and the portable
policy suite. The latest root run passed 847/847 package tests
(including 26 runtime tests, eight immutable-resource-protection regressions,
two explicit-model rejection tests, two publication-fixture checks and three
panel-export privacy checks) plus
portable policy gates.
`npm run test:policy` is independently invocable; `npm run test:integration`
invokes a separate controlled host collector, not a release or live-model gate.
The final full/readonly, explicit Jev and SDK-history repeats passed in their
controlled scopes. A fixture-only correction observes shutdown dispatch before
disposal after an exhausted abort budget; only settled cases require all handler
completion. Uncertainty and retained-lock assertions remain. See
[validation scope](validation-evidence.md).
Check exact script behavior and test counts before reporting a new result. ESLint's typed TS source rules and JS fixture/shared-helper lint run
with zero warnings and no autofix. The harness TS check retains strict and
`noUncheckedIndexedAccess`/unused binding checks; the shared `.mjs`/`.d.mts`
checker checks actual JS bodies and declarations in separate temporary trees
without executing helpers. The extension type gate checks a bounded existing
diagnostic baseline but rejects other diagnostics or abnormal termination.
This static analysis does not prove accounting arithmetic, permission semantics
or provider behavior. Preserve explicit Promise ownership and fail-closed error
paths. Node 22.19+ (or 24+) is needed by ESLint 10.

## Commands (repository root)

| Purpose | Command | Scope |
| --- | --- | --- |
| Install locked development deps | `npm ci --ignore-scripts` | Includes pinned Pi SDK for development; no install scripts/model calls. |
| Generate matching runtime | `npm run build` | Offline build; not a release. |
| Check portable package + policy | `npm run check` | Lint, type, package tests, policy. |
| Lint / types | `npm run lint`; `npm run typecheck` | Static only. |
| Package lanes | `npm test`; `npm run test:unit`; `npm run test:sdk`; `npm run test:packaging` | Controlled local tests. |
| Portable policy separately | `npm run test:policy` | Synthetic policy/authority checks. |
| Controlled host collector | `npm run test:integration` | `--all` full/readonly controlled suite passed in scope; not a release gate. |
| Focused host fixtures | `harness/test/host/session-integration.mjs`, `run-lifecycle.mjs` | Invoke through the isolated collector with required host/fixture paths; never run bare npm scripts as proof. |
| Init absent resources | `node bin/pi-alehouse.mjs init` | Explicit seven-file seed, no overwrite; inspect conflicts. |

After building/checking, `npm pack` produces a tarball with the generated
private authority, source composition and runtime assets; verify its contents,
including the upstream permission-system LICENSE. A production tarball install
must use `npm install --prefix TEMP/install --omit=dev --legacy-peer-deps
--ignore-scripts PACKAGE.tgz` (with a real temporary path and built tarball).
`--legacy-peer-deps` avoids npm automatically pulling its own Pi runtime for
transitive permission/web peer dependencies; the separate host Pi remains
mandatory. A normal source `npm ci` intentionally includes SDK development pins.
Neither install mode changes public release status from PENDING.

Existing collector script names and P0/P1 identifiers are compatibility
artifacts; do not transplant private evidence outputs. Optional Jev/Luna,
SDK-history and real-model lanes are never implicitly authorized by
`npm run check`. Controlled host fixture passes cannot certify human
interaction or live provider behavior. Do not
claim a command passed if it was not run, was interrupted, or matched zero tests.

## Maintainer rules

- Assert required host Pi capabilities and exercise host integration; never
  treat a private SDK field or local patch as a supported upstream contract.
- Preserve public tool names, profile/config IDs, `harness:*` records,
  permission events and cross-extension symbols without reviewed migration.
- Keep provider IO synthetic and reports outside the checkout. Never include
  credentials, approval packets or private session content in public evidence.
- Do not infer OS isolation, forced cancellation, cost completeness, real-model
  quality or durable recovery from a controlled green run. See
  [limitations](limitations.md) and [validation scope](validation-evidence.md).
