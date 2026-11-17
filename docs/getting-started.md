# Start your first Alehouse session

Alehouse is a Linux source preview. It launches your installed Pi with an explicit set of extensions and uses your existing provider setup. It does not install a host Pi or copy credentials. For declarative installation instead, see [Nix and Home Manager](nix.md). If you are upgrading an existing installation, start with [matched resource migration](development.md#matched-resource-migration).

## 1. Build and verify the package

You need Linux, a local filesystem, Node 22 (22.19 or newer) or Node 24+, npm, Bash, Git, ripgrep (`rg`), util-linux `flock`, and a compatible installed `pi`. From the repository root:

```sh
npm ci --ignore-scripts && PI_TEST_EXECUTABLE="$PWD/node_modules/.bin/pi" npm run check
```

`npm run check` builds the matched runtime and runs the portable checks. Only if it succeeds, pack that same build into a temporary directory:

```sh
out=$(mktemp -d)
archive="$out/$(npm pack --ignore-scripts --silent --pack-destination "$out")"
tar -tf "$archive"
```

Inspect the archive: look for the launcher, `src/composition.ts`, `generated/manifest.json`, the generated authority and managed profiles. Do not install or share an archive that contains private notes or local state. This is a local build, not a registry release. See [build and validation](development.md) if system tools are in nonstandard locations.

## 2. Install the launcher

```sh
npm install -g --omit=dev --legacy-peer-deps --ignore-scripts "$archive"
pi-alehouse --help
```

Install the **built tarball**, not an unbuilt checkout. The flags avoid installing the development SDK or a second Pi runtime via peers. For a temporary installation use `npm install --prefix /your/temporary/directory` with the same flags and archive, then invoke its `node_modules/.bin/pi-alehouse`. Help does not initialize your agent directory.

The launcher finds `pi` on `PATH`; `PI_ALEHOUSE_PI` may select an absolute executable instead. For a nonstandard util-linux installation set `PI_ALEHOUSE_FLOCK` to its verified absolute path. Use plain `pi` for ordinary Pi or extension management; `pi install` does not enable Alehouse delegation.

## 3. Initialize and choose a preset

```sh
pi-alehouse init && pi-alehouse
```

`init` creates only missing resources under `${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}`: five managed agent definitions, `alehouse-presets.json`, and `extensions/pi-permission-system/config.json`. It does not overwrite files or symlinks, credentials or Pi settings. If it reports a mismatch, reconcile the existing files explicitly; rerunning `init` will not update them.

The initial catalogue contains only **Off**. Press **Alt+S**, then **N** (**New**). Choose a registered model and effort for each of the five slots; you can reuse one model in all five. Confirm to apply the preset. The parent model stays unchanged. For defaults that carry over to new sessions, [save the selection](routing.md#selecting-and-persisting) or [edit the base catalogue](routing.md#preset-configuration).

## 4. Give the team a task

For a first local task, try: _“Ask a worker to trace how this project loads its configuration. Report the entry points and file paths; do not edit anything.”_ Press **Alt+A** to inspect the Agent, its current task and its conversation. Use `/alehouse-status` to see whether work was admitted. [Panel controls](interface.md) and [the Agent lifecycle](orchestration.md) cover steering, pending questions and release.

Agents share your checkout. A request not to edit is an instruction, not a sandbox. To edit Alehouse itself with a worker, launch a separately installed copy: model tools cannot write their own running installation. Review the [security and data-handling boundaries](security.md) before enabling web research, automated approvals or optional network integrations.

Before exiting, run `/alehouse-close` and wait for confirmed closure. Turning delegation Off or interrupting a wait does not stop a child. Never reload an open Owner to pick up a new build.
