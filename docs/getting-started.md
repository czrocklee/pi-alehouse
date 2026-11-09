# Getting started

Pi Alehouse is currently a source preview, not an npm-registry release. It uses an existing host Pi installation and its provider setup. It does not copy credentials or change ordinary Pi's extension list.

## Requirements

- Linux and a local filesystem.
- Node 22.19+ or 24+, npm, Bash, Git, ripgrep (`rg`) and util-linux `flock`.
- A compatible installed Pi. The development SDK baseline is 1.5.0; see [host SDK scope](limitations.md#host-sdk-and-runtime-scope).

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
stays separately installed; see [`nix/README.md`](../nix/README.md).

```nix
# flake.nix
inputs.alehouse.url = "github:czrocklee/pi-alehouse";

# Home Manager configuration
imports = [ inputs.alehouse.homeManagerModules.default ];
programs.alehouse = {
  enable = true;
  permissions = ./permissions.json;
  presets = ./alehouse-presets.json;
};
```

The Nix package installs the launcher as both `pi-alehouse` and `alehouse`.

## Set up your crew

Upgrading an existing installation? Read the [one-time naming cutover](development.md#one-time-naming-cutover) first: stop earlier processes and reconcile current configuration explicitly; init does not migrate previous names.

When you are ready to use Alehouse:

```sh
pi-alehouse init
```

Initialization creates only absent required resources: five agent definitions (`editor`, `researcher`, `Explore`, `Plan`, `general-purpose`), a routing catalogue and a permission configuration—seven files total. Those filenames are internal IDs; new tasks select public `worker` or `scout`. It preserves existing files and symlinks and does not modify settings or credentials. Conflicting or incompatible existing resources require your explicit attention; they are not silently replaced. Run `pi-alehouse init` again to add missing required files. Existing user `reader.md` files are not automatically deleted or replaced; no legacy runtime profile aliases or capabilities are supported. The public name `researcher` is unsupported, not an alias. Prompt or profile updates are not applied by init and do not migrate a live session: reconcile matched definitions manually, then start a fresh process.

The routing catalogue is `${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}/alehouse-presets.json`. Its version-3 format uses five independent `slots.d1`–`slots.d5` objects, one per difficulty, each with `model` and optional `effort`. Inherited thinking resolves an unsupported enabled parent level automatically; no per-slot `thinking` field is accepted. It starts with `off` and no model presets. Add your own registered provider/model IDs using the [routing configuration guide](routing.md#preset-configuration). The README's images label their provenance—a controlled UI render and a reviewed real capture; neither is a built-in model recommendation.

A non-reasoning model that supports only `off` fails `inherit` of an enabled parent on purpose. Set that slot's fixed `effort` to `off` if that is what you want. Empty or unknown-only capability metadata is not support for `off` and does not turn enabled thinking off. See [automatic inherited thinking](routing.md#automatic-inherited-thinking).

Older configuration versions and three-slot layouts are not supported or
automatically converted. Existing installations need an explicitly corrected
version-3 routing catalogue and version-2 scoped preferences, when present. Any
per-slot `thinking` field is rejected, including an empty `thinking: {}`;
already-written catalogue and preference configuration files must be corrected
explicitly, and `init` will not overwrite them. If a previous session saved
three-slot definitions or effort overrides, flat definitions, or any per-slot
`thinking` field, start a fresh session or fork from before that invalid
selection record. Never rewrite historical journals. The current codec
interprets only current-format routing records; legacy records (old
`light`/`standard`/`strong` slots, `preset_mapping`, or routing without
difficulty/thinking resolution) read as explicitly unavailable, never
silently converted.

Start a fresh process:

```sh
pi-alehouse
```

Choose the main model normally. Use **Alt+S** to set the delegation mode (how much the main model hands off to Agents) and select a model preset, then **E** to adjust effort. The main model is unchanged. Existing agents keep the configuration they started with.

- **Alt+A**: inspect agents and their conversations. The title keeps the task and `#N` task cue (or short Run ID). **S** / dim bottom-right **[S Stop]** arms in place without replacing details. The footer shows `best-effort · Ctrl+S · Esc cancel · [Confirm stop]`; **Ctrl+S** or a separate single click on the bold warning action requests cooperative cancellation. Rapid double/triple clicks, Enter and repeated S do not confirm. Confirmation expires after ten seconds; scrolling cancels it, but background transcript growth alone does not. **Esc** cancels confirmation, then closes details on a later press.
- **Alt+S**: delegation mode, model preset and effort.
- **`/stats`**: activity, models and tools.
- **`/clear`**: start a new session, like `/new`; previous sessions remain available through `/resume`. The same Owner-closure confirmation applies.
- **`/alehouse-close`**: request shutdown; wait for confirmed closure.

See the [panel guide](interface.md) for mouse controls and renderer differences.

## A few important boundaries

- Choosing `off` disables new worker work; it does not cancel accepted work.
- Never `/reload` while an Owner is open. Close it and start a fresh Pi process after updating Alehouse.
- Cancellation is cooperative, not a guaranteed immediate stop. Tasks use worker (internal `editor`) or scout (internal `researcher`). Neither profile is an OS sandbox; agents share the parent's working directory. Worker's lack of web tools is not network isolation. See [security](security.md).
- Alehouse protects its own installed code from model-tool writes. To work on Alehouse's source using Alehouse, launch a separately installed copy rather than that source checkout.
- Optional Jev review can send action and review context to an external service. Without a configured key it defers to human approval. Read [data handling and security](security.md) before enabling it.
- Dashboard posting and Grok billing access are opt-in; see [footer integrations](interface.md#optional-footer-network-integrations).

[Support & limitations](limitations.md) · [Validation scope](validation-evidence.md) · [Development](development.md)
