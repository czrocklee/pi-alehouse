{
  lib,
  buildNpmPackage,
  makeWrapper,
  util-linux,
  gitMinimal,
  # Only the credential file path, never the credential, enters the wrapper/store.
  jevApiKeyFile ? null,
  # Launcher defaults (`--set-default`); the caller's environment still wins.
  environment ? {},
}: let
  root = ../.;
  # Build inputs only: local dependencies/outputs and Nix packaging never enter
  # the npm source, so Nix-only edits do not rebuild the package.
  # Generated runtime and compiler output are anchored to the package root.
  excludedNames = ["node_modules" "coverage" "artifacts" ".cache" ".git" ".pi" ".claude" ".evidence"];
  excludedPaths = ["generated" "dist" "nix" "flake.nix" "flake.lock" "result"];
  src = lib.cleanSourceWith {
    src = root;
    name = "pi-alehouse-source";
    filter = path: _type:
      !(lib.elem (baseNameOf path) excludedNames)
      && !(lib.hasPrefix ".generated-build-" (baseNameOf path))
      && !(lib.elem (lib.removePrefix (toString root + "/") (toString path)) excludedPaths);
  };
in
  buildNpmPackage {
    pname = "alehouse";
    version = (lib.importJSON ../package.json).version;
    inherit src;
    # Update with package-lock.json (nix build reports the expected hash).
    npmDepsHash = "sha256-4agh/xopC8qHt4ap3xu9fCG19njgyjdOONLoin3C5pI=";

    # Parser WASM is already shipped. Never run native tree-sitter install scripts.
    npmFlags = ["--ignore-scripts" "--legacy-peer-deps"];
    # npm refreshes cache metadata while unpacking Pi's bundled SDK dependencies.
    makeCacheWritable = true;
    npmBuildScript = "build";
    nativeBuildInputs = [makeWrapper];

    postInstall = ''
      root="$out/lib/node_modules/pi-alehouse"
      # Pi supplies these imports through its extension loader. Some dependencies
      # list TypeBox/Pi as production dependencies, so npm prune alone is not enough.
      find "$root/node_modules" -depth -type d \( \
        -path '*/node_modules/@earendil-works/pi-ai' -o \
        -path '*/node_modules/@earendil-works/pi-agent-core' -o \
        -path '*/node_modules/@earendil-works/pi-coding-agent' -o \
        -path '*/node_modules/@earendil-works/pi-tui' -o \
        -path '*/node_modules/typebox' \
      \) -exec rm -rf {} +
      if [ -d "$root/node_modules/.bin" ]; then
        find "$root/node_modules/.bin" -xtype l -delete
      fi

      # One installed root keeps generated extension/shared/vendor imports siblings.
      test -f "$root/generated/authority/index.ts"
      test -f "$root/generated/authority/vendor/package.json"
      test -f "$root/generated/extensions/status-footer.ts"
      test -f "$root/generated/worker-policy.json"
      node --input-type=module - "$root" <<'EOF'
      import assert from "node:assert/strict";
      import { readFileSync } from "node:fs";
      import { pathToFileURL } from "node:url";
      const root = process.argv[2];
      const manifest = JSON.parse(readFileSync(root + "/package.json", "utf8"));
      assert.equal(manifest.name, "pi-alehouse");
      assert.deepEqual(manifest.pi.extensions, [], "Alehouse must not autoload into ordinary Pi");
      const { verifyRuntime, webEntry } = await import(pathToFileURL(root + "/bin/runtime-support.mjs"));
      verifyRuntime(root);
      webEntry(root);
      EOF

      wrapProgram "$out/bin/pi-alehouse" \
        --set PI_ALEHOUSE_PERMISSION_ROOT "$root/generated/authority" \
        --set PI_ALEHOUSE_POLICY_ROOT "$root/generated/extensions" \
        --set PI_ALEHOUSE_FLOCK ${util-linux}/bin/flock \
        --set PI_ALEHOUSE_GIT ${gitMinimal}/bin/git \
        --set-default PI_JEV_APPROVAL_MODE enforce-subagents \
        ${lib.concatStringsSep " " (lib.mapAttrsToList (name: value: "--set-default ${lib.escapeShellArg name} ${lib.escapeShellArg value}") environment)} \
        ${
        if jevApiKeyFile == null
        then "--unset PI_JEV_API_KEY_FILE"
        else "--set PI_JEV_API_KEY_FILE ${lib.escapeShellArg jevApiKeyFile}"
      }
      ln -s pi-alehouse "$out/bin/alehouse"
    '';

    meta = {
      description = "Opt-in Pi Alehouse multi-agent composition (host Pi runtime)";
      homepage = "https://github.com/czrocklee/pi-alehouse";
      license = lib.licenses.mit;
      platforms = lib.platforms.linux;
      mainProgram = "alehouse";
    };
  }
