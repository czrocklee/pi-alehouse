# Getting started

Pi Alehouse is currently a source preview, not an npm-registry release. It uses an existing host Pi installation and its provider setup. It does not copy credentials or change ordinary Pi's extension list.

## Requirements

- Linux and a local filesystem.
- Node 22.19+ or 24+, npm, Bash, Git, ripgrep (`rg`) and util-linux `flock`.
- A compatible installed Pi. The tested SDK baseline is 1.0.0.

The launcher looks for host `pi` on PATH; `PI_ALEHOUSE_PI` can explicitly select its executable. It uses a trusted absolute `flock` path, not an arbitrary PATH match.

## Build and check

From this repository:

```sh
npm ci --ignore-scripts
npm run build
npm run check
```

The build creates matching worker definitions, policy and a private patched permission runtime. Source development includes pinned Pi SDK development dependencies for checks; the production installation below does not install another Pi runtime.

## Install the built package

```sh
npm pack
npm install -g --omit=dev --legacy-peer-deps --ignore-scripts ./pi-alehouse-0.1.0.tgz
pi-alehouse --help
```

Use the tarball filename produced by `npm pack` if the version changes. Inspect the package before installing it. `--legacy-peer-deps` prevents transitive peer requirements from installing a second Pi runtime. Install the **built tarball**, not an unbuilt checkout. `pi install` does not autoload Alehouse: it is an explicit launcher.

To inspect an installation without changing your global npm packages:

```sh
INSTALL_DIR=$(mktemp -d)
npm install --prefix "$INSTALL_DIR/install" --omit=dev --legacy-peer-deps --ignore-scripts ./pi-alehouse-0.1.0.tgz
"$INSTALL_DIR/install/node_modules/.bin/pi-alehouse" --help
```

Do not initialize your real agent directory merely to inspect an artifact.

### Nix and Home Manager

The flake builds the same package and provides a Home Manager module. Host Pi
stays separately installed; see [`nix/README.md`](../../nix/README.md).

```nix
# flake.nix
inputs.pi-alehouse.url = "github:czrocklee/pi-alehouse";

# Home Manager configuration
imports = [ inputs.pi-alehouse.homeManagerModules.default ];
programs.pi-alehouse = {
  enable = true;
  permissions = ./permissions.json;
  presets = ./harness-presets.json;
};
```

## Set up your crew

When you are ready to use Alehouse:

```sh
pi-alehouse init
```

Initialization creates only absent resources: six worker definitions, a routing catalogue and a permission configuration. It preserves existing files and symlinks and does not modify settings or credentials. Conflicting or incompatible existing resources require your explicit attention; they are not silently replaced. An agent directory initialized before the `researcher` profile existed fails launch with `Missing managed profile`; run `pi-alehouse init` again to add only that definition.

The routing catalogue is `${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}/harness-presets.json`. Its version-3 format uses five independent `slots.d1`–`slots.d5` objects, one per difficulty, each with `model` and optional `effort`. Inherited thinking resolves an unsupported enabled parent level automatically; no per-slot `thinking` field is accepted. It starts with `off` and no model presets. Add your own registered provider/model IDs using the [routing configuration guide](routing.md#preset-configuration). The README's images label historical personal captures and controlled UI examples separately; neither is a built-in model recommendation.

A non-reasoning model that supports only `off` fails `inherit` of an enabled parent on purpose. Set that slot's fixed `effort` to `off` if that is what you want. Empty or unknown-only capability metadata is not support for `off` and does not turn enabled thinking off. See [automatic inherited thinking](routing.md#automatic-inherited-thinking).

This is a direct cutover. Older three-slot configurations are not supported or automatically converted.
Existing installations need an explicitly corrected version-3 routing catalogue
and version-2 scoped preferences, when present. Any per-slot `thinking` field
is rejected, including an empty `thinking: {}` written by the intermediate
unpublished editor, not only a hand-authored populated map. Already-written
catalogue and preference configuration files must be corrected explicitly. Amending or squashing the unpublished cutover does not repair
those local files, and `init` will not overwrite them. If a previous session
saved three-slot definitions or effort overrides, flat definitions, or any
per-slot `thinking` field, start a fresh session or fork from before that
invalid selection record. Never rewrite historical journals. Old Run records,
including `preset_mapping` provenance, remain readable.

Start a fresh process:

```sh
pi-alehouse
```

Choose the main model normally. Use **Alt+S** to set the delegation mode (how much the main model hands off to Agents) and select a model preset, then **E** to adjust effort. The main model is unchanged. Existing agents keep the configuration they started with.

- **Alt+A**: inspect agents and their conversations.
- **Alt+S**: delegation mode, model preset and effort.
- **`/stats`**: activity, models and tools.
- **`/harness-close`**: request shutdown; wait for confirmed closure.

See the [panel guide](interface.md) for mouse controls and renderer differences.

## A few important boundaries

- Choosing `off` disables new worker work; it does not cancel accepted work.
- Never `/reload` while an Owner is open. Close it and start a fresh Pi process after updating Alehouse.
- Cancellation is cooperative, not a guaranteed immediate stop. Reader/editor roles are not OS sandboxes.
- Alehouse protects its own installed code from model-tool writes. To work on Alehouse's source using Alehouse, launch a separately installed copy rather than that source checkout.
- Optional Jev review can send action and review context to an external service. Without a configured key it defers to human approval. Read [data handling and security](security.md) before enabling it.
- Dashboard posting and Grok billing access are opt-in; see [footer integrations](interface.md#optional-footer-network-integrations).

[Support & limitations](limitations.md) · [Validation scope](validation-evidence.md) · [Development](development.md)
