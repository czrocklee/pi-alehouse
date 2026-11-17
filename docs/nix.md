# Install with Nix or Home Manager

The repository flake builds a launcher for `x86_64-linux` and `aarch64-linux`. It does not supply host Pi, model credentials or an active model preset. For the non-Nix build, see [getting started](getting-started.md).

## Build the launcher

From the source root, with the flake inputs and dependencies available:

```sh
nix build .#alehouse
./result/bin/pi-alehouse --help
```

`alehouse` is an alias for `pi-alehouse` in this package. Run `./result/bin/pi-alehouse init` to create missing user-owned resources. With Home Manager, install declarative resources first; do not replace store links by hand. Use [routing and presets](routing.md) to choose models.

## Configure Home Manager

Import `homeManagerModules.default` from the flake and enable `programs.alehouse`. The module installs the launcher and five matched agent definitions under `~/.pi/agent`. Set `programs.alehouse.ordinaryPi.enable = false` **before first activation** if only the explicit launcher should load Alehouse extensions.

| Option under `programs.alehouse` | What it controls                                                                                                                                                                                                                 |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `permissions`, `presets`         | Optional source paths for `extensions/pi-permission-system/config.json` and `alehouse-presets.json`. With `null`, the files stay user-owned. Activation restores the declarative permission file if the settings UI replaced it. |
| `jevApiKeyFile`                  | Runtime path of the Jev key. Supply the path, never its contents; do not store the key in Nix.                                                                                                                                   |
| `dashboardUrl`, `grokBilling`    | Opt in to the footer's network integrations. Review [what is sent and where](interface.md#optional-footer-network-integrations) first.                                                                                           |
| `ordinaryPi.enable`              | Defaults to `true`: ordinary `pi` loads the managed permission authority and selected UI/policy extensions, **not delegation**. Disabling this later is not an uninstall.                                                        |

### What survives rollback?

For ordinary Pi, activation links a generation-specific `managed-permissions.json` selector, copies a private bootstrap into `extensions/managed-permissions/index.ts`, and updates `settings.json` to prevent loading a second authority. Changed settings are backed up once to `settings.json.before-managed-permissions-v1`. The bootstrap and settings entry survive disabling the module or rolling back to a generation without the selector.

Without a selector, the bootstrap requires the installed public `@gotgenes/pi-permission-system@32.0.3`. A malformed selector, missing selected closure, wrong fallback version or duplicate authority blocks tools rather than silently switching policy. Confirm `/alehouse-close`, stop the affected Pi processes, and start fresh after changing generations. Don't activate or roll back under an open Owner.

## Verify a generation

From the source checkout, inspect an **already built** generation with a compatible host:

```sh
bash scripts/checks/check-nix-deployment.sh /nix/store/HM_GENERATION /absolute/path/to/pi
```

This checks installed resources, the launcher, host-loaded entries and bootstrap transitions in isolated fixtures; it does not activate the generation or call a model. See [validation scope](validation-evidence.md).

When maintaining `nix/package.nix`, update `npmDepsHash` with the lockfile. New source inputs to a Git-backed flake must be known to Git or Nix will omit them, even when the same checkout builds with npm.
