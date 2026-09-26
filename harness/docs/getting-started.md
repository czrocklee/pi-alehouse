# Getting started

Pi Alehouse is currently a source preview, not an npm-registry release. It uses an existing host Pi installation and its provider setup. It does not copy credentials or change ordinary Pi's extension list.

## Requirements

- Linux and a local filesystem.
- Node 22.19+ or 24+, npm, Bash, Git, ripgrep (`rg`) and util-linux `flock`.
- A compatible installed Pi. The tested SDK baseline is 0.87.1.

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

Initialization creates only absent resources: five worker definitions, a routing catalogue and a permission configuration. It preserves existing files and symlinks and does not modify settings or credentials. Conflicting or incompatible existing resources require your explicit attention; they are not silently replaced.

The routing catalogue is `${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}/harness-presets.json`. It starts with `off` and no model presets. Add your own registered provider/model IDs using the [routing configuration guide](routing.md#preset-configuration). The README's images show an existing personal setup, not built-in model recommendations.

Start a fresh process:

```sh
pi-alehouse
```

Choose the main model normally. Use **Alt+S** to select a worker preset, then **E** to adjust effort. The main model is unchanged. Existing agents keep the configuration they started with.

- **Alt+A**: inspect agents and their conversations.
- **Alt+S**: worker routing and effort.
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
