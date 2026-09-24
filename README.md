# Pi Alehouse

Pi Alehouse is an **opt-in, local Pi launcher** (`pi-alehouse`) for a managed worker harness and its permission/UI integrations. It is one Nix-free source package, not a Pi fork, standalone agent runtime, OS sandbox, background service, or automatic extension install. Its root Pi manifest has `pi.extensions: []`: Pi will not discover/load the source composition automatically, including through `pi install`. Only the CLI explicitly launches host Pi with `--no-extensions -e` pointing to its own `composition.ts`. It uses the host Pi SDK (development baseline 0.87.1), existing Pi authentication, and a reviewed, explicit extension list. Do not load its individual extensions as a substitute for the launcher. Ordinary `pi` is not changed. There is no atomic cancellation, safe live-Owner reload, forced stop, or durable Run recovery.

**Status:** initial source extraction passed the root portable gate, controlled full/readonly, Jev and SDK-history lanes, and an installed-tarball host-Pi RPC smoke check. [Release policy](harness/release-policy.json) remains **PENDING**, not an inherited private local-use acceptance. There is no npm publication or claim of general production, human-UI, live-provider/model-quality, complete billing, atomic cancellation, safe reload, or cross-version validation.

## Source build and entrypoint

Requirements: Linux with a local filesystem and a trusted absolute util-linux `flock`, Node 22.19+ or 24+, npm, and a compatible installed host Pi. Node/npm dependencies are installed at the repository root. From a source checkout:

```sh
npm ci --ignore-scripts
npm run build
npm run check
```

`build` generates the matched `runtime/agents/`, `runtime/policy/`, `runtime/lib/`, `runtime/worker-policy.json`, and patched `runtime/permission-system/vendor/` assets before the CLI is usable. Explicitly initialize from the checkout with `node bin/pi-alehouse.mjs init`, then launch with `node bin/pi-alehouse.mjs`. Source development uses normal `npm ci --ignore-scripts` and therefore includes pinned **development-only** Pi SDK packages; those are not a second runtime in the production tarball.

For an isolated install **after** build/check, run `npm pack`, inspect the resulting tarball for matched runtime assets and the patched permission-system's upstream LICENSE, and use:

```sh
INSTALL_DIR=$(mktemp -d)
npm install --prefix "$INSTALL_DIR/install" --omit=dev --legacy-peer-deps --ignore-scripts ./pi-alehouse-<version>.tgz
"$INSTALL_DIR/install/node_modules/.bin/pi-alehouse" --help
```

Replace `<version>` with the tarball filename from `npm pack`. The production install uses `--legacy-peer-deps` so transitive permission/web peer requirements do **not** auto-install another Pi SDK/runtime; host `pi` must already be separately available on PATH (or configured via `PI_ALEHOUSE_PI`). The installed CLI still requires an explicit `pi-alehouse init` to seed absent resources; do not run init against your real agent directory just to inspect a package. A global install, if desired, must likewise use the **built tarball** and `--omit=dev --legacy-peer-deps --ignore-scripts`, never an unbuilt checkout. This is not an npm-registry/published/stable-release claim. **Do not expect `pi install` to autoload this launcher.**

Initialization creates **only missing resources** (five worker definitions, one routing catalogue, and one managed permission config: seven seed files). Do not replace existing `${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}/harness-presets.json` or existing agent definitions, Pi settings, extension list, authentication, or private key files automatically. The neutral version-2 routing default is `off`; no worker model is preselected. Configure exact provider/model IDs that your host Pi knows before choosing a worker preset. If init/launch cannot safely reconcile existing files, stop and resolve it explicitly instead of overwriting. Keep CLI/resource version and generated policy together; start a fresh process for a new revision. The former `harness:*` journal records, tool names, profile IDs, config path and `Symbol.for` keys are compatibility protocol, not current product branding.

When running, select a worker preset with `/harness-preset` or `Alt+S`; `off` hides new worker admission but **does not stop previously accepted work**. `/harness-close` requests an orderly Owner drain; wait for confirmed closure before exiting or changing sessions. `/tree` requires explicit close. Never `/reload` with an open Owner. Confirmation before other session replacements is not an atomic close-and-replace transaction. For detailed use and the eight parent tool contracts, see [harness guide](harness/README.md), [routing](harness/docs/routing.md) and [limitations](harness/docs/limitations.md).

## Worker and permissions

The CLI composes the patched **pi-permission-system 32.0.3** runtime, generated `reader`/`editor` definitions and worker policy, static safety guard, policy-aware grep, optional Jev review, and status footer, health/Stats, title, and UI queue integrations. Parent-only web tools use pinned `pi-web-access` **0.31.0**; workers have no web or nested-delegation tools. An installed-host smoke run emitted its optional *eager web tool activation* warning: upstream host-version detection cannot resolve the aliased SDK path. This does not grant permissions, add child web access, or justify bundling a second Pi SDK; web tools remain under the normal parent permission authority. The Luna module is imported for a shared checkpoint helper but **is not loaded** as an authorizer by default. Optional footer quota-dashboard HTTP POST is disabled unless `AGENT_DASHBOARD_URL` is configured; Grok billing network/auth access is disabled unless `PI_ALEHOUSE_GROK_BILLING=1`; if enabled, it reads `auth.json` from Pi's actual `getAgentDir()` and calls the external billing endpoint (`GROK_CLI_CHAT_PROXY_BASE_URL` optionally selects the proxy base URL). Ordinary quota-header display/accounting remains available without these opt-ins. The permission patch is a distributed private runtime copy, with its upstream license retained in the generated artifact; it is not an unmodified no-code-bundled dependency.

The patched authority also enforces an immutable process-local resource floor: detectable model-tool writes to its own package/runtime/dependencies, host Pi code and selected agent directory are denied even under yolo or session grants; exact auth/web config/Jev-key paths also deny reads. Ancestor-directory mutations deny conservatively. **To edit Alehouse source, use a separately installed CLI:** launching from that same checkout protects it, including against `editor` writes. This is not an OS sandbox, inode/hardlink tracker, opaque-program safeguard, or defense against arbitrary trusted in-process extensions.

`reader` prohibits direct edits/detectable writes; `editor` remains subject to policy. Neither is an OS sandbox. Shared cwd/checkout, shell asks, project overrides, human decisions and OS permissions still matter. Jev's launcher default is `enforce-subagents`; without `PI_JEV_API_KEY_FILE` it defers to a human. Configure only a protected **path to a key file**, not an exported key value. When configured and invoked, review requests send bounded action and relevant review context (potentially sensitive instructions/prompt material) to the external Jev endpoint; evaluate its data handling before enabling. Defer is not an allow and automation is not a safety proof. Read [security](harness/docs/security.md) and [architecture](harness/docs/architecture.md) before trusting a policy result.

## Layout and validation

- `harness/src`, `harness/test`, `harness/docs`: Owner, SDK adapter, tools, UI, contracts and tests.
- `extensions/`, `lib/`, `permission-system/`: internal Pi integrations, shared helpers and permission patches.
- `resources/`: worker policy and neutral config seeds; `runtime/{agents,policy,lib,permission-system}` and `runtime/worker-policy.json`: **generated**, matched build output; `composition.ts`, `bin/pi-alehouse.mjs` and `scripts/build.mjs`: explicit entrypoints.

The inherited harness had an **801-test baseline**. The latest root `npm run check` passed **844/844 package tests** (including 26 runtime tests, eight immutable-resource-protection regressions, two explicit-model rejection tests and two publication-fixture checks) plus portable policy gates; the controlled full/readonly, Jev, and SDK-history repeats passed separately. See [validation scope](harness/docs/validation-evidence.md). A final built tarball installed with `--omit=dev --legacy-peer-deps --ignore-scripts` contained **no Pi SDK/runtime**; a separate installed Pi 0.87.1 handled isolated RPC Owner-create/status/close, including the per-session readiness change, without a model request. This is limited integration evidence, not human UI, live model, billing, or deployment acceptance. See [development](harness/docs/development.md) and [validation scope](harness/docs/validation-evidence.md) for what each lane can show and for current gaps.

Copyright © 2026 Yang Li. MIT [license](LICENSE); [third-party notices](THIRD_PARTY_NOTICES.md), including the detailed [harness notices](harness/THIRD_PARTY_NOTICES.md). Do not publish transcripts, credentials, approval packets or private evidence as test artifacts.
